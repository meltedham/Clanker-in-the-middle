import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { CodexRunner, buildCodexArgs, createProgressReporter, parseCodexEventLine } from "./codex-runner.js";
import type { ParsedEvents } from "./codex-runner.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        runId: "run-1",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        runId: "run-1",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });
});

describe("createProgressReporter", () => {
  const emptyParsed = (): ParsedEvents => ({
    messages: [],
    threadId: null,
    usage: null,
    errors: [],
  });

  it("reports the thread id only once and each new message once", () => {
    const parsed = emptyParsed();
    const calls: Array<{ threadId?: string; message?: string }> = [];
    const report = createProgressReporter(parsed, { onProgress: (progress) => calls.push(progress) });

    report(); // nothing yet
    parsed.threadId = "thread-1";
    report();
    report(); // unchanged thread id, no new message -> should not re-report
    parsed.messages.push("first chunk");
    report();
    parsed.messages.push("second chunk");
    report();

    expect(calls).toEqual([
      { threadId: "thread-1" },
      { message: "first chunk" },
      { message: "second chunk" },
    ]);
  });

  it("does nothing when no onProgress callback is supplied", () => {
    const parsed = emptyParsed();
    const report = createProgressReporter(parsed, undefined);
    parsed.threadId = "thread-1";
    expect(() => report()).not.toThrow();
  });
});

describe("CodexRunner reconciliation", () => {
  it("always reports host-process runs as unreachable after a restart", async () => {
    const runner = new CodexRunner(loadConfig({ NODE_ENV: "test" }));
    const outcome = await runner.reconcile("agent-1", "pid:12345", "run-1");
    expect(outcome.stillRunning).toBe(false);
    expect(outcome.result).toBeUndefined();
    expect(outcome.reason).toMatch(/cannot be reattached/i);
  });
});
