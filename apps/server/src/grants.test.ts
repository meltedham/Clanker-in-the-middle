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

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeApp() {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-grants-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_MODEL: "test-model",
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

async function createUser(app: Awaited<ReturnType<typeof makeApp>>, name: string, actorToken?: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/users",
    headers: actorToken ? authHeader(actorToken) : undefined,
    payload: { name },
  });
  const body = JSON.parse(response.body) as {
    user: { id: string; name: string; role: "admin" | "member" };
    token: string;
  };
  return { status: response.statusCode, ...body };
}

describe("Roles: admin bootstrap", () => {
  it("the very first user ever created becomes admin automatically", async () => {
    const app = await makeApp();
    const alice = await createUser(app, "Alice");
    expect(alice.status).toBe(201);
    expect(alice.user.role).toBe("admin");
    await app.close();
  });

  it("every user after the first defaults to member, not admin", async () => {
    const app = await makeApp();
    await createUser(app, "Alice");
    const bob = await createUser(app, "Bob");
    expect(bob.user.role).toBe("member");
    await app.close();
  });

  it("a member cannot self-promote to admin, even by asking nicely", async () => {
    const app = await makeApp();
    await createUser(app, "Alice"); // admin, by bootstrap
    const bob = await createUser(app, "Bob"); // member
    const eve = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: authHeader(bob.token),
      payload: { name: "Eve", role: "admin" },
    });
    expect(eve.statusCode).toBe(403);
    await app.close();
  });

  it("an existing admin can create another admin", async () => {
    const app = await makeApp();
    const alice = await createUser(app, "Alice"); // admin, by bootstrap
    const carol = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: authHeader(alice.token),
      payload: { name: "Carol", role: "admin" },
    });
    expect(carol.statusCode).toBe(201);
    expect(JSON.parse(carol.body).user.role).toBe("admin");
    await app.close();
  });

  it("an admin bypasses ownership entirely, on Agents they do not own", async () => {
    const app = await makeApp();
    const alice = await createUser(app, "Alice"); // admin
    const bob = await createUser(app, "Bob"); // member

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeader(bob.token),
      payload: { name: "Bob's Agent" },
    });
    const agentId = JSON.parse(created.body).agent.id as string;

    const adminRead = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}`,
      headers: authHeader(alice.token),
    });
    expect(adminRead.statusCode).toBe(200);

    const adminWrite = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agentId}`,
      headers: authHeader(alice.token),
      payload: { description: "edited by admin" },
    });
    expect(adminWrite.statusCode).toBe(200);
    await app.close();
  });
});

