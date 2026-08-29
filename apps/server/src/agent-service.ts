import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  AuthUser,
  CreateAgentInput,
  EffectiveRole,
  Grant,
  GrantRole,
  GrantView,
  Message,
  UpdateAgentInput,
  UserRole,
} from "./types.js";
import { UNCLAIMED_OWNER_ID } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

type AccessLevel = "read" | "write";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashesMatch(candidateHash: string, storedHash: string): boolean {
  const candidateBuffer = Buffer.from(candidateHash);
  const storedBuffer = Buffer.from(storedHash);
  return (
    candidateBuffer.length === storedBuffer.length &&
    timingSafeEqual(candidateBuffer, storedBuffer)
  );
}

// scrypt, not sha256: a token is already a random 24-byte value with no
// guessable structure, so a fast hash is fine for it. A password is
// low-entropy and human-chosen, so it needs a deliberately slow, salted KDF
// to resist offline brute-forcing of a leaked store.
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return salt + ":" + derived;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, derivedHex] = stored.split(":");
  if (!salt || !derivedHex) return false;
  const candidate = scryptSync(password, salt, 64);
  const storedBuffer = Buffer.from(derivedHex, "hex");
  return candidate.length === storedBuffer.length && timingSafeEqual(candidate, storedBuffer);
}

/**
 * `actor` is `null` whenever no identity is configured (no user has ever
 * been created), which preserves the original single-user baseline
 * behavior. Once identity is active, every Agent-scoped operation is
 * checked here -- in the service, not the routes -- against, in order:
 * admin bypass, ownership, then any active (non-revoked) Grant. A "viewer"
 * Grant only ever satisfies "read"; only "operator" (or ownership/admin)
 * satisfies "write". This is re-checked on every call, so revoking a Grant
 * takes effect on the very next request -- there is no caching of a
 * previously-resolved permission.
 */
function assertAccess(
  agent: Agent,
  actor: AuthUser | null,
  level: AccessLevel,
  grants: Grant[],
): void {
  if (actor === null) return;
  if (actor.role === "admin") return;
  if (agent.ownerId === actor.id) return;
  const activeGrant = grants.find(
    (grant) => grant.agentId === agent.id && grant.userId === actor.id && !grant.revokedAt,
  );
  if (activeGrant && (level === "read" || activeGrant.role === "operator")) return;
  if (activeGrant) {
    // They do have access -- just not enough of it. Distinct from having
    // none at all, so a viewer trying to write isn't told they have no
    // access when they actually have read access.
    throw new HttpError(
      403,
      "You have read-only access to this Agent; this action requires write access",
    );
  }
  throw new HttpError(403, "You do not have access to this Agent");
}

/** Same precedence as assertAccess (admin, then owner, then Grant), but
 * returns the answer instead of throwing -- used to tell the caller what
 * their own relationship to an Agent actually is, e.g. so the UI can show
 * "you have read-only access" on an Agent shared with them. */
