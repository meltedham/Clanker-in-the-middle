import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isModelProviderConfigured } from "./config.js";
import {
  MAX_AGENTS_PER_CREATE_BLOCK,
  MAX_DELEGATION_DEPTH,
  MAX_ORCHESTRATION_ITERATIONS,
  collectAncestorAgentIds,
  findRootRun,
  formatRoster,
  parseAgentCreation,
  parseDelegation,
} from "./delegation.js";
import type { AgentCreationRequest } from "./delegation.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { RagService } from "./rag/rag-service.js";
import { normalizeUploadContent, type UploadInput } from "./rag/upload-content.js";
import { JsonStore } from "./store.js";
import { SharedResourceManager } from "./shared-resource-manager.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  AuthUser,
  CreateAgentInput,
  Database,
  EffectiveRole,
  Grant,
  GrantRole,
  GrantView,
  Message,
  RagContext,
  RagSummary,
  RunUsage,
  RunnerCallbacks,
  RunnerResult,
  SendMessageResult,
  UpdateAgentInput,
  UserRole,
} from "./types.js";
import { UNCLAIMED_OWNER_ID } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();
const countUsageTokens = (usage: RunUsage | null): number =>
  (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);

const totalAgentTokens = (database: Database, agentId: string): number =>
  database.runs
    .filter((run) => run.agentId === agentId)
    .reduce((total, run) => total + countUsageTokens(run.usage), 0);

const tokenBudgetExceededMessage =
  "Token usage is up. Agent paused until the budget is increased or set to unlimited.";
const agentBusyMessage =
  "This Agent is still working on the previous message. Please wait for it to finish.";

const dangerousPromptPatterns = [
  /\brm\s+-rf\b/i,
  /\bdelete\s+everything\s+in\s+the\s+repo\b/i,
  /\bwipe\s+(?:the\s+)?(?:workspace|repo|project|directory)\b/i,
  /\bshutdown\b|\breboot\b|\bpoweroff\b/i,
  /\bmkfs\b|\bdd\s+if=/i,
  /\b(?:curl|wget)\b.*\|\s*(?:bash|sh)/i,
];

type IterationOutcome = { kind: "final" } | { kind: "continue"; nextPrompt: string };
type FinalizeOutcome =
  | { kind: "success"; result: RunnerResult }
  | { kind: "error"; error: unknown };
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
 * behavior -- it's also how every internal/system call (boot reconciliation,
 * delegation's own roster lookups, etc.) reaches this, since those aren't
 * acting on behalf of any particular end user. Once identity is active,
 * every Agent-scoped operation reachable from an HTTP route is checked here
 * against, in order: admin bypass, ownership, then any active (non-revoked)
 * Grant. A "viewer" Grant only ever satisfies "read"; only "operator" (or
 * ownership/admin) satisfies "write". This is re-checked on every call, so
 * revoking a Grant takes effect on the very next request -- there is no
 * caching of a previously-resolved permission.
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

/**
 * Control Plane: Agent specification, validation, status, Run
 * orchestration, and reconciliation (matches the "Control Plane" row of the
 * layered architecture in bff.pdf/AGENT_BRIEF.md). This class only ever
 * depends on the plain `AgentRunner` interface -- it has no knowledge of,
 * and no dependency on, the observability middleware
 * (`middleware/observability-runner.ts`) that may or may not be wrapping
 * whatever runner it was constructed with. That composition happens once,
 * in `runner-factory.ts`.
 *
 * Multi-agent delegation: a Run's output may end with a `` ```delegate ``
 * block asking another Agent to do a sub-task. `executeRun` drives this as a
 * loop -- call the runner, check for a delegate block, and either finalize
 * or create+await a child Run and resume with its result -- entirely inside
 * this class. The runner/tracing layers never know delegation exists; every
 * loop iteration is just another ordinary `AgentRunner.run()` call.
 *
 * Identity and access control: `actor` (an `AuthUser`, or `null` for
 * internal/system calls and the single-user baseline) flows through every
 * Agent-scoped public method and is checked via `assertAccess`/
 * `isOwnerOrAdmin`. Enforcement only activates once `hasIdentityEnabled()`
 * is true -- i.e. once at least one user exists in the store, seeded or
 * self-registered.
 */
