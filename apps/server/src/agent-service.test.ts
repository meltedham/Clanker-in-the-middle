import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  ReconcileOutcome,
  RunnerCallbacks,
  RunnerRequest,
  RunnerResult,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async reconcile(): Promise<ReconcileOutcome> {
    return { stillRunning: false, reason: "not reachable in this fake" };
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_MODEL: "openai/gpt-4o-mini",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
      reconcile: async () => ({ stillRunning: false, reason: "not reachable in this fake" }),
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
      reconcile: async () => ({ stillRunning: false, reason: "not reachable in this fake" }),
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});

describe("Run interruption and recovery", () => {
  it("preserves a checkpointed thread id and partial output when a run is cancelled", async () => {
    const runner: AgentRunner = {
      run: async (_request, callbacks?: RunnerCallbacks) => {
        callbacks?.onHandle?.("container:launchpad-default-checkpoint-test");
        callbacks?.onProgress?.({ threadId: "thread-checkpoint", message: "partial reply" });
        throw new RunCancelledError();
      },
      cancel: async () => false,
      isAvailable: async () => true,
      reconcile: async () => ({ stillRunning: false, reason: "not reachable in this fake" }),
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Interrupted" });
    const { run } = await service.sendMessage(agent.id, "start something long");

    await expect.poll(() => service.getRun(run.id).status).toBe("cancelled");
    const finishedRun = service.getRun(run.id);
    expect(finishedRun.output).toBe("partial reply");
    expect(finishedRun.partial).toBe(true);
    expect(finishedRun.runnerHandle).toBe("container:launchpad-default-checkpoint-test");
    // The thread survives the cancellation so the next message can resume it.
    expect(service.getAgent(agent.id).codexThreadId).toBe("thread-checkpoint");
    expect(service.getAgent(agent.id).status).toBe("ready");
  });

  it("reconciles an interrupted run on restart instead of declaring it dead", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_MODEL: "openai/gpt-4o-mini",
    });
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    await store.initialize();
    await workspaces.initialize();

    const agent: Agent = {
      id: "agent-restart",
      name: "Restarted",
      description: "",
      instructions: "",
      status: "busy",
      workspacePath: workspaces.workspacePath("agent-restart"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    await workspaces.create(agent);
    const run: AgentRun = {
      id: "run-restart",
      agentId: "agent-restart",
      status: "running",
      prompt: "do work that outlives the server",
      output: null,
      error: null,
      usage: null,
      startedAt: "2024-01-01T00:00:00.000Z",
      completedAt: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      partial: false,
      runnerHandle: "container:launchpad-default-agent-restart",
    };
    await store.mutate((database) => {
      database.agents.push(agent);
      database.runs.push(run);
    });

    const runner: AgentRunner = {
      run: async () => {
        throw new Error("initialize() must reconcile the existing run, not start a new one");
      },
      cancel: async () => false,
      isAvailable: async () => true,
      reconcile: async (agentId, handle, runId): Promise<ReconcileOutcome> => {
        expect(agentId).toBe("agent-restart");
        expect(handle).toBe("container:launchpad-default-agent-restart");
        expect(runId).toBe("run-restart");
        return {
          stillRunning: true,
          reason: "Reattached to a running container and captured its completed output",
          result: { output: "resumed after restart", threadId: "thread-resumed", usage: null },
        };
      },
    };

    const service = new AgentService(config, store, workspaces, runner);
    await service.initialize();

    expect(service.getRun("run-restart").status).toBe("completed");
    expect(service.getRun("run-restart").output).toBe("resumed after restart");
    expect(service.getAgent("agent-restart").codexThreadId).toBe("thread-resumed");
    expect(service.getAgent("agent-restart").status).toBe("ready");
  });

  it("keeps a checkpointed partial result when reconciliation cannot find the run alive", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_MODEL: "openai/gpt-4o-mini",
    });
    const store = new JsonStore(path.join(root, "data", "db.json"));
    const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
    await store.initialize();
    await workspaces.initialize();

    const agent: Agent = {
      id: "agent-gone",
      name: "Gone",
      description: "",
      instructions: "",
      status: "busy",
      workspacePath: workspaces.workspacePath("agent-gone"),
      codexThreadId: "thread-before-crash",
      lastError: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    await workspaces.create(agent);
    const run: AgentRun = {
      id: "run-gone",
      agentId: "agent-gone",
      status: "running",
      prompt: "do work that does not survive",
      output: "checkpointed partial text",
      error: null,
      usage: null,
      startedAt: "2024-01-01T00:00:00.000Z",
      completedAt: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      partial: true,
      runnerHandle: "pid:12345",
    };
    await store.mutate((database) => {
      database.agents.push(agent);
      database.runs.push(run);
    });

    const runner: AgentRunner = {
      run: async () => {
        throw new Error("initialize() must reconcile the existing run, not start a new one");
      },
      cancel: async () => false,
      isAvailable: async () => true,
      reconcile: async (_agentId, _handle, runId): Promise<ReconcileOutcome> => {
        expect(runId).toBe("run-gone");
        return {
          stillRunning: false,
          reason: "Local-process Runs cannot be reattached after a server restart",
        };
      },
    };

    const service = new AgentService(config, store, workspaces, runner);
    await service.initialize();

    const finishedRun = service.getRun("run-gone");
    expect(finishedRun.status).toBe("cancelled");
    expect(finishedRun.error).toBe("Local-process Runs cannot be reattached after a server restart");
    // The checkpointed partial output/thread id from before the crash must survive.
    expect(finishedRun.output).toBe("checkpointed partial text");
    expect(finishedRun.partial).toBe(true);
    expect(service.getAgent("agent-gone").codexThreadId).toBe("thread-before-crash");
  });
});