function myRoleFor(agent: Agent, actor: AuthUser | null, grants: Grant[]): EffectiveRole | null {
  if (actor === null) return null;
  if (actor.role === "admin") return "admin";
  if (agent.ownerId === actor.id) return "owner";
  const activeGrant = grants.find(
    (grant) => grant.agentId === agent.id && grant.userId === actor.id && !grant.revokedAt,
  );
  return activeGrant ? activeGrant.role : null;
}

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      const validSandboxModes = ["read-only", "workspace-write"];
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
        // Back-compat: Agents created before per-Agent runtime policy
        // existed have neither field in their stored JSON. Backfill to
        // what they were already implicitly running as -- the platform's
        // one global default at the time -- rather than leaving them
        // `undefined`, which a <select> in the UI would otherwise render
        // as its first option ("read-only") despite nothing actually
        // being set.
        if (!validSandboxModes.includes(agent.sandboxMode)) {
          agent.sandboxMode = this.config.codexSandboxMode;
        }
        if (typeof agent.networkAccess !== "boolean") {
          agent.networkAccess = true;
        }
      }
      for (const seed of this.config.users) {
        const tokenHash = hashToken(seed.token);
        const existing = database.users.find((user) => user.id === seed.id);
        if (existing) {
          existing.name = seed.name;
          existing.tokenHash = tokenHash;
          existing.role = seed.role;
        } else {
          database.users.push({
            id: seed.id,
            name: seed.name,
            tokenHash,
            role: seed.role,
            createdAt: now(),
          });
        }
      }
    });
  }

  /** True once any user exists (seeded via APP_USERS or self-registered).
   * Ownership enforcement in this service only activates once this is true,
   * which preserves the single-user baseline until a team opts in. */
  hasIdentityEnabled(): boolean {
    return this.store.snapshot().users.length > 0;
  }

  /** Whether `actor` may manage (grant/revoke/view grants for, or create a
   * user pre-granted onto) `agent`: the owner, an admin, or -- only while
   * identity has never been activated -- anyone. `actor === null` while
   * identity IS active (only reachable through the one intentionally
   * unauthenticated caller of this: POST /api/users with no token) must
   * NOT be treated as a bypass, unlike the read/write access check above,
   * or an anonymous caller could grant themselves access to any Agent. */
  private isOwnerOrAdmin(agent: Agent, actor: AuthUser | null): boolean {
    if (!this.hasIdentityEnabled()) return true;
    if (!actor) return false;
    return actor.role === "admin" || agent.ownerId === actor.id;
  }

  listUsers(): Array<{ id: string; name: string }> {
    return this.store
      .snapshot()
      .users.map((user) => ({ id: user.id, name: user.name }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async createUser(
    name: string,
    options: {
      actor?: AuthUser | null | undefined;
      role?: UserRole | undefined;
      password?: string | undefined;
    } = {},
  ): Promise<{ user: AuthUser; token: string }> {
    const { actor = null, role: requestedRole, password } = options;

    const token = randomBytes(24).toString("base64url");
    const tokenHash = hashToken(token);
    const passwordHash = password ? hashPassword(password) : undefined;
    const id = randomUUID();
    const createdAt = now();

    const role = await this.store.mutate((database) => {
      // Login-by-name only works if a name is unambiguous among
      // password-holding accounts; passwordless accounts (e.g. seeded via
      // APP_USERS) are unaffected and may still share a name.
      if (passwordHash && database.users.some((user) => user.passwordHash && user.name === name)) {
        throw new HttpError(409, `An account named "${name}" already has a password set`);
      }
      const isFirstEver = database.users.length === 0;
      let effectiveRole: UserRole = "member";
      if (isFirstEver) {
        // Bootstrap: the very first account on a fresh instance becomes
        // admin automatically, so identity can activate without needing a
        // pre-existing admin to invite anyone.
        effectiveRole = "admin";
      } else if (requestedRole === "admin") {
        if (actor?.role !== "admin") {
          throw new HttpError(403, "Only an existing admin can create another admin");
        }
        effectiveRole = "admin";
      }
      database.users.push({
        id,
        name,
        tokenHash,
        ...(passwordHash ? { passwordHash } : {}),
        role: effectiveRole,
        createdAt,
      });
      return effectiveRole;
    });

    return { user: { id, name, role }, token };
  }

  /** Verifies name+password and mints a fresh token for that account,
   * replacing whatever token it had before (single active session per
   * account -- logging in elsewhere invalidates the previous token). Only
   * accounts created with a password can use this; a generic 401 either way
   * avoids confirming whether a given name exists. */
  async login(name: string, password: string): Promise<{ user: AuthUser; token: string }> {
    const trimmedName = name.trim();
    const token = randomBytes(24).toString("base64url");
    const tokenHash = hashToken(token);
    return this.store.mutate((database) => {
      const user = database.users.find(
        (entry) => entry.passwordHash && entry.name === trimmedName,
      );
      if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
        throw new HttpError(401, "Invalid name or password");
      }
      user.tokenHash = tokenHash;
      return { user: { id: user.id, name: user.name, role: user.role }, token };
    });
  }

  /** Looks up the caller from a bearer token. Returns null on no match so
   * the route boundary can turn that into a 401 without leaking which part
   * of the credential was wrong. */
  resolveUserByToken(token: string): AuthUser | null {
    if (!token) return null;
    const candidateHash = hashToken(token);
    const user = this.store
      .snapshot()
      .users.find((entry) => hashesMatch(candidateHash, entry.tokenHash));
    return user ? { id: user.id, name: user.name, role: user.role } : null;
  }

  /** Grant scoped, revocable access to one Agent. Upserts: re-granting an
   * existing (non-revoked) Grant for the same Agent/user just changes its
   * role rather than creating a duplicate. */
  async createGrant(
    agentId: string,
    actor: AuthUser | null,
    granteeUserId: string,
    role: GrantRole,
  ): Promise<Grant> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === agentId);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (!this.isOwnerOrAdmin(agent, actor)) {
        throw new HttpError(
          403,
          "Only the Agent's owner or an admin can manage its access grants",
        );
      }
      const grantee = database.users.find((user) => user.id === granteeUserId);
      if (!grantee) throw new HttpError(404, "User not found");
      if (grantee.role === "admin") {
        // Admins bypass ownership unconditionally in assertAccess, before
        // any Grant is even consulted -- a Grant record here would do
        // nothing except lie in the Active Grants list, implying an admin
        // is restricted to "viewer" when they still have full access.
        throw new HttpError(
          403,
          "Admins already have full access to every Agent and can't be granted a role",
        );
      }
      const existing = database.grants.find(
        (item) => item.agentId === agentId && item.userId === granteeUserId && !item.revokedAt,
      );
      if (existing) {
        existing.role = role;
        return structuredClone(existing);
      }
      const grant: Grant = {
        id: randomUUID(),
        agentId,
        userId: granteeUserId,
        role,
        createdAt: now(),
        revokedAt: null,
      };
      database.grants.push(grant);
      return structuredClone(grant);
    });
  }

  /** Everyone who effectively has access to this Agent, owner/admin-only:
   * every admin (a synthetic, non-revocable entry -- they bypass Grants
   * entirely, so there is nothing to revoke), plus every active (non-
   * revoked) explicit Grant. Admins are listed first since their access
   * isn't tied to this Agent specifically. */
  listGrants(agentId: string, actor: AuthUser | null): GrantView[] {
    const snapshot = this.store.snapshot();
    const agent = snapshot.agents.find((item) => item.id === agentId);
    if (!agent) throw new HttpError(404, "Agent not found");
    if (!this.isOwnerOrAdmin(agent, actor)) {
      throw new HttpError(403, "Only the Agent's owner or an admin can view its access grants");
    }
    const adminEntries: GrantView[] = snapshot.users
      .filter((user) => user.role === "admin")
      .map((user) => ({
        id: "admin:" + user.id,
        userId: user.id,
        userName: user.name,
        role: "admin",
        revocable: false,
        createdAt: user.createdAt,
      }));
    const grantEntries: GrantView[] = snapshot.grants
      .filter((grant) => grant.agentId === agentId && !grant.revokedAt)
      .map((grant) => ({
        id: grant.id,
        userId: grant.userId,
        userName: snapshot.users.find((user) => user.id === grant.userId)?.name ?? "Unknown",
        role: grant.role,
        revocable: true,
        createdAt: grant.createdAt,
      }));
    return [...adminEntries, ...grantEntries];
  }

  /** Revocation takes effect immediately: the very next request that relies
   * on this Grant re-reads the store and finds `revokedAt` set, since
   * `assertAccess` never caches a previous decision. */
  async revokeGrant(agentId: string, grantId: string, actor: AuthUser | null): Promise<void> {
    await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === agentId);
      if (!agent) throw new HttpError(404, "Agent not found");
      if (!this.isOwnerOrAdmin(agent, actor)) {
        throw new HttpError(
          403,
          "Only the Agent's owner or an admin can revoke its access grants",
        );
      }
      const grant = database.grants.find((item) => item.id === grantId && item.agentId === agentId);
      if (!grant) throw new HttpError(404, "Grant not found");
      grant.revokedAt = now();
    });
  }

  listAgents(actor: AuthUser | null = null): Array<Agent & { myRole: EffectiveRole | null }> {
    const snapshot = this.store.snapshot();
    const withRole = (agent: Agent) => ({
      ...agent,
      myRole: myRoleFor(agent, actor, snapshot.grants),
    });
    if (actor === null || actor.role === "admin") {
      return snapshot.agents
        .map(withRole)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }
    const grantedAgentIds = new Set(
      snapshot.grants
        .filter((grant) => grant.userId === actor.id && !grant.revokedAt)
        .map((grant) => grant.agentId),
    );
    return snapshot.agents
      .filter((agent) => agent.ownerId === actor.id || grantedAgentIds.has(agent.id))
      .map(withRole)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string, actor: AuthUser | null = null, level: AccessLevel = "read"): Agent {
    const snapshot = this.store.snapshot();
    const agent = snapshot.agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    assertAccess(agent, actor, level, snapshot.grants);
    return agent;
  }

  async createAgent(input: CreateAgentInput, ownerId: string = UNCLAIMED_OWNER_ID): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
      ownerId,
      sandboxMode: input.sandboxMode ?? this.config.codexSandboxMode,
      networkAccess: input.networkAccess ?? true,
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(
    id: string,
    input: UpdateAgentInput,
    actor: AuthUser | null = null,
  ): Promise<Agent> {
    const current = this.getAgent(id, actor, "write");
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    // Runtime policy (sandbox/network) is stricter than ordinary edits: an
    // operator Grant lets someone use an Agent, not reconfigure how
    // dangerous it's allowed to be. Only the owner or an admin may change it.
    if (
      (input.sandboxMode !== undefined || input.networkAccess !== undefined) &&
      !this.isOwnerOrAdmin(current, actor)
    ) {
      throw new HttpError(
        403,
        "Only the Agent's owner or an admin can change its sandbox or network policy",
      );
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      assertAccess(agent, actor, "write", database.grants);
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      if (input.sandboxMode !== undefined) agent.sandboxMode = input.sandboxMode;
      if (input.networkAccess !== undefined) agent.networkAccess = input.networkAccess;
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(
    id: string,
    actor: AuthUser | null = null,
  ): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id, actor, "write");
    // Stricter than an ordinary write, same reasoning as stopAgent:
    // deleting is destructive and irreversible (the workspace is archived,
    // the Agent is gone). An operator Grant lets someone use the Agent,
    // not destroy it out from under its owner -- only the owner or an
    // admin can.
    if (!this.isOwnerOrAdmin(agent, actor)) {
      throw new HttpError(403, "Only the Agent's owner or an admin can delete it");
    }
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
      database.grants = database.grants.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string, actor: AuthUser | null = null): Promise<Agent> {
    this.getAgent(id, actor, "write");
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string, actor: AuthUser | null = null): Promise<Agent> {
    const current = this.getAgent(id, actor, "write");
    // Stricter than an ordinary write: stopping kills whatever is actually
    // running, possibly work someone else started. An operator Grant can
    // use the Agent, but not interrupt it out from under its owner --
    // only the owner or an admin can.
    if (!this.isOwnerOrAdmin(current, actor)) {
      throw new HttpError(403, "Only the Agent's owner or an admin can stop it");
    }
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string, actor: AuthUser | null = null): Message[] {
    this.getAgent(agentId, actor, "read");
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string, actor: AuthUser | null = null): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    this.getAgent(run.agentId, actor, "read");
    return run;
  }

  getRuns(agentId: string, actor: AuthUser | null = null): AgentRun[] {
    this.getAgent(agentId, actor, "read");
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
    actor: AuthUser | null = null,
  ): Promise<{ run: AgentRun; message: Message }> {
    // Access is checked before any other precondition so a denied caller
    // always sees 403, never a hint about the platform's own configuration
    // state (e.g. whether Ark is set up). Sending a message is a write: a
    // "viewer" Grant is not enough, only "operator" (or ownership/admin).
    this.getAgent(agentId, actor, "write");
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      assertAccess(storedAgent, actor, "write", database.grants);
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return snapshot;
    });
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  /** Best-effort redaction of internal infrastructure details before
   * Codex's own freeform text (or a raw error message) is ever persisted or
   * shown to a user. Codex runs real shell commands against the real
   * filesystem, so its own responses can quote absolute host paths,
   * container UIDs, etc. verbatim -- this can't catch every way an LLM
   * might phrase a leak, only the exact, known strings this service
   * itself controls, but that reliably covers what every Run actually
   * exposes: this Agent's own workspace path, the shared workspace root,
   * Codex's home directory, and raw uid/gid numbers. Applied going
   * forward only -- it does not retroactively rewrite already-stored
   * messages. */
  private redactOutput(text: string, agentWorkspacePath: string): string {
    return text
      .split(agentWorkspacePath)
      .join("[agent workspace path redacted]")
      .split(this.config.workspaceRoot)
      .join("[workspace root redacted]")
      .split(this.config.codexHome)
      .join("[codex home redacted]")
      .replace(/\b(uid|gid)[=:\s]+\d+/gi, "$1 [redacted]");
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        sandboxMode: agentAtStart.sandboxMode,
        networkAccess: agentAtStart.networkAccess,
      });
      const completedAt = now();
      const output = this.redactOutput(result.output, agentAtStart.workspacePath);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = this.redactOutput(
        error instanceof Error ? error.message : String(error),
        agentAtStart.workspacePath,
      );
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = cancelled ? "ready" : "error";
          }
          agent.lastError = cancelled ? null : message;
          agent.updatedAt = completedAt;
        }
      });
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
