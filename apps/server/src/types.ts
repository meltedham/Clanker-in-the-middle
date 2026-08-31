import type { RagSummary } from "./rag/types.js";

export type {
  RagStatus,
  RagSummary,
  RagSourceType,
  RagMatch,
  RagContext,
  EmbeddingClient,
} from "./rag/types.js";

export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type AgentStopReason = "budget_exhausted" | "manual" | "kill_switch";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

export const UNCLAIMED_OWNER_ID = "unclaimed";

/** "read-only" blocks every file write (Codex's own enforced sandbox, not
 * just an instruction); "workspace-write" allows writes within the
 * workspace (the platform default). No unrestricted option: Codex's own
 * `danger-full-access` mode is deliberately not exposed anywhere in this
 * type, the per-Agent schema, or the platform env config.
 * `networkAccess: false` runs the per-turn container with no network at
 * all, so anything requiring the internet (installing a dependency,
 * reaching an API) fails on its own -- neither of these is a per-command
 * allow/deny list; they're the two real, OS-enforced levers the Runtime
 * actually has. */
export type SandboxMode = "read-only" | "workspace-write";

export type UserRole = "admin" | "member";

/** The resolved caller identity for a request. Never carries a token.
 * `role` is "admin" for the very first user ever created on a fresh
 * instance (bootstrap), "member" for everyone after unless an existing
 * admin explicitly promotes them. Admins bypass ownership entirely. */
export interface AuthUser {
  id: string;
  name: string;
  role: UserRole;
}

/** Persisted principal. `tokenHash` is a sha256 hex digest; the plaintext
 * token is only ever returned once, at creation time. `passwordHash`, when
 * set, is a `salt:hash` scrypt digest (not sha256 -- passwords need a slow,
 * salted KDF to resist brute-force, unlike the already-high-entropy random
 * token). Only present for accounts that opted into password login;
 * enforces a unique `name` at creation time so login-by-name is
 * unambiguous. */
export interface User {
  id: string;
  name: string;
  tokenHash: string;
  passwordHash?: string;
  role: UserRole;
  createdAt: string;
}

/** Scoped, revocable delegated access to one Agent. "viewer" is read-only
 * (Agent details, messages, runs); "operator" also allows writes (edit,
 * start/stop, send messages). Owners and admins always have full access
 * regardless of any Grant. */
export type GrantRole = "viewer" | "operator";

export interface Grant {
  id: string;
  agentId: string;
  userId: string;
  role: GrantRole;
  createdAt: string;
  revokedAt: string | null;
}

/** What `listGrants` actually returns: real (revocable) Grants merged with
 * a synthetic, non-revocable "admin" entry for every admin user -- since
 * admins have full access to every Agent regardless of any Grant, showing
 * only explicit Grants would omit the people who most obviously have
 * access, and revoking a synthetic entry would do nothing anyway. */
export interface GrantView {
  id: string;
  userId: string;
  userName: string;
  role: GrantRole | "admin";
  revocable: boolean;
  createdAt: string;
}

/** The calling user's own relationship to one specific Agent -- computed
 * fresh per request, never stored. "owner"/"admin" have full access
 * unconditionally; "viewer"/"operator" come from an active Grant. `null`
 * only when no identity is configured at all (single-user baseline). */
