import { mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig, writeCodexConfig } from "./config.js";
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

/** A runner whose behavior per call is driven by a script keyed on the request and a per-agent call counter (1-indexed). */
class ScriptedRunner implements AgentRunner {
  readonly callCountByAgent = new Map<string, number>();

  constructor(
    private readonly script: (
      request: RunnerRequest,
      callNumberForAgent: number,
    ) => RunnerResult | Promise<RunnerResult>,
  ) {}

  async run(request: RunnerRequest): Promise<RunnerResult> {
    const callNumber = (this.callCountByAgent.get(request.agentId) ?? 0) + 1;
    this.callCountByAgent.set(request.agentId, callNumber);
    return this.script(request, callNumber);
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

function delegateBlock(agent: string, task: string): string {
  return "```delegate\nagent: " + agent + "\ntask: " + task + "\n```";
}

class FakeRunner implements AgentRunner {
  public readonly prompts: string[] = [];

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.prompts.push(request.prompt);
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
      // maxRetries/retryDelay absorb the occasional Windows ENOTEMPTY/EBUSY
      // that happens when a fire-and-forget checkpoint write (e.g.
      // AGENTS.md refresh mid delegation-loop) is still settling on disk
      // right as the directory is removed -- this is a Windows filesystem
      // timing quirk in the test's own cleanup, not product behavior.
      rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
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
  it("supports OpenRouter configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-openrouter-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      OPENROUTER_API_KEY: "or-key",
      OPENROUTER_MODEL: "openai/gpt-4.1-mini",
      OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
    });

    expect(config.openRouterApiKey).toBe("or-key");
    expect(config.openRouterModel).toBe("openai/gpt-4.1-mini");
    expect(config.openRouterBaseUrl).toBe("https://openrouter.ai/api/v1");

    await writeCodexConfig(config);
    const toml = await readFile(path.join(config.codexHome, "config.toml"), "utf8");
    expect(toml).toContain('model_provider = "openrouter"');
    expect(toml).toContain('base_url = "https://openrouter.ai/api/v1"');
    expect(toml).toContain('env_key = "OPENROUTER_API_KEY"');
  });

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

  it("resumes only budget-paused Agents when the new budget allows another run", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Budget resume", tokenBudget: 10 });

    await service.sendMessage(agent.id, "first run");
    await expect.poll(() => service.getAgent(agent.id).status).toBe("stopped");
    expect(service.getAgent(agent.id).stopReason).toBe("budget_exhausted");

    expect((await service.updateAgent(agent.id, { tokenBudget: 15 })).status).toBe("stopped");
    const resumed = await service.updateAgent(agent.id, { tokenBudget: 100 });
    expect(resumed.status).toBe("ready");
    expect(resumed.stopReason).toBeNull();
  });

  it("does not undo manual or kill-switch stops when the budget changes", async () => {
    const service = await makeService();
    const manual = await service.createAgent({ name: "Manual", tokenBudget: 10 });
    const killed = await service.createAgent({ name: "Killed", tokenBudget: 10 });

    await service.stopAgent(manual.id);
    await service.killAgent(killed.id);

    expect((await service.updateAgent(manual.id, { tokenBudget: null })).status).toBe("stopped");
    expect(service.getAgent(manual.id).stopReason).toBe("manual");
    expect((await service.updateAgent(killed.id, { tokenBudget: null })).status).toBe("stopped");
    expect(service.getAgent(killed.id).stopReason).toBe("kill_switch");
  });

  it("does not count cached input tokens twice", async () => {
    const service = await makeService({
      run: async () => ({
        output: "done",
        threadId: "thread",
        usage: { inputTokens: 12, cachedInputTokens: 10, outputTokens: 5 },
      }),
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Cached", tokenBudget: 20 });

    const { run } = await service.sendMessage(agent.id, "first");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getAgent(agent.id).status).toBe("ready");
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

  it("only lets one of two concurrent sends actually run -- the other gets a graceful 'please wait' reply", async () => {
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
    // Both calls are made synchronously, so "first" always enters the
    // store's serialized mutation queue before "second" does -- ties are
    // not possible here.
    const [first, second] = await Promise.all([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(first.assistantMessage).toBeUndefined();
    expect(["queued", "running"]).toContain(first.run.status);
    expect(second.assistantMessage?.content).toContain("still working");
    expect(second.run.status).toBe("completed");
    // The short-circuited "second" exchange is still real, persisted
    // history -- not silently dropped.
    expect(service.getMessages(agent.id).map((message) => message.content)).toContain(
      second.assistantMessage?.content,
    );

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
  });

  it("runs two different Agents concurrently -- the second's runner call is never blocked behind the first's", async () => {
    let resolveA!: (result: RunnerResult) => void;
    let resolveB!: (result: RunnerResult) => void;
    const pendingA = new Promise<RunnerResult>((resolve) => {
      resolveA = resolve;
    });
    const pendingB = new Promise<RunnerResult>((resolve) => {
      resolveB = resolve;
    });
    let agentAId = "";
    let calledA = false;
    let calledB = false;
    const runner: AgentRunner = {
      run: (request) => {
        if (request.agentId === agentAId) {
          calledA = true;
          return pendingA;
        }
        calledB = true;
        return pendingB;
      },
      cancel: async () => false,
      isAvailable: async () => true,
      reconcile: async () => ({ stillRunning: false, reason: "not reachable in this fake" }),
    };
    const service = await makeService(runner);
    const agentA = await service.createAgent({ name: "Alpha" });
    const agentB = await service.createAgent({ name: "Beta" });
    agentAId = agentA.id;

    const [sendA, sendB] = await Promise.all([
      service.sendMessage(agentA.id, "work A"),
      service.sendMessage(agentB.id, "work B"),
    ]);

    // Both runner calls must actually be in flight at once -- if execution
    // were secretly serialized across Agents (e.g. a global lock instead
    // of the per-Agent one this design uses), calledB would still be
    // false here since Agent A's own pending promise hasn't resolved yet.
    await expect.poll(() => calledA && calledB).toBe(true);
    expect(service.getAgent(agentA.id).status).toBe("busy");
    expect(service.getAgent(agentB.id).status).toBe("busy");

    resolveA({ output: "done A", threadId: "tA", usage: null });
    resolveB({ output: "done B", threadId: "tB", usage: null });

    await expect.poll(() => service.getRun(sendA.run.id).status).toBe("completed");
    await expect.poll(() => service.getRun(sendB.run.id).status).toBe("completed");
    expect(service.getRun(sendA.run.id).output).toBe("done A");
    expect(service.getRun(sendB.run.id).output).toBe("done B");
  });

  it("does not let start reset a busy Agent, and replies gracefully instead of double-running a second message", async () => {
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
    const second = await service.sendMessage(agent.id, "second");
    expect(second.assistantMessage?.content).toContain("still working");
    expect(second.run.status).toBe("completed");

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
      ownerId: "unclaimed",
      sandboxMode: "workspace-write",
      networkAccess: true,
      workspacePath: workspaces.workspacePath("agent-restart"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    await workspaces.create(agent, [agent]);
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
      parentRunId: null,
      actorId: null,
      awaitingChildRunId: null,
      orchestrationIterationCount: 0,
      retrieval: null,
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
      ownerId: "unclaimed",
      sandboxMode: "workspace-write",
      networkAccess: true,
      workspacePath: workspaces.workspacePath("agent-gone"),
      codexThreadId: "thread-before-crash",
      lastError: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    await workspaces.create(agent, [agent]);
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
      parentRunId: null,
      actorId: null,
      awaitingChildRunId: null,
      orchestrationIterationCount: 0,
      retrieval: null,
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

describe("Multi-agent delegation", () => {
  it("delegates to another Agent and resumes on the same thread with its result", async () => {
    let orchestratorId = "";
    let researcherId = "";
    const runner = new ScriptedRunner((request, callNumber) => {
      if (request.agentId === orchestratorId && callNumber === 1) {
        return {
          output: "I'll ask Researcher.\n\n" + delegateBlock("Researcher", "find X"),
          threadId: "orchestrator-thread-1",
          usage: null,
        };
      }
      if (request.agentId === researcherId) {
        expect(request.prompt).toBe("find X");
        return { output: "X is 42.", threadId: "researcher-thread-1", usage: null };
      }
      // orchestrator's second call: must resume the thread ITS first call
      // produced, not the (null) pre-run thread, and must see the
      // delegated result as its next prompt.
      expect(request.threadId).toBe("orchestrator-thread-1");
      expect(request.prompt).toContain("X is 42.");
      return { output: "The answer is 42.", threadId: "orchestrator-thread-1", usage: null };
    });

    const service = await makeService(runner);
    const orchestrator = await service.createAgent({ name: "Orchestrator" });
    const researcher = await service.createAgent({ name: "Researcher" });
    orchestratorId = orchestrator.id;
    researcherId = researcher.id;

    const { run } = await service.sendMessage(orchestrator.id, "kick off orchestration");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const finalRun = service.getRun(run.id);
    expect(finalRun.output).toBe("The answer is 42.");
    expect(finalRun.awaitingChildRunId).toBeNull();

    const researcherRuns = service.getRuns(researcher.id);
    expect(researcherRuns).toHaveLength(1);
    expect(researcherRuns[0]?.parentRunId).toBe(run.id);
    expect(researcherRuns[0]?.status).toBe("completed");

    const researcherMessages = service.getMessages(researcher.id);
    expect(researcherMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(researcherMessages[0]?.content).toBe("find X");
  });

  it("does not let a delegation reach an Agent the triggering user has no access to", async () => {
    // Regression for a real cross-branch bug: delegation was built before
    // per-user ownership/Grants existed, and kept calling listAgents() with
    // no actor after access control was merged in -- which listAgents's own
    // contract treats as "see everything, like an admin". That let any
    // user's Agent delegate to literally any other user's Agent by name.
    const runner = new ScriptedRunner((_request, callNumber) => {
      if (callNumber === 1) {
        return {
          output: "I'll ask Target.\n\n" + delegateBlock("Target", "steal secrets"),
          threadId: "orchestrator-thread-1",
          usage: null,
        };
      }
      return { output: "gave up", threadId: "orchestrator-thread-1", usage: null };
    });
    const service = await makeService(runner);

    // The very first user ever becomes admin automatically (bootstrap), so
    // create a throwaway one first -- Alice and Bob must both be ordinary
    // members with no special access to each other's Agents.
    await service.createUser("Bootstrap-Admin");
    const { user: alice } = await service.createUser("Alice");
    const { user: bob } = await service.createUser("Bob");

    const orchestrator = await service.createAgent({ name: "Orchestrator" }, alice.id);
    const target = await service.createAgent({ name: "Target" }, bob.id);
    // No Grant from Bob to Alice (or to Alice's Agent) exists anywhere.

    const { run } = await service.sendMessage(orchestrator.id, "kick off orchestration", alice);
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    // Target never actually ran -- the delegation was rejected before a
    // child Run was ever created, exactly like delegating to a nonexistent
    // Agent name.
    expect(service.getRuns(target.id)).toHaveLength(0);
    expect(service.getRun(run.id).output).toBe("gave up");
  });

  it("reminds a resumed thread of the current roster, since Codex does not reliably re-read AGENTS.md on resume", async () => {
    // Live-observed bug: a Codex thread resumed via `codex exec resume`
    // can keep answering from whatever roster it saw on its first turn,
    // even though AGENTS.md on disk is already current -- a freshly
    // created Agent was invisible to an in-flight thread. Only the
    // conversation itself is reliably fresh, so the reminder must be in
    // the prompt text, not just the file.
    const seenPrompts: string[] = [];
    const runner = new ScriptedRunner((request, callNumber) => {
      seenPrompts.push(request.prompt);
      return { output: "turn " + callNumber, threadId: "steady-thread", usage: null };
    });
    const service = await makeService(runner);
    const solo = await service.createAgent({ name: "Solo" });

    const first = await service.sendMessage(solo.id, "first message, brand-new thread");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    // No other Agent exists yet, and codexThreadId was null going in --
    // neither condition for the reminder is met.
    expect(seenPrompts[0]).toBe("first message, brand-new thread");

    await service.createAgent({ name: "Helper" });
    const second = await service.sendMessage(solo.id, "second message, resumed thread");
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");
    const secondPrompt = seenPrompts[1] ?? "";
    expect(secondPrompt).toContain("Current Agent roster");
    expect(secondPrompt).toContain("Helper");
    expect(secondPrompt).toContain("second message, resumed thread");
  });

  it("rejects self-delegation and lets the orchestrator recover on the same thread", async () => {
    const runner = new ScriptedRunner((_request, callNumber) => {
      if (callNumber === 1) {
        return { output: delegateBlock("Solo", "help me"), threadId: "t1", usage: null };
      }
      return { output: "Fine, I'll do it myself.", threadId: "t1", usage: null };
    });
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Solo" });
    const { run } = await service.sendMessage(agent.id, "start");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getRun(run.id).output).toBe("Fine, I'll do it myself.");
    expect(service.getRuns(agent.id)).toHaveLength(1); // no child run created
  });

  it("feeds the live roster back into the retry prompt when the named target doesn't exist -- not reliant on the model re-reading AGENTS.md", async () => {
    // A resumed Codex thread can keep answering from whatever roster it saw
    // on its first turn, even once AGENTS.md on disk is already current
    // (observed live: a freshly created Agent was invisible to an
    // in-flight thread). The retry prompt itself must carry the real
    // roster, since a file the model may not revisit isn't enough.
    const runner = new ScriptedRunner((_request, callNumber) => {
      if (callNumber === 1) {
        return { output: delegateBlock("Ghost", "help me"), threadId: "t1", usage: null };
      }
      expect(_request.prompt).toContain("Sidekick: a real helper");
      return { output: "Found it, delegating for real now.", threadId: "t1", usage: null };
    });
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Orchestrator" });
    await service.createAgent({ name: "Sidekick", description: "a real helper" });
    const { run } = await service.sendMessage(agent.id, "start");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getRun(run.id).output).toBe("Found it, delegating for real now.");
  });

  it("rejects delegating to a busy Agent without hard-failing the orchestration", async () => {
    let finishTarget!: (result: RunnerResult) => void;
    const targetPending = new Promise<RunnerResult>((resolve) => {
      finishTarget = resolve;
    });
    let targetId = "";
    let orchestratorId = "";
    const runner = new ScriptedRunner((request, callNumber) => {
      if (request.agentId === targetId) return targetPending;
      if (request.agentId === orchestratorId && callNumber === 1) {
        return { output: delegateBlock("Target", "x"), threadId: "t", usage: null };
      }
      expect(request.prompt).toMatch(/currently busy/i);
      return { output: "ok, moving on", threadId: "t", usage: null };
    });
    const service = await makeService(runner);
    const target = await service.createAgent({ name: "Target" });
    const orchestrator = await service.createAgent({ name: "Orchestrator" });
    targetId = target.id;
    orchestratorId = orchestrator.id;

    await service.sendMessage(target.id, "busy work"); // never resolves until finishTarget() below
    const { run } = await service.sendMessage(orchestrator.id, "start");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getRun(run.id).output).toBe("ok, moving on");

    finishTarget({ output: "done", threadId: "t", usage: null });
  });

  it("rejects a delegation cycle back to an active ancestor", async () => {
    let orchestratorId = "";
    const runner = new ScriptedRunner((request, callNumber) => {
      if (request.agentId === orchestratorId) {
        if (callNumber === 1) {
          return { output: delegateBlock("Helper", "please help"), threadId: "t1", usage: null };
        }
        // Second call: after Helper gives up trying to delegate back.
        expect(request.prompt).toMatch(/gave up on the cycle/i);
        return { output: "orchestrator recovered", threadId: "t1", usage: null };
      }
      // Helper: first tries to delegate straight back to the still-active
      // (still "busy") Orchestrator; that gets rejected, then it recovers.
      if (callNumber === 1) {
        return { output: delegateBlock("Orchestrator", "circular"), threadId: "h1", usage: null };
      }
      // Orchestrator is still "busy" (awaiting Helper), so the busy-check
      // rejects this before the ancestor/cycle-walk check is even reached --
      // both mechanisms would catch it, this exercises the one that fires
      // first in this synchronous, single-active-run-per-agent design.
      expect(request.prompt).toMatch(/orchestrator.*currently busy/is);
      return { output: "gave up on the cycle", threadId: "h1", usage: null };
    });
    const service = await makeService(runner);
    const orchestrator = await service.createAgent({ name: "Orchestrator" });
    await service.createAgent({ name: "Helper" });
    orchestratorId = orchestrator.id;

    const { run } = await service.sendMessage(orchestrator.id, "start");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getRun(run.id).output).toBe("orchestrator recovered");
  });

  it("enforces a tree-wide iteration cap across nested orchestrators", async () => {
    let orchestratorId = "";
    let helperId = "";
    // Both agents always try to delegate to each other -- without a cap this
    // would loop forever (or until the cycle guard on the SAME ancestor
    // stops it); use two agents that keep handing off to fresh targets is
    // hard to model simply, so instead assert the run terminates
    // deterministically rather than hanging, driven by the shared cap.
    const runner = new ScriptedRunner((request) => {
      if (request.agentId === orchestratorId) {
        return { output: delegateBlock("Helper", "again"), threadId: "t", usage: null };
      }
      return { output: delegateBlock("Orchestrator", "again"), threadId: "h", usage: null };
    });
    const service = await makeService(runner);
    const orchestrator = await service.createAgent({ name: "Orchestrator" });
    const helper = await service.createAgent({ name: "Helper" });
    orchestratorId = orchestrator.id;
    helperId = helper.id;

    const { run } = await service.sendMessage(orchestrator.id, "start");
    await expect
      .poll(() => service.getRun(run.id).status, { timeout: 5000 })
      .not.toBe("running");
    // Terminates one way or another (cap or cycle guard) instead of hanging;
    // the combined call count across both agents must stay bounded.
    const totalCalls =
      (runner.callCountByAgent.get(orchestrator.id) ?? 0) +
      (runner.callCountByAgent.get(helper.id) ?? 0);
    expect(totalCalls).toBeLessThan(30);
  });

  it("never crashes on a malformed delegate block -- treats it as the final answer", async () => {
    const service = await makeService(
      new ScriptedRunner(() => ({
        output: "```delegate\nagent: Nobody\n```", // missing task field
        threadId: "t",
        usage: null,
      })),
    );
    const agent = await service.createAgent({ name: "Solo" });
    const { run } = await service.sendMessage(agent.id, "start");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getRun(run.id).output).toContain("```delegate");
  });

  it("stopping the orchestrator mid-delegation also stops the in-flight child", async () => {
    // A real runner's cancel() kills the underlying process, which is what
    // makes its own pending run() promise settle (reject) -- mimic that
    // here instead of a no-op cancel(), or `cancelExecution`'s own `await
    // execution` on the child would hang forever waiting for a run() call
    // that nothing ever resolves.
    let rejectChild: ((error: unknown) => void) | null = null;
    let targetId = "";
    let orchestratorId = "";
    const runner: AgentRunner = {
      run: async (request) => {
        if (request.agentId === orchestratorId) {
          return { output: delegateBlock("Target", "slow work"), threadId: "t", usage: null };
        }
        return new Promise<RunnerResult>((_resolve, reject) => {
          rejectChild = reject;
        });
      },
      cancel: async (agentId) => {
        if (agentId === targetId && rejectChild) {
          rejectChild(new RunCancelledError());
          return true;
        }
        return false;
      },
      isAvailable: async () => true,
      reconcile: async () => ({ stillRunning: false, reason: "n/a" }),
    };
    const service = await makeService(runner);
    const target = await service.createAgent({ name: "Target" });
    const orchestrator = await service.createAgent({ name: "Orchestrator" });
    targetId = target.id;
    orchestratorId = orchestrator.id;

    const { run } = await service.sendMessage(orchestrator.id, "start");
    await expect.poll(() => service.getRuns(target.id).length).toBeGreaterThan(0);
    await expect.poll(() => service.getRun(service.getRuns(target.id)[0]!.id).status).toBe("running");

    await service.stopAgent(orchestrator.id);

    expect(service.getRun(run.id).status).not.toBe("running");
    expect(service.getRuns(target.id)[0]?.status).not.toBe("running");
  });
});

describe("Orchestrator-driven Agent creation", () => {
  it("creates the requested Agents, makes them delegatable next turn, and reports the result back", async () => {
    let orchestratorId = "";
    // The Researcher agent doesn't exist (has no id) until mid-run, so the
    // script distinguishes its calls by "not the orchestrator" rather than
    // a not-yet-known id.
    const runner = new ScriptedRunner((request, callNumber) => {
      if (request.agentId === orchestratorId) {
        if (callNumber === 1) {
          return {
            output:
              '```create-agents\n[{"name": "Researcher", "description": "Finds things"}]\n```',
            threadId: "t1",
            usage: null,
          };
        }
        if (callNumber === 2) {
          // Roster must already include the newly created Agent on the
          // very next turn, and the creation summary is fed back as the prompt.
          expect(request.prompt).toMatch(/Created: Researcher/);
          return { output: delegateBlock("Researcher", "find X"), threadId: "t1", usage: null };
        }
        expect(request.prompt).toContain("X is 42.");
        return { output: "The answer is 42.", threadId: "t1", usage: null };
      }
      return { output: "X is 42.", threadId: "r1", usage: null };
    });

    const service = await makeService(runner);
    const orchestrator = await service.createAgent({ name: "Orchestrator" });
    orchestratorId = orchestrator.id;

    const { run } = await service.sendMessage(orchestrator.id, "spin up a researcher and use it");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getRun(run.id).output).toBe("The answer is 42.");

    const researcher = service.listAgents().find((agent) => agent.name === "Researcher");
    expect(researcher).toBeDefined();
    expect(service.getRuns(researcher!.id)).toHaveLength(1);
  });

  it("skips a name that already exists instead of creating a confusing duplicate", async () => {
    const runner = new ScriptedRunner((_request, callNumber) => {
      if (callNumber === 1) {
        return {
          output: '```create-agents\n[{"name": "Existing"}]\n```',
          threadId: "t",
          usage: null,
        };
      }
      expect(_request.prompt).toMatch(/Skipped: Existing \(already exists\)/);
      return { output: "ok, using the existing one", threadId: "t", usage: null };
    });
    const service = await makeService(runner);
    await service.createAgent({ name: "Existing" });
    const orchestrator = await service.createAgent({ name: "Orchestrator" });

    const { run } = await service.sendMessage(orchestrator.id, "start");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getRun(run.id).output).toBe("ok, using the existing one");
    // Still only one Agent named "Existing" -- no duplicate created.
    expect(service.listAgents().filter((agent) => agent.name === "Existing")).toHaveLength(1);
  });

  it("never crashes on a malformed create-agents block -- falls through to a normal final answer check", async () => {
    const service = await makeService(
      new ScriptedRunner(() => ({
        output: "```create-agents\nnot valid json\n```",
        threadId: "t",
        usage: null,
      })),
    );
    const agent = await service.createAgent({ name: "Solo" });
    const { run } = await service.sendMessage(agent.id, "start");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getRun(run.id).output).toContain("```create-agents");
  });
});

describe("Multi-agent delegation and reconciliation across a restart", () => {
  it("re-parses a reattached container's recovered output for a delegate block instead of leaking it to the user", async () => {
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

    const orchestrator: Agent = {
      id: "orchestrator",
      name: "Orchestrator",
      description: "",
      instructions: "",
      status: "busy",
      ownerId: "unclaimed",
      sandboxMode: "workspace-write",
      networkAccess: true,
      workspacePath: workspaces.workspacePath("orchestrator"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    const helper: Agent = {
      id: "helper",
      name: "Helper",
      description: "",
      instructions: "",
      status: "ready",
      ownerId: "unclaimed",
      sandboxMode: "workspace-write",
      networkAccess: true,
      workspacePath: workspaces.workspacePath("helper"),
      codexThreadId: null,
      lastError: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    await workspaces.create(orchestrator, [orchestrator, helper]);
    await workspaces.create(helper, [orchestrator, helper]);
    const run: AgentRun = {
      id: "run-reattach",
      agentId: "orchestrator",
      status: "running",
      prompt: "do something that outlives the server",
      output: null,
      error: null,
      usage: null,
      startedAt: "2024-01-01T00:00:00.000Z",
      completedAt: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      partial: false,
      runnerHandle: "container:launchpad-default-orchestrator",
      parentRunId: null,
      actorId: null,
      awaitingChildRunId: null,
      orchestrationIterationCount: 0,
      retrieval: null,
    };
    await store.mutate((database) => {
      database.agents.push(orchestrator, helper);
      database.runs.push(run);
    });

    const runner: AgentRunner = {
      run: async (request) => {
        // The resumed second call (after the recovered delegate block is
        // acted on) should finish normally.
        if (request.agentId === "helper") {
          return { output: "helped!", threadId: "helper-thread", usage: null };
        }
        return { output: "final answer after delegation", threadId: "orchestrator-thread-2", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
      reconcile: async (): Promise<ReconcileOutcome> => ({
        stillRunning: true,
        reason: "Reattached to a running container",
        result: {
          output: delegateBlock("Helper", "help me"),
          threadId: "orchestrator-thread-1",
          usage: null,
        },
      }),
    };

    const service = new AgentService(config, store, workspaces, runner);
    await service.initialize();

    const finalRun = service.getRun("run-reattach");
    expect(finalRun.status).toBe("completed");
    // The raw fenced block must never be presented as the user-visible answer.
    expect(finalRun.output).not.toContain("```delegate");
    expect(finalRun.output).toBe("final answer after delegation");
    const helperRuns = service.getRuns("helper");
    expect(helperRuns).toHaveLength(1);
    expect(helperRuns[0]?.parentRunId).toBe("run-reattach");
  });

  it("resumes an orchestrator across a restart once its already-finished child is known", async () => {
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

    const parentAgent: Agent = {
      id: "parent-agent",
      name: "Parent",
      description: "",
      instructions: "",
      status: "busy",
      ownerId: "unclaimed",
      sandboxMode: "workspace-write",
      networkAccess: true,
      workspacePath: workspaces.workspacePath("parent-agent"),
      codexThreadId: "parent-thread",
      lastError: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    const childAgent: Agent = {
      id: "child-agent",
      name: "Child",
      description: "",
      instructions: "",
      status: "ready",
      ownerId: "unclaimed",
      sandboxMode: "workspace-write",
      networkAccess: true,
      workspacePath: workspaces.workspacePath("child-agent"),
      codexThreadId: "child-thread",
      lastError: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    await workspaces.create(parentAgent, [parentAgent, childAgent]);
    await workspaces.create(childAgent, [parentAgent, childAgent]);

    // The parent run was killed while genuinely "between iterations" --
    // its own runner call already exited (nothing to reattach to), but it
    // was waiting on the child, which is what makes this different from
    // ordinary single-run reconciliation.
    const parentRun: AgentRun = {
      id: "parent-run",
      agentId: "parent-agent",
      status: "running",
      prompt: "delegate this out",
      output: "I'll ask Child.",
      error: null,
      usage: null,
      startedAt: "2024-01-01T00:00:00.000Z",
      completedAt: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      partial: true,
      runnerHandle: null,
      parentRunId: null,
      actorId: null,
      awaitingChildRunId: "child-run",
      orchestrationIterationCount: 1,
      retrieval: null,
    };
    // The child, by contrast, genuinely finished successfully before the
    // crash (or gets reconciled to a real result below) -- either way its
    // outcome is known.
    const childRun: AgentRun = {
      id: "child-run",
      agentId: "child-agent",
      status: "running",
      prompt: "the delegated task",
      output: null,
      error: null,
      usage: null,
      startedAt: "2024-01-01T00:00:00.000Z",
      completedAt: null,
      createdAt: "2024-01-01T00:00:00.000Z",
      partial: false,
      runnerHandle: "container:launchpad-default-child-agent",
      parentRunId: "parent-run",
      actorId: null,
      awaitingChildRunId: null,
      orchestrationIterationCount: 0,
      retrieval: null,
    };
    await store.mutate((database) => {
      database.agents.push(parentAgent, childAgent);
      database.runs.push(parentRun, childRun);
    });

    const runner: AgentRunner = {
      run: async (request) => {
        // The parent's resumption call, once the child's result is known.
        expect(request.agentId).toBe("parent-agent");
        expect(request.threadId).toBe("parent-thread");
        expect(request.prompt).toContain("child finished the task");
        return { output: "done, using the child's result", threadId: "parent-thread-2", usage: null };
      },
      cancel: async () => false,
      isAvailable: async () => true,
      reconcile: async (agentId): Promise<ReconcileOutcome> => {
        if (agentId === "parent-agent") {
          // Nothing to reattach to for the parent itself -- it was between
          // iterations, not mid-call.
          return { stillRunning: false, reason: "Local-process Runs cannot be reattached after a server restart" };
        }
        // The child's own container was genuinely still running and gets
        // reattached with a real result.
        return {
          stillRunning: true,
          reason: "Reattached to a running container",
          result: { output: "child finished the task", threadId: "child-thread-2", usage: null },
        };
      },
    };

    const service = new AgentService(config, store, workspaces, runner);
    await service.initialize();

    // The key assertion: the parent must NOT be stuck "cancelled" just
    // because there was no live process to reattach it to directly -- it
    // must have been resumed once the child's fate became known.
    const finalParentRun = service.getRun("parent-run");
    expect(finalParentRun.status).toBe("completed");
    expect(finalParentRun.output).toBe("done, using the child's result");
    expect(finalParentRun.awaitingChildRunId).toBeNull();
    expect(service.getAgent("parent-agent").status).toBe("ready");

    const finalChildRun = service.getRun("child-run");
    expect(finalChildRun.status).toBe("completed");
    expect(finalChildRun.output).toBe("child finished the task");
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
        OPENROUTER_API_KEY: "test-key",
        OPENROUTER_MODEL: "test-model",
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
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_MODEL: "test-model",
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

describe("Prompt safety gate", () => {
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
});
