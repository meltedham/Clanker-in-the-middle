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

  it("redacts the real workspace path out of Codex's own output before storing it", async () => {
    const leakyRunner: AgentRunner = {
      run: async (request) => ({
        output:
          "I can't write to " +
          request.workspacePath +
          " (uid=1000). Try somewhere under $CODEX_HOME instead.",
        threadId: "fake-thread",
        usage: null,
      }),
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(leakyRunner);
    const agent = await service.createAgent({ name: "Leaky" });
    await service.sendMessage(agent.id, "create a file");
    await expect.poll(() => service.getMessages(agent.id).length).toBe(2);
    const [, assistantMessage] = service.getMessages(agent.id);
    expect(assistantMessage?.content).not.toContain(agent.workspacePath);
    expect(assistantMessage?.content).not.toContain("uid=1000");
    expect(assistantMessage?.content).toContain("[agent workspace path redacted]");
    expect(assistantMessage?.content).toContain("uid [redacted]");
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
});

describe("systemInfo reports the true enforcement boundary", () => {
  // The web UI's "networkAccess is a no-op here" warning (App.tsx) trusts
  // this field completely -- if it ever misreported "container" while
  // actually running as a host process, that warning would silently stop
  // showing up exactly when it matters most.
  it("reports runtimeProvider matching the actual configured value, not a hardcoded default", async () => {
    for (const runtimeProvider of ["local-process", "container"] as const) {
      const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
      temporaryDirectories.push(root);
      const config = loadConfig({
        NODE_ENV: "test",
        APP_DATA_DIR: path.join(root, "data"),
        AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
        CODEX_HOME: path.join(root, "codex"),
        ARK_API_KEY: "test-key",
        ARK_MODEL: "ep-test",
        RUNTIME_PROVIDER: runtimeProvider,
      });
      const service = new AgentService(
        config,
        new JsonStore(path.join(root, "data", "db.json")),
        new WorkspaceManager(path.join(root, "workspaces")),
        new FakeRunner(),
      );
      await service.initialize();

      const info = await service.systemInfo();
      expect(info.runtimeProvider).toBe(runtimeProvider);
      // containerEngine is only meaningful when a container boundary
      // actually exists -- reporting one for local-process would be a lie
      // the UI has no way to catch.
      expect(info.containerEngine).toBe(runtimeProvider === "container" ? config.containerEngine : null);
    }
  });
});

describe("Runtime policy back-compat", () => {
  it("backfills sandboxMode/networkAccess for Agents stored before those fields existed", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
    temporaryDirectories.push(root);
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    // Simulates a database.json written before sandboxMode/networkAccess
    // existed: the stored Agent simply has neither key.
    await writeFile(
      path.join(dataDir, "db.json"),
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            name: "Legacy Agent",
            description: "",
            instructions: "",
            status: "ready",
            ownerId: "unclaimed",
            workspacePath: path.join(root, "workspaces", "11111111-1111-1111-1111-111111111111"),
            codexThreadId: null,
            lastError: null,
            createdAt: "2025-01-01T00:00:00.000Z",
            updatedAt: "2025-01-01T00:00:00.000Z",
          },
        ],
        messages: [],
        runs: [],
        users: [],
        grants: [],
      }),
      "utf8",
    );

    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: dataDir,
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      ARK_API_KEY: "test-key",
      ARK_MODEL: "ep-test",
      CODEX_SANDBOX_MODE: "read-only",
    });
    const service = new AgentService(
      config,
      new JsonStore(path.join(dataDir, "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      new FakeRunner(),
    );
    await service.initialize();

    const agent = service.getAgent("11111111-1111-1111-1111-111111111111");
    // Backfilled to the platform's configured default at the time, not a
    // hardcoded string -- proving it reads real config, not a guess.
    expect(agent.sandboxMode).toBe("read-only");
    expect(agent.networkAccess).toBe(true);
  });
});
