import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RunCancelledError } from "../errors.js";
import type {
  AgentRunner,
  ReconcileOutcome,
  RunnerCallbacks,
  RunnerRequest,
  RunnerResult,
} from "../types.js";
import { ObservabilityRunner } from "./observability-runner.js";
import { TraceWriter } from "./trace-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeTrace(): Promise<TraceWriter> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-observability-test-"));
  temporaryDirectories.push(root);
  return new TraceWriter(root);
}

const baseRequest: RunnerRequest = {
  agentId: "agent-1",
  runId: "run-1",
  workspacePath: "/tmp/workspace",
  prompt: "do something",
  threadId: null,
};

describe("ObservabilityRunner", () => {
  it("is transparent to a successful run: forwards callbacks, returns the result unchanged, and traces the lifecycle", async () => {
    const trace = await makeTrace();
    const observedByCaller: Array<{ threadId?: string; message?: string } | string> = [];
    const inner: AgentRunner = {
      run: async (_request, callbacks?: RunnerCallbacks) => {
        callbacks?.onHandle?.("container:test-handle");
        callbacks?.onProgress?.({ threadId: "thread-1", message: "hello" });
        return { output: "hello", threadId: "thread-1", usage: { outputTokens: 3 } };
      },
      cancel: async () => false,
      isAvailable: async () => true,
      reconcile: async (): Promise<ReconcileOutcome> => ({ stillRunning: false, reason: "n/a" }),
    };
    const runner = new ObservabilityRunner(inner, trace);
    const callerCallbacks: RunnerCallbacks = {
      onHandle: (handle) => observedByCaller.push(handle),
      onProgress: (progress) => observedByCaller.push(progress),
    };

    const result = await runner.run(baseRequest, callerCallbacks);

    expect(result).toEqual({ output: "hello", threadId: "thread-1", usage: { outputTokens: 3 } });
    // AgentService's own store-checkpointing callbacks still fire, unaware the middleware exists.
    expect(observedByCaller).toEqual(["container:test-handle", { threadId: "thread-1", message: "hello" }]);

    const events = await trace.read("run-1");
    expect(events.map((event) => event.type)).toEqual([
      "runner_attached",
      "thread_started",
      "agent_message",
      "completed",
    ]);
    expect(events.at(-1)?.detail).toEqual({ usage: { outputTokens: 3 } });
  });

  it("traces a cancellation and rethrows the original error unchanged", async () => {
    const trace = await makeTrace();
    const cancellation = new RunCancelledError();
    const inner: AgentRunner = {
      run: async () => {
        throw cancellation;
      },
      cancel: async () => false,
      isAvailable: async () => true,
      reconcile: async (): Promise<ReconcileOutcome> => ({ stillRunning: false, reason: "n/a" }),
    };
    const runner = new ObservabilityRunner(inner, trace);

    await expect(runner.run(baseRequest)).rejects.toBe(cancellation);

    const events = await trace.read("run-1");
    expect(events.map((event) => event.type)).toEqual(["cancelled"]);
    expect(events[0]?.summary).toBe("Run cancelled");
  });

  it("traces a real failure as an 'error' event, distinct from cancellation", async () => {
    const trace = await makeTrace();
    const failure = new Error("Codex exited with code 1");
    const inner: AgentRunner = {
      run: async () => {
        throw failure;
      },
      cancel: async () => false,
      isAvailable: async () => true,
      reconcile: async (): Promise<ReconcileOutcome> => ({ stillRunning: false, reason: "n/a" }),
    };
    const runner = new ObservabilityRunner(inner, trace);

    await expect(runner.run(baseRequest)).rejects.toBe(failure);

    const events = await trace.read("run-1");
    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(events[0]?.summary).toBe("Codex exited with code 1");
  });

  it("traces a reconciliation decision and returns the outcome unchanged", async () => {
    const trace = await makeTrace();
    const outcome: ReconcileOutcome = {
      stillRunning: true,
      reason: "Reattached to a running container and captured its completed output",
      result: { output: "resumed", threadId: "thread-9", usage: null },
    };
    const inner: AgentRunner = {
      run: async (): Promise<RunnerResult> => {
        throw new Error("not used in this test");
      },
      cancel: async () => false,
      isAvailable: async () => true,
      reconcile: async (agentId, handle, runId) => {
        expect(agentId).toBe("agent-1");
        expect(handle).toBe("container:test");
        expect(runId).toBe("run-1");
        return outcome;
      },
    };
    const runner = new ObservabilityRunner(inner, trace);

    const result = await runner.reconcile("agent-1", "container:test", "run-1");

    expect(result).toBe(outcome);
    const events = await trace.read("run-1");
    expect(events.map((event) => event.type)).toEqual(["reconciliation"]);
    expect(events[0]?.detail).toEqual({ stillRunning: true, recoveredResult: true });
  });

  it("never lets a trace-store failure break the underlying Run's success or failure", async () => {
    const throwingTrace = { append: async () => { throw new Error("disk full"); } } as unknown as TraceWriter;
    const successfulInner: AgentRunner = {
      run: async () => ({ output: "still works", threadId: null, usage: null }),
      cancel: async () => false,
      isAvailable: async () => true,
      reconcile: async (): Promise<ReconcileOutcome> => ({ stillRunning: false, reason: "n/a" }),
    };
    const runner = new ObservabilityRunner(successfulInner, throwingTrace);
    await expect(runner.run(baseRequest)).resolves.toEqual({
      output: "still works",
      threadId: null,
      usage: null,
    });

    const failingInner: AgentRunner = {
      run: async () => {
        throw new Error("real failure");
      },
      cancel: async () => false,
      isAvailable: async () => true,
      reconcile: async (): Promise<ReconcileOutcome> => ({ stillRunning: false, reason: "n/a" }),
    };
    const failingRunner = new ObservabilityRunner(failingInner, throwingTrace);
    await expect(failingRunner.run(baseRequest)).rejects.toThrow("real failure");
  });

  it("passes cancel() and isAvailable() straight through to the wrapped runner", async () => {
    const trace = await makeTrace();
    const inner: AgentRunner = {
      run: async () => ({ output: "x", threadId: null, usage: null }),
      cancel: async (agentId) => agentId === "agent-1",
      isAvailable: async () => true,
      reconcile: async (): Promise<ReconcileOutcome> => ({ stillRunning: false, reason: "n/a" }),
    };
    const runner = new ObservabilityRunner(inner, trace);
    expect(await runner.cancel("agent-1")).toBe(true);
    expect(await runner.cancel("agent-2")).toBe(false);
    expect(await runner.isAvailable()).toBe(true);
  });
});
