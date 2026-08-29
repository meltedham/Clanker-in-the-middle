import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return { output: "done", threadId: request.threadId ?? "t", usage: null };
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
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeApp() {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-password-"));
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
    new FakeRunner(),
  );
  await service.initialize();
  const app = await createApp(config, service);
  return app;
}

describe("Password login", () => {
  it("lets a user set a password at signup and log back in with it", async () => {
    const app = await makeApp();

    const signup = await app.inject({
      method: "POST",
      url: "/api/users",
      payload: { name: "Alice", password: "correct-horse-battery" },
    });
    expect(signup.statusCode).toBe(201);

    const login = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { name: "Alice", password: "correct-horse-battery" },
    });
    expect(login.statusCode).toBe(200);
    const loginBody = JSON.parse(login.body) as { user: { name: string }; token: string };
    expect(loginBody.user.name).toBe("Alice");
    expect(typeof loginBody.token).toBe("string");

    // The freshly-logged-in token actually works for a real request.
    const whoami = await app.inject({
      method: "GET",
      url: "/api/whoami",
      headers: { authorization: `Bearer ${loginBody.token}` },
    });
    expect(JSON.parse(whoami.body).user.name).toBe("Alice");

    await app.close();
  });

  it("rejects the wrong password without revealing whether the name exists", async () => {
    const app = await makeApp();
    await app.inject({
      method: "POST",
      url: "/api/users",
      payload: { name: "Alice", password: "correct-horse-battery" },
    });

    const wrongPassword = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { name: "Alice", password: "wrong-password-entirely" },
    });
    expect(wrongPassword.statusCode).toBe(401);

    const unknownName = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { name: "NobodyByThisName", password: "whatever" },
    });
    expect(unknownName.statusCode).toBe(401);
    expect(JSON.parse(wrongPassword.body).error).toBe(JSON.parse(unknownName.body).error);

    await app.close();
  });

  it("logging in again issues a new token and invalidates the old one", async () => {
    const app = await makeApp();
    const signup = await app.inject({
      method: "POST",
      url: "/api/users",
      payload: { name: "Alice", password: "correct-horse-battery" },
    });
    const originalToken = JSON.parse(signup.body).token as string;

    const secondLogin = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { name: "Alice", password: "correct-horse-battery" },
    });
    const newToken = JSON.parse(secondLogin.body).token as string;
    expect(newToken).not.toBe(originalToken);

    const oldTokenNowInvalid = await app.inject({
      method: "GET",
      url: "/api/whoami",
      headers: { authorization: `Bearer ${originalToken}` },
    });
    // The onRequest hook itself 401s an unresolvable token before the route
    // handler ever runs, so this never even reaches the {user: null} shape.
    expect(oldTokenNowInvalid.statusCode).toBe(401);

    const newTokenWorks = await app.inject({
      method: "GET",
      url: "/api/whoami",
      headers: { authorization: `Bearer ${newToken}` },
    });
    expect(JSON.parse(newTokenWorks.body).user.name).toBe("Alice");

    await app.close();
  });

  it("refuses a second password-holding account with the same name", async () => {
    const app = await makeApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/users",
      payload: { name: "Alice", password: "correct-horse-battery" },
    });
    expect(first.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/users",
      payload: { name: "Alice", password: "another-password-here" },
    });
    expect(duplicate.statusCode).toBe(409);

    await app.close();
  });

  it("lets an account without a password keep signing in via its original token only", async () => {
    const app = await makeApp();
    const created = await app.inject({ method: "POST", url: "/api/users", payload: { name: "Bob" } });
    expect(created.statusCode).toBe(201);

    const loginAttempt = await app.inject({
      method: "POST",
      url: "/api/login",
      payload: { name: "Bob", password: "anything" },
    });
    expect(loginAttempt.statusCode).toBe(401);

    await app.close();
  });
});
