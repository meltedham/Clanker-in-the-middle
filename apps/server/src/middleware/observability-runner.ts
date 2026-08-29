import { RunCancelledError } from "../errors.js";
import type {
  AgentRunner,
  ReconcileOutcome,
  RunnerCallbacks,
  RunnerRequest,
  RunnerResult,
} from "../types.js";
import { TraceWriter, truncate } from "./trace-store.js";

const now = () => new Date().toISOString();

/**
 * Observability middleware for the Agent Runtime boundary.
 *
 * Wraps any `AgentRunner` and mirrors its lifecycle -- every `onHandle`/
 * `onProgress` callback, plus the run's terminal outcome (`completed`,
 * `cancelled`, `error`) and every `reconcile()` decision -- into a persisted,
 * per-Run trace, without the wrapped runner or `AgentService` needing to
 * know tracing exists at all.
 *
 * Boundary: this class implements the same `AgentRunner` interface it wraps,
 * so it plugs in at the exact seam `AGENT_BRIEF.md` calls out as the place
 * for runtime-specific behavior ("keep the runner abstraction as the place
 * for runtime-specific behavior... this separation is a key architectural
 * seam"). `AgentService` (the Control Plane) only ever depends on the plain
 * `AgentRunner` type and is unaware whether it was handed a bare runner or
 * one wrapped in this middleware -- construction/composition happens once,
 * in `runner-factory.ts`.
 *
 * What crosses the boundary: the same `RunnerRequest`/`RunnerCallbacks`/
 * `RunnerResult`/`ReconcileOutcome` shapes `AgentService` already uses --
 * this middleware adds no new inputs or outputs, it only observes them.
 *
 * Failure containment: a trace-store write failure (disk full, permissions)
 * must never be able to turn a real, successful Agent Run into a failure,
 * or block cancellation. Every trace write here is best-effort --
 * `safeAppend()` swallows its own errors -- so the wrapped runner's actual
 * result or thrown error always propagates unchanged.
 */
export class ObservabilityRunner implements AgentRunner {
  constructor(
    private readonly inner: AgentRunner,
    private readonly trace: TraceWriter,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.inner.isAvailable();
  }

  async cancel(agentId: string): Promise<boolean> {
    return this.inner.cancel(agentId);
  }

  async run(request: RunnerRequest, callbacks?: RunnerCallbacks): Promise<RunnerResult> {
    const observedCallbacks = this.observe(request.runId, request.agentId, callbacks);
    try {
      const result = await this.inner.run(request, observedCallbacks);
      await this.safeAppend({
        runId: request.runId,
        agentId: request.agentId,
        type: "completed",
        occurredAt: now(),
        summary: "Run completed",
        detail: { usage: result.usage },
      });
      return result;
    } catch (error) {
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
      await this.safeAppend({
        runId: request.runId,
        agentId: request.agentId,
        type: cancelled ? "cancelled" : "error",
        occurredAt: now(),
        summary: message,
      });
      throw error;
    }
  }

  async reconcile(
    agentId: string,
    handle: string | null,
    runId: string,
    callbacks?: RunnerCallbacks,
  ): Promise<ReconcileOutcome> {
    const observedCallbacks = this.observe(runId, agentId, callbacks);
    const outcome = await this.inner.reconcile(agentId, handle, runId, observedCallbacks);
    await this.safeAppend({
      runId,
      agentId,
      type: "reconciliation",
      occurredAt: now(),
      summary: outcome.reason,
      detail: { stillRunning: outcome.stillRunning, recoveredResult: Boolean(outcome.result) },
    });
    return outcome;
  }

  /**
   * Returns a `RunnerCallbacks` that appends a trace event for every
   * `onHandle`/`onProgress` firing *and* still invokes the caller's own
   * callbacks -- so `AgentService`'s store checkpointing (Solution 1) keeps
   * working exactly as if this middleware weren't there.
   */
  private observe(runId: string, agentId: string, callbacks?: RunnerCallbacks): RunnerCallbacks {
    return {
      onHandle: (handle) => {
        callbacks?.onHandle?.(handle);
        void this.safeAppend({
          runId,
          agentId,
          type: "runner_attached",
          occurredAt: now(),
          summary: "Runner handle: " + handle,
        });
      },
      onProgress: (progress) => {
        callbacks?.onProgress?.(progress);
        if (progress.threadId) {
          void this.safeAppend({
            runId,
            agentId,
            type: "thread_started",
            occurredAt: now(),
            summary: "Thread started: " + progress.threadId,
          });
        }
        if (progress.message) {
          void this.safeAppend({
            runId,
            agentId,
            type: "agent_message",
            occurredAt: now(),
            summary: truncate(progress.message),
          });
        }
      },
    };
  }

  private async safeAppend(
    ...args: Parameters<TraceWriter["append"]>
  ): Promise<void> {
    try {
      await this.trace.append(...args);
    } catch {
      // Observability must never break the Run it's observing.
    }
  }
}