export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly ragService: RagService;
  private readonly sharedResources: SharedResourceManager;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
  ) {
    this.ragService = new RagService(config, store);
    this.sharedResources = new SharedResourceManager(config.sharedResourceRoot);
  }

  /**
   * Boot-time reconciliation. Interrupted Runs fall into two shapes:
   *
   * - Ordinary Runs (no `awaitingChildRunId`): reconciled directly via
   *   `reconcileRun`, exactly as before delegation existed.
   * - Orchestrators that were mid-delegation (`awaitingChildRunId` set):
   *   there is no live process to reattach to for *this* Run specifically
   *   (its own runner call already finished before it started waiting) --
   *   it can only be resolved once its child's own fate is known.
   *
   * This runs a small fixed-point sweep over the originally-interrupted set:
   * repeatedly resolve whatever isn't blocked on another still-unresolved
   * member of that same set, until a full pass makes no further progress.
   * This naturally handles delegation chains of any depth and any
   * insertion order without needing an explicit topological sort -- once a
   * blocking child resolves (by any means), its waiting parent becomes
   * resolvable on the very next sweep.
   */
  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.sharedResources.initialize();

    const interrupted = this.store
      .snapshot()
      .runs.filter((run) => run.status === "queued" || run.status === "running");
    const pending = new Set(interrupted.map((run) => run.id));

    let progressed = true;
    while (progressed && pending.size > 0) {
      progressed = false;
      for (const runId of Array.from(pending)) {
        const run = this.getRun(runId);
        if (run.status !== "running" && run.status !== "queued") {
          pending.delete(runId);
          progressed = true;
          continue;
        }
        if (run.awaitingChildRunId && pending.has(run.awaitingChildRunId)) {
          continue; // still blocked on an unresolved child; retry next sweep
        }
        if (run.awaitingChildRunId) {
          const child = this.getRun(run.awaitingChildRunId);
          if (child.status === "running" || child.status === "queued") {
            // Not actually resolved (shouldn't normally happen once it's out
            // of `pending`) -- fall back to a plain reconcile so this run
            // can't get stuck forever.
            await this.reconcileRun(run);
          } else {
            await this.resumeAfterChild(run, child);
          }
        } else {
          await this.reconcileRun(run);
        }
        pending.delete(runId);
        progressed = true;
      }
    }
    // Defensive cleanup: anything left (only possible with a corrupted
    // awaitingChildRunId cycle) still gets a terminal state rather than
    // being left "running" forever.
    for (const runId of pending) {
      await this.reconcileRun(this.getRun(runId));
    }

    await this.store.mutate((database) => {
      const validSandboxModes = ["read-only", "workspace-write"];
      for (const agent of database.agents) {
        if (agent.tokenBudget === undefined) {
          agent.tokenBudget = null;
        }
        if (agent.stopReason === undefined) {
          const budgetExceeded =
            agent.status === "stopped" &&
            agent.tokenBudget !== null &&
            totalAgentTokens(database, agent.id) >= agent.tokenBudget;
          agent.stopReason = budgetExceeded ? "budget_exhausted" : null;
        }
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.stopReason = null;
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
        // Back-compat: Agents created before ownership existed have no
        // `ownerId` in their stored JSON. Without this, `undefined` would
        // never match a real user's id in assertAccess -- the moment
        // identity activates, these Agents would become permanently
        // inaccessible to everyone but an admin. Falling back to the same
        // "unclaimed" sentinel a fresh Agent gets when created without an
        // owner keeps them visible platform-wide until someone claims them.
        if (typeof agent.ownerId !== "string" || agent.ownerId.length === 0) {
          agent.ownerId = UNCLAIMED_OWNER_ID;
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

  private async resumeAfterChild(run: AgentRun, child: AgentRun): Promise<void> {
    const agent = this.getAgent(run.agentId);
    const nextPrompt = this.synthesizeDelegationResultPrompt(this.getAgent(child.agentId).name, child);
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) storedRun.awaitingChildRunId = null;
    });
    await this.runOrchestrationLoop(run.agentId, run.id, nextPrompt, agent.codexThreadId);
  }

  /**
   * Called once per interrupted Run during boot for Runs that were NOT
   * waiting on a child (see `initialize`). Asks the runner whether the
   * execution behind this Run survived the restart; if it did, the
   * recovered output goes through the same finalize-vs-continue decision a
   * live loop iteration uses (`resolveIteration`), so a reattached process
   * that itself wanted to keep delegating resumes correctly instead of
   * having a raw `` ```delegate `` block presented as the final answer.
   * Otherwise, whatever was already checkpointed via `onProgress` before
   * the restart (partial output, a discovered thread id) is preserved, not
   * overwritten with a blank slate.
   */
  private async reconcileRun(run: AgentRun): Promise<void> {
    const callbacks = this.progressCallbacks(run.id, run.agentId);
    const outcome = await this.runner.reconcile(run.agentId, run.runnerHandle, run.id, callbacks);

    if (outcome.result) {
      const iterationOutcome = await this.resolveIteration(run.id, run.agentId, outcome.result);
      if (iterationOutcome.kind === "continue") {
        const agent = this.getAgent(run.agentId);
        await this.runOrchestrationLoop(run.agentId, run.id, iterationOutcome.nextPrompt, agent.codexThreadId);
      }
      return;
    }

    const completedAt = now();
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "cancelled";
        storedRun.error = outcome.reason;
        storedRun.awaitingChildRunId = null;
        storedRun.completedAt = completedAt;
        // storedRun.output / agent.codexThreadId are left exactly as the
        // progress callbacks above (or the interrupted run itself) already
        // set them -- reconciliation never blanks out a partial result.
      }
    });
  }

  /**
   * Shared onHandle/onProgress wiring used by both a live execution and
   * reconciliation of an interrupted one. This is purely store
   * checkpointing (Solution 1) -- it has no knowledge of tracing. Whatever
   * runner `this.runner` actually is may separately be observing these same
   * callback firings for its own purposes (see `ObservabilityRunner`); that
   * happens transparently, outside this class.
   */
  private progressCallbacks(runId: string, agentId: string): RunnerCallbacks {
    return {
      onHandle: (handle) => {
        void this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === runId);
          if (storedRun) storedRun.runnerHandle = handle;
        });
      },
      onProgress: (progress) => {
        void this.store.mutate((database) => {
          const storedRun = database.runs.find((item) => item.id === runId);
          const agent = database.agents.find((item) => item.id === agentId);
          if (progress.threadId && agent) {
            agent.codexThreadId = progress.threadId;
          }
          if (progress.message && storedRun) {
            storedRun.output = progress.message;
            storedRun.partial = true;
          }
        });
      },
    };
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
      tokenBudget: input.tokenBudget ?? null,
      status: "ready",
      stopReason: null,
      ownerId,
      sandboxMode: input.sandboxMode ?? this.config.codexSandboxMode,
      networkAccess: input.networkAccess ?? true,
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent, this.listAgents());
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
      if (input.tokenBudget !== undefined) {
        agent.tokenBudget = input.tokenBudget;
        // Raising (or lifting) the budget past what's already been spent
        // resumes an Agent that was auto-paused for running out -- but
        // never a manual Stop or the kill switch, which stay stopped until
        // someone explicitly starts the Agent again.
        const budgetAllowsRuns =
          input.tokenBudget === null || totalAgentTokens(database, id) < input.tokenBudget;
        if (agent.stopReason === "budget_exhausted" && budgetAllowsRuns) {
          agent.status = "ready";
          agent.stopReason = null;
        }
      }
      agent.lastError = agent.stopReason === "budget_exhausted" ? tokenBudgetExceededMessage : null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated, this.listAgents());
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

  async listSharedResources(): Promise<Array<{ name: string; size: number; updatedAt: string }>> {
    return this.sharedResources.list();
  }

  async uploadSharedResource(
    input: UploadInput,
  ): Promise<{ name: string; size: number; updatedAt: string }> {
    const content = (await normalizeUploadContent(input)).trim();
    return this.sharedResources.write(input.name, content);
  }

  async deleteSharedResource(name: string): Promise<void> {
    await this.sharedResources.delete(name);
  }

  async listUploads(
    agentId: string,
    actor: AuthUser | null = null,
  ): Promise<Array<{ name: string; size: number; updatedAt: string }>> {
    this.getAgent(agentId, actor, "read");
    return this.workspaces.listUploads(agentId);
  }

  async uploadAgentResource(
    agentId: string,
    input: UploadInput,
    actor: AuthUser | null = null,
  ): Promise<{ name: string; size: number; updatedAt: string }> {
    this.getAgent(agentId, actor, "write");
    const content = (await normalizeUploadContent(input)).trim();
    return this.workspaces.writeUpload(agentId, input.name, content);
  }

  async deleteAgentUpload(agentId: string, name: string, actor: AuthUser | null = null): Promise<void> {
    this.getAgent(agentId, actor, "write");
    await this.workspaces.deleteUpload(agentId, name);
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
    return this.setStatus(id, "stopped", "manual");
  }

  /**
   * A harder stop than `stopAgent`: forces the Agent to "stopped" and
   * clears its error immediately, without waiting for cancellation to
   * actually finish (fire-and-forget) -- a panic button for when the
   * underlying runner might be hung. Still cascades to any in-flight
   * delegated child via `cancelExecution`, and is gated the same as
   * `stopAgent` (owner/admin only) since it's equally destructive to
   * whatever someone else may have had running.
   */
  async killAgent(id: string, actor: AuthUser | null = null): Promise<Agent> {
    const current = this.getAgent(id, actor, "write");
    if (!this.isOwnerOrAdmin(current, actor)) {
      throw new HttpError(403, "Only the Agent's owner or an admin can force-stop it");
    }
    void this.cancelExecution(id).catch(() => undefined);
    const killedAt = now();
    return this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === id);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      storedAgent.status = "stopped";
      storedAgent.stopReason = "kill_switch";
      storedAgent.lastError = null;
      storedAgent.updatedAt = killedAt;
      return structuredClone(storedAgent);
    });
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
  ): Promise<SendMessageResult> {
    // Checked before any other precondition so a denied caller always sees
    // 403, never a hint about the platform's own configuration state (e.g.
    // whether OpenRouter is set up). Sending a message is a write: a
    // "viewer" Grant is not enough, only "operator" (or ownership/admin).
    this.getAgent(agentId, actor, "write");
    if (!isModelProviderConfigured(this.config)) {
      throw new HttpError(
        503,
        "OpenRouter is not configured. Set OPENROUTER_API_KEY and OPENROUTER_MODEL, then restart.",
      );
    }
    const outcome = await this.createRunAtomic(agentId, prompt, null);
    if (outcome.kind === "short-circuited") {
      // The Agent is over its token budget or already mid-run -- a real,
      // completed Run + assistant reply was still persisted (visible in
      // history like any other exchange), just without ever calling the
      // runner.
      return {
        run: outcome.run,
        message: outcome.message,
        assistantMessage: outcome.assistantMessage,
        retrieval: emptyRetrievalSummary(),
      };
    }
    const { run, message, agentAtStart, ragContext } = outcome;
    const execution = this.executeRun(agentAtStart, run, ragContext);
    this.trackExecution(agentId, execution);
    return { run, message, retrieval: ragContext.summary };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      openRouterConfigured: isModelProviderConfigured(this.config),
      openRouterBaseUrl: this.config.openRouterBaseUrl,
      openRouterModel: this.config.openRouterModel || null,
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

  /**
   * Creates a queued AgentRun + user Message and atomically marks the
   * target Agent busy, exactly as the original single-agent `sendMessage`
   * always did -- the busy/stopped check happens *inside* the same
   * `store.mutate` call that flips status to busy, since `JsonStore.mutate`
   * serializes everything through one queue and that's what makes the
   * check atomic. When `parentRunId` is set (a delegation), this also
   * atomically stamps `awaitingChildRunId` on the parent Run in the SAME
   * mutation, so there is never a window where the child exists but the
   * parent doesn't yet know it's waiting on it.
   */
  private async createRunAtomic(
    targetAgentId: string,
    prompt: string,
    parentRunId: string | null,
  ): Promise<
    | {
        kind: "started";
        run: AgentRun;
        message: Message;
        agentAtStart: Agent;
        ragContext: Pick<RagContext, "prompt" | "summary">;
      }
    | { kind: "short-circuited"; run: AgentRun; message: Message; assistantMessage: Message }
  > {
    const normalizedPrompt = prompt.trim();
    if (normalizedPrompt.length === 0) {
      throw new HttpError(400, "Prompt cannot be empty");
    }
    if (normalizedPrompt.length > this.config.maxPromptChars) {
      throw new HttpError(
        400,
        `Prompt exceeds the maximum length of ${this.config.maxPromptChars} characters`,
      );
    }
    if (dangerousPromptPatterns.some((pattern) => pattern.test(normalizedPrompt))) {
      throw new HttpError(400, "Prompt blocked by the runaway-execution safety policy.");
    }

    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId: targetAgentId,
      status: "queued",
      prompt: normalizedPrompt,
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
      partial: false,
      runnerHandle: null,
      parentRunId,
      awaitingChildRunId: null,
      orchestrationIterationCount: 0,
      retrieval: null,
    };
    const message: Message = {
      id: randomUUID(),
      agentId: targetAgentId,
      runId,
      role: "user",
      content: normalizedPrompt,
      createdAt: timestamp,
    };

    type MutateResult =
      | { kind: "short-circuited"; run: AgentRun; assistantMessage: Message }
      | { kind: "started"; agentAtStart: Agent };

    const result: MutateResult = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === targetAgentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      const budgetExceeded =
        storedAgent.tokenBudget !== null &&
        totalAgentTokens(database, targetAgentId) >= storedAgent.tokenBudget;
      if (budgetExceeded) {
        const completedRun: AgentRun = {
          ...run,
          status: "completed",
          output: tokenBudgetExceededMessage,
          startedAt: timestamp,
          completedAt: timestamp,
        };
        const assistantMessage: Message = {
          id: randomUUID(),
          agentId: targetAgentId,
          runId,
          role: "assistant",
          content: tokenBudgetExceededMessage,
          createdAt: timestamp,
        };
        database.runs.push(completedRun);
        database.messages.push(message, assistantMessage);
        storedAgent.status = "stopped";
        storedAgent.stopReason = "budget_exhausted";
        storedAgent.lastError = tokenBudgetExceededMessage;
        storedAgent.updatedAt = timestamp;
        return { kind: "short-circuited", run: completedRun, assistantMessage };
      }
      if (storedAgent.status === "busy") {
        const completedRun: AgentRun = {
          ...run,
          status: "completed",
          output: agentBusyMessage,
          startedAt: timestamp,
          completedAt: timestamp,
        };
        const assistantMessage: Message = {
          id: randomUUID(),
          agentId: targetAgentId,
          runId,
          role: "assistant",
          content: agentBusyMessage,
          createdAt: timestamp,
        };
        database.runs.push(completedRun);
        database.messages.push(message, assistantMessage);
        storedAgent.lastError = agentBusyMessage;
        storedAgent.updatedAt = timestamp;
        return { kind: "short-circuited", run: completedRun, assistantMessage };
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      database.runs.push(run);
      database.messages.push(message);
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      if (parentRunId) {
        const storedParent = database.runs.find((item) => item.id === parentRunId);
        if (storedParent) storedParent.awaitingChildRunId = run.id;
      }
      return { kind: "started", agentAtStart: snapshot };
    });

    if (result.kind === "short-circuited") {
      return {
        kind: "short-circuited",
        run: result.run,
        message,
        assistantMessage: result.assistantMessage,
      };
    }

    let ragContext: RagContext;
    try {
      ragContext = await this.ragService.buildContext(result.agentAtStart, normalizedPrompt, runId);
    } catch {
      ragContext = {
        prompt: normalizedPrompt,
        matches: [],
        summary: emptyRetrievalSummary(),
      };
    }
    run.retrieval = ragContext.summary;
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.retrieval = ragContext.summary;
      }
    });

    return { kind: "started", run, message, agentAtStart: result.agentAtStart, ragContext };
  }

  private trackExecution(agentId: string, execution: Promise<void>): void {
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
  }

  /**
   * Creates a child Run tagged with `parentRunId` and runs it to completion,
   * reusing the exact same `executeRun`/reconciliation pipeline as any
   * other Run -- the child (and, recursively, anything it delegates to
   * further) is fully crash-resilient on its own, with zero special-casing.
   * A child can itself be an orchestrator; recursion is bounded by
   * `MAX_DELEGATION_DEPTH`, enforced in `validateDelegationTarget` before
   * this is ever called. This is an internal, system-driven Run (one Agent
   * asking another for help), so it deliberately never checks `actor`
   * access -- the top-level user request that started the parent Run
   * already passed that check once.
   *
   * If the target turns out to be busy or over its token budget in the
   * narrow race window after `validateDelegationTarget` already checked it,
   * `createRunAtomic` still returns a real, persisted "short-circuited" Run
   * (never throws for these two cases) -- that reads to the caller exactly
   * like an ordinary completed delegation whose answer happens to be a
   * busy/budget notice, so no special-casing is needed here either.
   */
  private async delegateToAgent(
    parentRun: AgentRun,
    targetAgent: Agent,
    task: string,
  ): Promise<AgentRun> {
    const outcome = await this.createRunAtomic(targetAgent.id, task, parentRun.id);
    if (outcome.kind === "short-circuited") {
      return outcome.run;
    }
    const { run: childRun, agentAtStart, ragContext } = outcome;
    const execution = this.executeRun(agentAtStart, childRun, ragContext);
    this.trackExecution(targetAgent.id, execution);
    await execution;
    return this.getRun(childRun.id);
  }

  private async validateDelegationTarget(
    parentRun: AgentRun,
    targetName: string,
  ): Promise<{ ok: true; target: Agent } | { ok: false; reason: string }> {
    const roster = this.listAgents();
    const target = roster.find(
      (agent) => agent.name.trim().toLowerCase() === targetName.trim().toLowerCase(),
    );
    if (!target) {
      // A resumed Codex thread does not reliably re-read AGENTS.md on every
      // turn -- it can keep answering from whatever roster was loaded on
      // the thread's first turn, even though the file on disk is already
      // current (confirmed live: a freshly created Agent was invisible to
      // an in-progress thread despite AGENTS.md already listing it). Embed
      // the real, current roster directly in the rejection itself so the
      // model recovers from live conversation state, not a file it may not
      // revisit.
      return {
        ok: false,
        reason:
          'No Agent named "' +
          targetName +
          '" exists. The current roster is:\n' +
          formatRoster(parentRun.agentId, roster),
      };
    }
    if (target.id === parentRun.agentId) {
      return { ok: false, reason: "You cannot delegate to yourself." };
    }
    if (target.status === "stopped") {
      return {
        ok: false,
        reason: 'Agent "' + target.name + '" is stopped. Start it before delegating to it.',
      };
    }
    if (target.status === "busy") {
      return {
        ok: false,
        reason:
          'Agent "' +
          target.name +
          '" is currently busy with another task. Try again later or pick a different Agent.',
      };
    }
    const allRuns = this.store.snapshot().runs;
    const ancestorAgentIds = collectAncestorAgentIds(parentRun, allRuns);
    if (ancestorAgentIds.length > MAX_DELEGATION_DEPTH) {
      return {
        ok: false,
        reason:
          "Delegation depth limit (" + MAX_DELEGATION_DEPTH + ") reached; finish without delegating further.",
      };
    }
    if (ancestorAgentIds.includes(target.id)) {
      return {
        ok: false,
        reason:
          'Delegating to "' +
          target.name +
          '" would create a delegation loop (it is already an ancestor of this task).',
      };
    }
    return { ok: true, target };
  }

  /**
   * Reserves one round of the tree-wide iteration budget, always tracked on
   * the delegation tree's root Run. This is checked on EVERY loop
   * iteration -- not just successful delegations -- so a persistently
   * confused Agent that keeps attempting (and having rejected) an invalid
   * delegation still eventually hits the cap instead of looping forever
   * without ever creating a real child Run.
   */
  private async reserveOrchestrationIteration(runId: string): Promise<boolean> {
    const run = this.getRun(runId);
    const allRuns = this.store.snapshot().runs;
    const root = findRootRun(run, allRuns);
    if (root.orchestrationIterationCount >= MAX_ORCHESTRATION_ITERATIONS) {
      return false;
    }
    await this.store.mutate((database) => {
      const storedRoot = database.runs.find((item) => item.id === root.id);
      if (storedRoot) storedRoot.orchestrationIterationCount += 1;
    });
    return true;
  }

  private synthesizeFailurePrompt(reason: string): string {
    return (
      "[Delegation could not proceed]\n" +
      reason +
      "\nContinue the task yourself, or try delegating to a different Agent."
    );
  }

  private synthesizeDelegationResultPrompt(targetName: string, childRun: AgentRun): string {
    if (childRun.status === "completed") {
      return "[Result from " + targetName + "]\n" + (childRun.output ?? "(no output)");
    }
    return (
      "[" +
      targetName +
      " did not complete the task: " +
      (childRun.error ?? childRun.status) +
      "]\nContinue the task yourself, or try a different approach."
    );
  }

  /**
   * Given a RunnerResult that just came back -- either from a live
   * `runner.run()` call in the loop below, or recovered via `reconcile()`'s
   * reattachment -- decides whether it's the orchestrator's final answer,
   * an agent-creation request, or another delegation round. Shared by both
   * paths so a reattached process's recovered output is never blindly
   * presented to the user without checking for a trailing directive block
   * first.
   */
  private async resolveIteration(
    runId: string,
    agentId: string,
    result: RunnerResult,
  ): Promise<IterationOutcome> {
    const creationRequests = parseAgentCreation(result.output);
    if (creationRequests) {
      // Sub-agents spawned by an orchestrator inherit its owner, so the
      // user who owns the orchestrator still has (and only they have, once
      // identity is active) management access to whatever it spins up.
      const ownerId = this.getAgent(agentId).ownerId;
      const summary = await this.handleAgentCreation(creationRequests, ownerId);
      return { kind: "continue", nextPrompt: summary };
    }

    const delegation = parseDelegation(result.output);
    if (!delegation) {
      await this.finalizeRun(runId, agentId, { kind: "success", result });
      return { kind: "final" };
    }

    const run = this.getRun(runId);
    const validation = await this.validateDelegationTarget(run, delegation.agentName);
    if (!validation.ok) {
      await this.clearAwaitingChild(runId);
      return { kind: "continue", nextPrompt: this.synthesizeFailurePrompt(validation.reason) };
    }

    try {
      const childRun = await this.delegateToAgent(run, validation.target, delegation.task);
      return {
        kind: "continue",
        nextPrompt: this.synthesizeDelegationResultPrompt(validation.target.name, childRun),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: "continue",
        nextPrompt: this.synthesizeFailurePrompt(
          "Could not delegate to " + delegation.agentName + ": " + message,
        ),
      };
    } finally {
      await this.clearAwaitingChild(runId);
    }
  }

  /**
   * Actually creates the requested Agents (reusing the ordinary
   * `createAgent` path, so each gets a real workspace/AGENTS.md exactly
   * like one created through the UI), skipping any name that already
   * exists in the roster (case-insensitive) rather than creating a
   * confusing duplicate an exact-name `` ```delegate `` lookup couldn't
   * disambiguate. Returns a summary to feed back as the orchestrator's
   * next prompt; never throws -- a per-item failure is reported in the
   * summary instead of aborting the whole batch.
   */
  private async handleAgentCreation(requests: AgentCreationRequest[], ownerId: string): Promise<string> {
    const capped = requests.slice(0, MAX_AGENTS_PER_CREATE_BLOCK);
    const overflow = requests.length - capped.length;
    const created: string[] = [];
    const skipped: string[] = [];

    for (const request of capped) {
      const existing = this.listAgents().find(
        (agent) => agent.name.trim().toLowerCase() === request.name.trim().toLowerCase(),
      );
      if (existing) {
        skipped.push(request.name + " (already exists)");
        continue;
      }
      try {
        await this.createAgent(
          {
            name: request.name,
            description: request.description,
            instructions: request.instructions,
          },
          ownerId,
        );
        created.push(request.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        skipped.push(request.name + " (failed: " + message + ")");
      }
    }

    const lines = ["[Agent creation result]"];
    if (created.length > 0) lines.push("Created: " + created.join(", "));
    if (skipped.length > 0) lines.push("Skipped: " + skipped.join(", "));
    if (overflow > 0) {
      lines.push(
        overflow + " additional Agent(s) were not created (limit is " + MAX_AGENTS_PER_CREATE_BLOCK + " per request).",
      );
    }
    lines.push(
      "Continue the task -- you can now delegate to any newly created Agent with a ```delegate block.",
    );
    return lines.join("\n");
  }

  private async clearAwaitingChild(runId: string): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      if (storedRun) storedRun.awaitingChildRunId = null;
    });
  }

  private async finalizeRun(runId: string, agentId: string, outcome: FinalizeOutcome): Promise<void> {
    const completedAt = now();
    if (outcome.kind === "success") {
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === runId);
        const agent = database.agents.find((item) => item.id === agentId);
        if (!storedRun || !agent) return;
        const output = this.redactOutput(outcome.result.output, agent.workspacePath);
        // Computed before storedRun.usage is overwritten below, so this
        // Run's own tokens are counted exactly once (totalAgentTokens sums
        // over database.runs, which doesn't yet reflect this completion).
        const completedTokens = countUsageTokens(outcome.result.usage);
        const totalTokens = totalAgentTokens(database, agent.id) + completedTokens;
        const budgetExceeded = agent.tokenBudget !== null && totalTokens >= agent.tokenBudget;
        storedRun.status = "completed";
        storedRun.output = output;
        storedRun.usage = outcome.result.usage;
        storedRun.partial = false;
        storedRun.awaitingChildRunId = null;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId,
          role: "assistant",
          content: output,
          createdAt: completedAt,
        });
        agent.status = budgetExceeded ? "stopped" : "ready";
        agent.stopReason = budgetExceeded ? "budget_exhausted" : null;
        agent.codexThreadId = outcome.result.threadId;
        agent.lastError = budgetExceeded ? tokenBudgetExceededMessage : null;
        agent.updatedAt = completedAt;
      });
      return;
    }

    const cancelled = outcome.error instanceof RunCancelledError;
    const rawMessage = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      const agent = database.agents.find((item) => item.id === agentId);
      const message = agent ? this.redactOutput(rawMessage, agent.workspacePath) : rawMessage;
      if (storedRun) {
        storedRun.status = cancelled ? "cancelled" : "failed";
        storedRun.error = message;
        storedRun.awaitingChildRunId = null;
        storedRun.completedAt = completedAt;
      }
      if (agent) {
        if (agent.status !== "stopped") {
          agent.status = cancelled ? "ready" : "error";
          agent.stopReason = null;
        }
        agent.lastError = cancelled ? null : message;
        agent.updatedAt = completedAt;
      }
    });
  }

  private async executeRun(
    agentAtStart: Agent,
    run: AgentRun,
    ragContext: Pick<RagContext, "prompt" | "summary">,
  ): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
      }
    });
    const initialPrompt = this.withFreshRosterReminder(agentAtStart, ragContext.prompt);
    await this.runOrchestrationLoop(run.agentId, run.id, initialPrompt, agentAtStart.codexThreadId);
  }

  /**
   * A resumed Codex thread does not reliably re-read AGENTS.md on every
   * turn -- confirmed live, it can keep answering delegation questions from
   * whatever roster it saw on the thread's very first turn, even once the
   * file on disk is already current (e.g. a freshly created Agent was
   * invisible to an in-flight thread despite AGENTS.md already listing
   * it). Only matters for a RESUMED thread -- a brand-new one reads
   * AGENTS.md fresh as part of starting up -- and only when there's
   * actually another Agent to delegate to.
   */
  private withFreshRosterReminder(agentAtStart: Agent, prompt: string): string {
    if (!agentAtStart.codexThreadId) return prompt;
    const roster = this.listAgents();
    if (roster.length <= 1) return prompt;
    return (
      "[Current Agent roster -- this may have changed since your last turn]\n" +
      formatRoster(agentAtStart.id, roster) +
      "\n\n" +
      prompt
    );
  }

  /**
   * Drives one Run's turns: call the runner, decide (via `resolveIteration`)
   * whether that was the final answer or a delegation round, and if it was
   * a delegation, resume on the same Codex thread with the child's result
   * as the next prompt. Also used directly by boot-time resumption
   * (`resumeAfterChild`/`reconcileRun`) to continue a Run from wherever it
   * left off, not just from a brand-new user message.
   */
  private async runOrchestrationLoop(
    agentId: string,
    runId: string,
    initialPrompt: string,
    initialThreadId: string | null,
  ): Promise<void> {
    const agentSnapshot = this.getAgent(agentId);
    const workspacePath = agentSnapshot.workspacePath;
    const sandboxMode = agentSnapshot.sandboxMode;
    const networkAccess = agentSnapshot.networkAccess;
    let prompt = initialPrompt;
    let threadId = initialThreadId;

    for (;;) {
      if (this.cancellationRequests.has(agentId)) {
        await this.finalizeRun(runId, agentId, { kind: "error", error: new RunCancelledError() });
        return;
      }

      // Every round -- delegating or not, valid or rejected -- consumes one
      // unit of the tree-wide budget, so a persistently confused Agent that
      // keeps attempting an invalid delegation still eventually stops
      // instead of looping forever without ever creating a real child Run.
      if (!(await this.reserveOrchestrationIteration(runId))) {
        await this.finalizeRun(runId, agentId, {
          kind: "success",
          result: {
            output: "(Orchestration round limit reached before a final answer was produced.)",
            threadId,
            usage: null,
          },
        });
        return;
      }

      // Keep AGENTS.md (roster + delegation contract) current for every turn.
      await this.workspaces.writeInstructions(this.getAgent(agentId), this.listAgents());

      let result: RunnerResult;
      try {
        result = await this.runner.run(
          { agentId, runId, workspacePath, prompt, threadId, sandboxMode, networkAccess },
          this.progressCallbacks(runId, agentId),
        );
      } catch (error) {
        await this.finalizeRun(runId, agentId, { kind: "error", error });
        return;
      }
      // Re-checked here, not just at the top of the loop: a kill/stop
      // requested while this exact runner.run() call was already in
      // flight would otherwise go unnoticed once it resolves successfully
      // -- the caller explicitly asked to abort, so a late-arriving result
      // must still finalize as cancelled, not be presented as a normal
      // completion.
      if (this.cancellationRequests.has(agentId)) {
        await this.finalizeRun(runId, agentId, { kind: "error", error: new RunCancelledError() });
        return;
      }
      // Always the thread this call actually used/produced -- never the
      // pre-run snapshot -- so a resumed second round continues the right
      // Codex thread instead of silently restarting from the first one.
      threadId = result.threadId;

      const outcome = await this.resolveIteration(runId, agentId, result);
      if (outcome.kind === "final") return;
      prompt = outcome.nextPrompt;
    }
  }

  private async setStatus(
    id: string,
    status: Agent["status"],
    stopReason: Agent["stopReason"] = null,
  ): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      agent.stopReason = status === "stopped" ? stopReason : null;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      // If this agent's active Run is an orchestrator currently waiting on
      // a child, cancelling only the parent leaves the child running
      // forever underneath it -- propagate the cancellation down first.
      const active = this.store
        .snapshot()
        .runs.find(
          (run) => run.agentId === agentId && (run.status === "running" || run.status === "queued"),
        );
      if (active?.awaitingChildRunId) {
        const child = this.store.snapshot().runs.find((run) => run.id === active.awaitingChildRunId);
        if (child && (child.status === "running" || child.status === "queued")) {
          await this.cancelExecution(child.agentId);
        }
      }
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}

function emptyRetrievalSummary(): RagSummary {
  return {
    status: "no_context",
    confidence: 0,
    topScore: null,
    candidateCount: 0,
    matchCount: 0,
  };
}