export type EffectiveRole = "owner" | "admin" | GrantRole;

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  tokenBudget: number | null;
  status: AgentStatus;
  stopReason: AgentStopReason | null;
  ownerId: string;
  sandboxMode: SandboxMode;
  networkAccess: boolean;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  /** true if `output` was captured from an in-progress checkpoint rather than a natural completion. */
  partial: boolean;
  /** Opaque runner-owned identity (e.g. "container:launchpad-default-<id>" or "pid:1234") used to reconcile after a restart. */
  runnerHandle: string | null;
  /** The Run that delegated to this one via a `` ```delegate `` block, or null for a directly user-sent Run. */
  parentRunId: string | null;
  /**
   * The id of the `AuthUser` who originally triggered this delegation tree
   * (via `sendMessage`), or null under the single-user baseline where no
   * identity is configured at all. Set once, on the root Run, and never
   * copied onto its children -- delegation-target visibility is always
   * resolved by walking `parentRunId` up to the root and reading this,
   * exactly like `orchestrationIterationCount` above, so a delegated child
   * Run can only ever reach an Agent the ORIGINAL human actor could already
   * see, not whatever the delegating Agent's own owner can see.
   */
  actorId: string | null;
  /**
   * Set the moment this Run creates a child Run to delegate to, cleared once
   * that child resolves and this Run's own loop resumes. This is the durable
   * checkpoint that lets boot-time reconciliation tell "a leaf Run with no
   * live process" apart from "an orchestrator mid-wait with no live
   * process" -- both look identical as a bare `running` row otherwise -- and
   * lets it resume this Run once the child's fate is known, even across a
   * restart.
   */
  awaitingChildRunId: string | null;
  /**
   * Tree-wide count of delegation rounds so far, always read/written on the
   * root Run of the delegation tree (found by walking `parentRunId` up), so
   * the iteration safety cap applies across an entire orchestration chain,
   * not per-Run, and survives a restart.
   */
  orchestrationIterationCount: number;
  /** RAG retrieval summary for this Run's prompt, or null if retrieval wasn't applicable/found nothing. */
  retrieval: RagSummary | null;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  users: User[];
  grants: Grant[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
  sandboxMode?: SandboxMode | undefined;
  networkAccess?: boolean | undefined;
  tokenBudget?: number | null | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  sandboxMode?: SandboxMode | undefined;
  networkAccess?: boolean | undefined;
  tokenBudget?: number | null | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface SendMessageResult {
  run: AgentRun;
  message: Message;
  assistantMessage?: Message | undefined;
  retrieval: RagSummary;
}

export interface RunnerRequest {
  agentId: string;
  /** The AgentRun this execution belongs to. Runners don't need it themselves; it exists so runner middleware (e.g. an observability wrapper) can correlate its own side-channel data to the right Run without reaching into the store. */
  runId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  sandboxMode: SandboxMode;
  networkAccess: boolean;
}

/** Incremental progress reported while a Run is still executing. */
export interface RunnerProgress {
  /** Set once, as soon as Codex reports (or resumes) a thread id. */
  threadId?: string;
  /** Latest known agent_message text seen so far; overwrites previous values. */
  message?: string;
}

export interface RunnerCallbacks {
  /** Fired once, as soon as the runner has an identity for `reconcile()` to use later (before the process/container necessarily exits). */
  onHandle?: (handle: string) => void;
  /** Fired whenever new progress is parsed from the runner's output stream. */
  onProgress?: (progress: RunnerProgress) => void;
}

export interface ReconcileOutcome {
  /** true if the runner found the previous execution still alive at boot and reattached to it. */
  stillRunning: boolean;
  /** Human-readable explanation of what reconciliation found/did, always present. */
  reason: string;
  /**
   * Present only when reattachment ran the interrupted execution to a real,
   * natural completion (i.e. `stillRunning` was true and it then finished
   * successfully). When absent, the caller must fall back to whatever was
   * already checkpointed via `onProgress` before the interruption.
   */
  result?: RunnerResult;
}

export interface AgentRunner {
  run(request: RunnerRequest, callbacks?: RunnerCallbacks): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
  /**
   * Called on server boot for any Run that was left `queued`/`running` when the
   * process last stopped. `handle` is the `AgentRun.runnerHandle` recorded before
   * the interruption, or null if none was ever captured. `runId` is passed for
   * the same correlation reason as `RunnerRequest.runId`.
   */
  reconcile(
    agentId: string,
    handle: string | null,
    runId: string,
    callbacks?: RunnerCallbacks,
  ): Promise<ReconcileOutcome>;
}
