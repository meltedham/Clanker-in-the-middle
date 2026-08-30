import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
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
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
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

  it("persists and updates an Agent token budget", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Budget", tokenBudget: 100 });

    expect(service.getAgent(agent.id).tokenBudget).toBe(100);
    expect((await service.updateAgent(agent.id, { tokenBudget: null })).tokenBudget).toBeNull();
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

  it("force-kills a busy Agent immediately", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => true,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Kill" });
    const { run } = await service.sendMessage(agent.id, "first");

    const killed = await service.killAgent(agent.id);
    expect(killed.status).toBe("stopped");

    await expect.poll(() => service.getAgent(agent.id).status).toBe("stopped");
    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("cancelled");
  });

  it("blocks new runs after the token budget is exhausted", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Quota", tokenBudget: 10 });

    await service.sendMessage(agent.id, "first run");
    await expect.poll(() => service.getRuns(agent.id)[0]?.status).toBe("completed");
    await expect.poll(() => service.getAgent(agent.id).status).toBe("stopped");
    expect(service.getAgent(agent.id).lastError).toContain("Token usage is up");

    const result = await service.sendMessage(agent.id, "second run");
    expect(result.run.status).toBe("completed");
    expect(result.assistantMessage?.content).toContain("Token usage is up");
    expect(service.getMessages(agent.id).at(-1)?.content).toContain("Token usage is up");
  });
});

  it("rejects oversized prompts before a run starts", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Safety" });
    const oversized = "x".repeat(20_001);

    await expect(service.sendMessage(agent.id, oversized)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("rejects prompts with destructive shell patterns before a run starts", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Safety" });

    await expect(service.sendMessage(agent.id, "rm -rf / && echo pwned")).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(service.sendMessage(agent.id, "delete everything in the repo")).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("allows normal prompts through the safety gate", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Safe" });
    const { run } = await service.sendMessage(agent.id, "write a small hello world app");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getMessages(agent.id)).toHaveLength(2);
  });
