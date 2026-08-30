export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type AgentStopReason = "budget_exhausted" | "manual" | "kill_switch";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type SandboxMode = "read-only" | "workspace-write";
export type EffectiveRole = "owner" | "admin" | "viewer" | "operator";

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
  // Computed per-request server-side: your own relationship to this
  // specific Agent, not stored data. null only when no identity exists at
  // all (single-user baseline).
  myRole: EffectiveRole | null;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  createdAt: string;
  /** true if `output` was captured from an in-progress checkpoint rather than a natural completion. */
  partial?: boolean;
  /** The Run that delegated to this one, if any -- not currently rendered anywhere in the UI. */
  parentRunId?: string | null;
  retrieval: {
    status: "no_context" | "weak" | "moderate" | "strong";
    confidence: number;
    topScore: number | null;
    candidateCount: number;
    matchCount: number;
  } | null;
}

export type RunEventType =
  | "runner_attached"
  | "thread_started"
  | "agent_message"
  | "turn_completed"
  | "error"
  | "cancelled"
  | "completed"
  | "reconciliation";

export interface RunEvent {
  seq: number;
  runId: string;
  agentId: string;
  type: RunEventType;
  occurredAt: string;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface ResourceSummary {
  name: string;
  size: number;
  updatedAt: string;
}

export interface SystemInfo {
  openRouterConfigured: boolean;
  openRouterBaseUrl: string;
  openRouterModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
}
