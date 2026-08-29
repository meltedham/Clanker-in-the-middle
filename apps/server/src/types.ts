export type AgentStatus = "ready" | "busy" | "stopped" | "error";
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
  status: AgentStatus;
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
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  sandboxMode?: SandboxMode | undefined;
  networkAccess?: boolean | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  sandboxMode: SandboxMode;
  networkAccess: boolean;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
