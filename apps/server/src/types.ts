export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
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
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  /** The AgentRun this execution belongs to. Runners don't need it themselves; it exists so runner middleware (e.g. an observability wrapper) can correlate its own side-channel data to the right Run without reaching into the store. */
  runId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
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
