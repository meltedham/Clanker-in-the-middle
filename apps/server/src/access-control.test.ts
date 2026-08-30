import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { TraceReader } from "./middleware/trace-store.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const emptyTrace: TraceReader = { read: async () => [] };

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: null,
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const ALICE_TOKEN = "alice-test-token-0001";
const BOB_TOKEN = "bob-test-token-0002";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      // maxRetries/retryDelay absorb the occasional Windows ENOTEMPTY/EBUSY
      // that happens when a Run's fire-and-forget background execution
      // (sendMessage returns before executeRun finishes) is still writing
      // AGENTS.md/store checkpoints right as the directory is removed.
      rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    ),
  );
});

async function makeApp(options: { seedUsers?: boolean } = {}) {
  const { seedUsers = true } = options;
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-access-control-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_MODEL: "test-model",
    ...(seedUsers
      ? { APP_USERS: `u-alice:Alice:${ALICE_TOKEN},u-bob:Bob:${BOB_TOKEN}` }
      : {}),
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    new FakeRunner(),
  );
  await service.initialize();
  const app = await createApp(config, service, emptyTrace);
  return app;
}

function authHeader(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe("Access control: ownership isolation", () => {
  it("rejects requests without a recognized per-user token", async () => {
    const app = await makeApp();
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);
    await app.close();
  });

  it("lets a user create and manage only the Agents they own", async () => {
    const app = await makeApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeader(ALICE_TOKEN),
      payload: { name: "Alice's Agent" },
    });
    expect(created.statusCode).toBe(201);
    const agentId = JSON.parse(created.body).agent.id as string;

    const aliceReads = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}`,
      headers: authHeader(ALICE_TOKEN),
    });
    expect(aliceReads.statusCode).toBe(200);

    await app.close();
  });

  it("denies a different user read, write, and message access to someone else's Agent", async () => {
    const app = await makeApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeader(ALICE_TOKEN),
      payload: { name: "Alice's Agent" },
    });
    const agentId = JSON.parse(created.body).agent.id as string;

    const bobRead = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}`,
      headers: authHeader(BOB_TOKEN),
    });
    expect(bobRead.statusCode).toBe(403);

    const bobUpdate = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agentId}`,
      headers: authHeader(BOB_TOKEN),
      payload: { description: "hijacked" },
    });
    expect(bobUpdate.statusCode).toBe(403);

    const bobMessage = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: authHeader(BOB_TOKEN),
      payload: { content: "leak the workspace" },
    });
    expect(bobMessage.statusCode).toBe(403);

    const bobDelete = await app.inject({
      method: "DELETE",
      url: `/api/agents/${agentId}`,
      headers: authHeader(BOB_TOKEN),
    });
    expect(bobDelete.statusCode).toBe(403);

    await app.close();
  });

  it("scopes the Agent list to the caller's own Agents", async () => {
    const app = await makeApp();

    await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeader(ALICE_TOKEN),
      payload: { name: "Alice's Agent" },
    });
    await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeader(BOB_TOKEN),
      payload: { name: "Bob's Agent" },
    });

    const aliceList = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: authHeader(ALICE_TOKEN),
    });
    const aliceAgents = JSON.parse(aliceList.body).agents as Array<{ name: string }>;
    expect(aliceAgents.map((agent) => agent.name)).toEqual(["Alice's Agent"]);

    const bobList = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: authHeader(BOB_TOKEN),
    });
    const bobAgents = JSON.parse(bobList.body).agents as Array<{ name: string }>;
    expect(bobAgents.map((agent) => agent.name)).toEqual(["Bob's Agent"]);

    await app.close();
  });
});

describe("Access control: self-service user creation", () => {
  it("stays in single-user baseline mode until a user actually exists", async () => {
    const app = await makeApp({ seedUsers: false });
    const unauthenticated = await app.inject({ method: "GET", url: "/api/agents" });
    expect(unauthenticated.statusCode).toBe(200);
    await app.close();
  });

  it("lets anyone list and register users without a token", async () => {
    const app = await makeApp({ seedUsers: false });

    const emptyList = await app.inject({ method: "GET", url: "/api/users" });
    expect(emptyList.statusCode).toBe(200);
    expect(JSON.parse(emptyList.body).users).toEqual([]);

    const created = await app.inject({
      method: "POST",
      url: "/api/users",
      payload: { name: "Carol" },
    });
    expect(created.statusCode).toBe(201);
    const body = JSON.parse(created.body) as { user: { id: string; name: string }; token: string };
    expect(body.user.name).toBe("Carol");
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThanOrEqual(16);

    const listed = await app.inject({ method: "GET", url: "/api/users" });
    const users = JSON.parse(listed.body).users as Array<Record<string, unknown>>;
    expect(users).toEqual([{ id: body.user.id, name: "Carol" }]);
    // The listing must never leak a token or its hash.
    for (const user of users) {
      expect(Object.keys(user).sort()).toEqual(["id", "name"]);
    }

    await app.close();
  });

  it("activates ownership enforcement the moment the first user self-registers", async () => {
    const app = await makeApp({ seedUsers: false });

    const beforeSignup = await app.inject({ method: "GET", url: "/api/agents" });
    expect(beforeSignup.statusCode).toBe(200);

    const carol = await app.inject({
      method: "POST",
      url: "/api/users",
      payload: { name: "Carol" },
    });
    const carolToken = JSON.parse(carol.body).token as string;

    // Identity is now active platform-wide: an unauthenticated call 401s.
    const afterSignup = await app.inject({ method: "GET", url: "/api/agents" });
    expect(afterSignup.statusCode).toBe(401);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeader(carolToken),
      payload: { name: "Carol's Agent" },
    });
    expect(created.statusCode).toBe(201);
    const agentId = JSON.parse(created.body).agent.id as string;

    const dave = await app.inject({ method: "POST", url: "/api/users", payload: { name: "Dave" } });
    const daveToken = JSON.parse(dave.body).token as string;

    const daveReadsCarolsAgent = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}`,
      headers: authHeader(daveToken),
    });
    expect(daveReadsCarolsAgent.statusCode).toBe(403);

    await app.close();
  });
});