describe("Grants: viewer vs operator", () => {
  it("a viewer Grant allows reads but 403s on every write", async () => {
    const app = await makeApp();
    const owner = await createUser(app, "Owner"); // admin by bootstrap, but acts as owner here
    const viewer = await createUser(app, "Viewer", owner.token);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeader(owner.token),
      payload: { name: "Shared Agent" },
    });
    const agentId = JSON.parse(created.body).agent.id as string;

    const grant = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/grants`,
      headers: authHeader(owner.token),
      payload: { userId: viewer.user.id, role: "viewer" },
    });
    expect(grant.statusCode).toBe(201);

    const reads = await Promise.all([
      app.inject({ method: "GET", url: `/api/agents/${agentId}`, headers: authHeader(viewer.token) }),
      app.inject({
        method: "GET",
        url: `/api/agents/${agentId}/messages`,
        headers: authHeader(viewer.token),
      }),
      app.inject({ method: "GET", url: `/api/agents/${agentId}/runs`, headers: authHeader(viewer.token) }),
    ]);
    for (const response of reads) expect(response.statusCode).toBe(200);

    const writes = await Promise.all([
      app.inject({
        method: "PATCH",
        url: `/api/agents/${agentId}`,
        headers: authHeader(viewer.token),
        payload: { description: "viewer was here" },
      }),
      app.inject({
        method: "POST",
        url: `/api/agents/${agentId}/messages`,
        headers: authHeader(viewer.token),
        payload: { content: "hello" },
      }),
      app.inject({
        method: "POST",
        url: `/api/agents/${agentId}/start`,
        headers: authHeader(viewer.token),
      }),
      app.inject({ method: "DELETE", url: `/api/agents/${agentId}`, headers: authHeader(viewer.token) }),
    ]);
    for (const response of writes) expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("an operator Grant allows both reads and writes, including sending a message", async () => {
    const app = await makeApp();
    const owner = await createUser(app, "Owner");
    const operator = await createUser(app, "Operator", owner.token);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeader(owner.token),
      payload: { name: "Shared Agent" },
    });
    const agentId = JSON.parse(created.body).agent.id as string;

    await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/grants`,
      headers: authHeader(owner.token),
      payload: { userId: operator.user.id, role: "operator" },
    });

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agentId}`,
      headers: authHeader(operator.token),
      payload: { description: "operator edited this" },
    });
    expect(patch.statusCode).toBe(200);

    const message = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/messages`,
      headers: authHeader(operator.token),
      payload: { content: "build something" },
    });
    expect(message.statusCode).toBe(202);
    await app.close();
  });

  it("an operator can start an Agent but cannot stop it -- only the owner or an admin can", async () => {
    const app = await makeApp();
    const owner = await createUser(app, "Owner"); // admin, by bootstrap
    const operator = await createUser(app, "Operator", owner.token);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeader(owner.token),
      payload: { name: "Shared Agent" },
    });
    const agentId = JSON.parse(created.body).agent.id as string;

    await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/grants`,
      headers: authHeader(owner.token),
      payload: { userId: operator.user.id, role: "operator" },
    });

    const operatorStart = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/start`,
      headers: authHeader(operator.token),
    });
    expect(operatorStart.statusCode).toBe(200);

    const operatorStop = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/stop`,
      headers: authHeader(operator.token),
    });
    expect(operatorStop.statusCode).toBe(403);

    const ownerStop = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/stop`,
      headers: authHeader(owner.token),
    });
    expect(ownerStop.statusCode).toBe(200);
    await app.close();
  });

  it("an operator cannot delete an Agent -- only the owner or an admin can", async () => {
    const app = await makeApp();
    const owner = await createUser(app, "Owner"); // admin, by bootstrap
    const operator = await createUser(app, "Operator", owner.token);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeader(owner.token),
      payload: { name: "Shared Agent" },
    });
    const agentId = JSON.parse(created.body).agent.id as string;

    await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/grants`,
      headers: authHeader(owner.token),
      payload: { userId: operator.user.id, role: "operator" },
    });

    const operatorDelete = await app.inject({
      method: "DELETE",
      url: `/api/agents/${agentId}`,
      headers: authHeader(operator.token),
    });
    expect(operatorDelete.statusCode).toBe(403);

    // Still there afterward -- the refusal actually stopped it.
    const stillThere = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}`,
      headers: authHeader(owner.token),
    });
    expect(stillThere.statusCode).toBe(200);

    const ownerDelete = await app.inject({
      method: "DELETE",
      url: `/api/agents/${agentId}`,
      headers: authHeader(owner.token),
    });
    expect(ownerDelete.statusCode).toBe(200);
    await app.close();
  });

  it("an operator cannot change sandbox/network policy -- only the owner or an admin can", async () => {
    const app = await makeApp();
    const owner = await createUser(app, "Owner"); // admin, by bootstrap
    const operator = await createUser(app, "Operator", owner.token);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeader(owner.token),
      payload: { name: "Shared Agent" },
    });
    const agentId = JSON.parse(created.body).agent.id as string;

    await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/grants`,
      headers: authHeader(owner.token),
      payload: { userId: operator.user.id, role: "operator" },
    });

    const operatorPatch = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agentId}`,
      headers: authHeader(operator.token),
      payload: { sandboxMode: "read-only" },
    });
    expect(operatorPatch.statusCode).toBe(403);

    // An operator can still edit ordinary fields -- only the policy fields
    // are gated stricter than plain write.
    const operatorOrdinaryEdit = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agentId}`,
      headers: authHeader(operator.token),
      payload: { description: "Operator can still describe it" },
    });
    expect(operatorOrdinaryEdit.statusCode).toBe(200);

    const ownerPatch = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agentId}`,
      headers: authHeader(owner.token),
      payload: { sandboxMode: "read-only", networkAccess: false },
    });
    expect(ownerPatch.statusCode).toBe(200);
    const ownerBody = JSON.parse(ownerPatch.body);
    expect(ownerBody.agent.sandboxMode).toBe("read-only");
    expect(ownerBody.agent.networkAccess).toBe(false);
    await app.close();
  });

  it("rejects an unrecognized sandboxMode value, including the removed danger-full-access, before it ever reaches AgentService", async () => {
    const app = await makeApp();
    const owner = await createUser(app, "Owner"); // admin, by bootstrap

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeader(owner.token),
      payload: { name: "Agent" },
    });
    const agentId = JSON.parse(created.body).agent.id as string;

    const dangerFullAccess = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agentId}`,
      headers: authHeader(owner.token),
      payload: { sandboxMode: "danger-full-access" },
    });
    expect(dangerFullAccess.statusCode).toBe(400);

    const garbage = await app.inject({
      method: "PATCH",
      url: `/api/agents/${agentId}`,
      headers: authHeader(owner.token),
      payload: { sandboxMode: "not-a-real-mode" },
    });
    expect(garbage.statusCode).toBe(400);

    // Confirms the 400 actually stopped the change -- not just a coincidental
    // failure elsewhere in the request.
    const stillDefault = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}`,
      headers: authHeader(owner.token),
    });
    expect(JSON.parse(stillDefault.body).agent.sandboxMode).toBe("workspace-write");
    await app.close();
  });

  it("revoking a Grant takes effect on the very next request", async () => {
    const app = await makeApp();
    const owner = await createUser(app, "Owner");
    const collaborator = await createUser(app, "Collaborator", owner.token);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeader(owner.token),
      payload: { name: "Shared Agent" },
    });
    const agentId = JSON.parse(created.body).agent.id as string;

    const grantResponse = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/grants`,
      headers: authHeader(owner.token),
      payload: { userId: collaborator.user.id, role: "operator" },
    });
    const grantId = JSON.parse(grantResponse.body).grant.id as string;

    const beforeRevoke = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}`,
      headers: authHeader(collaborator.token),
    });
    expect(beforeRevoke.statusCode).toBe(200);

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/agents/${agentId}/grants/${grantId}`,
      headers: authHeader(owner.token),
    });
    expect(revoked.statusCode).toBe(204);

    const afterRevoke = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}`,
      headers: authHeader(collaborator.token),
    });
    expect(afterRevoke.statusCode).toBe(403);
    await app.close();
  });

  it("re-granting to the same user upserts the role instead of duplicating", async () => {
    const app = await makeApp();
    const owner = await createUser(app, "Owner");
    const collaborator = await createUser(app, "Collaborator", owner.token);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeader(owner.token),
      payload: { name: "Shared Agent" },
    });
    const agentId = JSON.parse(created.body).agent.id as string;

    await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/grants`,
      headers: authHeader(owner.token),
      payload: { userId: collaborator.user.id, role: "viewer" },
    });
    await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/grants`,
      headers: authHeader(owner.token),
      payload: { userId: collaborator.user.id, role: "operator" },
    });

    const list = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/grants`,
      headers: authHeader(owner.token),
    });
    const grants = JSON.parse(list.body).grants as Array<{ role: string; revocable: boolean }>;
    // "Owner" is admin by bootstrap, so listGrants also includes their
    // synthetic, non-revocable entry alongside the real Grant.
    const revocableGrants = grants.filter((grant) => grant.revocable);
    expect(revocableGrants).toHaveLength(1);
    expect(revocableGrants[0]?.role).toBe("operator");
    await app.close();
  });

  it("only the Agent's owner or an admin can grant, list, or revoke its access", async () => {
    const app = await makeApp();
    const owner = await createUser(app, "Owner"); // admin by bootstrap
    const bystander = await createUser(app, "Bystander", owner.token);
    const target = await createUser(app, "Target", owner.token);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeader(owner.token),
      payload: { name: "Owner's Agent" },
    });
    const agentId = JSON.parse(created.body).agent.id as string;

    const grantAttempt = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/grants`,
      headers: authHeader(bystander.token),
      payload: { userId: target.user.id, role: "operator" },
    });
    expect(grantAttempt.statusCode).toBe(403);

    const listAttempt = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/grants`,
      headers: authHeader(bystander.token),
    });
    expect(listAttempt.statusCode).toBe(403);
    await app.close();
  });

  it("refuses to grant a role to an admin -- they already have full access regardless", async () => {
    const app = await makeApp();
    const admin = await createUser(app, "Admin"); // admin by bootstrap
    const member = await createUser(app, "Member", admin.token); // plain member, owns their own Agent

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeader(member.token),
      payload: { name: "Member's Agent" },
    });
    const agentId = JSON.parse(created.body).agent.id as string;

    const grantAttempt = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/grants`,
      headers: authHeader(member.token),
      payload: { userId: admin.user.id, role: "viewer" },
    });
    expect(grantAttempt.statusCode).toBe(403);

    const grants = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}/grants`,
      headers: authHeader(member.token),
    });
    const grantList = JSON.parse(grants.body).grants as Array<{
      userName: string;
      role: string;
      revocable: boolean;
    }>;
    // No explicit Grant was created for the admin -- the only entry is the
    // synthetic, non-revocable one every admin always gets.
    expect(grantList).toEqual([
      { id: "admin:" + admin.user.id, userId: admin.user.id, userName: "Admin", role: "admin", revocable: false, createdAt: expect.any(String) },
    ]);
    await app.close();
  });

  it("deleting an Agent cleans up its grants", async () => {
    const app = await makeApp();
    const owner = await createUser(app, "Owner");
    const collaborator = await createUser(app, "Collaborator", owner.token);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeader(owner.token),
      payload: { name: "Shared Agent" },
    });
    const agentId = JSON.parse(created.body).agent.id as string;

    await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/grants`,
      headers: authHeader(owner.token),
      payload: { userId: collaborator.user.id, role: "viewer" },
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/agents/${agentId}`,
      headers: authHeader(owner.token),
    });
    expect(deleted.statusCode).toBe(200);

    // The Agent is gone entirely, so any further reference 404s rather than
    // exposing a dangling Grant.
    const readAfterDelete = await app.inject({
      method: "GET",
      url: `/api/agents/${agentId}`,
      headers: authHeader(collaborator.token),
    });
    expect(readAfterDelete.statusCode).toBe(404);
    await app.close();
  });

  it("tells each caller their own relationship to the Agent via myRole", async () => {
    const app = await makeApp();
    const admin = await createUser(app, "Admin"); // admin by bootstrap
    const owner = await createUser(app, "Owner", admin.token);
    const viewer = await createUser(app, "Viewer", admin.token);
    const operator = await createUser(app, "Operator", admin.token);

    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: authHeader(owner.token),
      payload: { name: "Shared Agent" },
    });
    const agentId = JSON.parse(created.body).agent.id as string;

    await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/grants`,
      headers: authHeader(owner.token),
      payload: { userId: viewer.user.id, role: "viewer" },
    });
    await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/grants`,
      headers: authHeader(owner.token),
      payload: { userId: operator.user.id, role: "operator" },
    });

    const myRoleAs = async (token: string) => {
      const list = await app.inject({ method: "GET", url: "/api/agents", headers: authHeader(token) });
      const agents = JSON.parse(list.body).agents as Array<{ id: string; myRole: string | null }>;
      return agents.find((agent) => agent.id === agentId)?.myRole ?? null;
    };

    expect(await myRoleAs(owner.token)).toBe("owner");
    expect(await myRoleAs(admin.token)).toBe("admin");
    expect(await myRoleAs(viewer.token)).toBe("viewer");
    expect(await myRoleAs(operator.token)).toBe("operator");
    await app.close();
  });
});
