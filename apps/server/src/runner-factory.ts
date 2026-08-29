import type { AppConfig } from "./config.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import { CodexRunner } from "./codex-runner.js";
import { ObservabilityRunner } from "./middleware/observability-runner.js";
import type { TraceWriter } from "./middleware/trace-store.js";
import type { AgentRunner } from "./types.js";

/**
 * Assembly point for the Agent Runtime: picks the concrete execution
 * profile (local process vs. disposable container), then wraps it in the
 * observability middleware so every runner -- regardless of profile --
 * gets tracing for free. `AgentService` only ever sees the returned
 * `AgentRunner`, never the concrete classes.
 */
export function createRunner(config: AppConfig, trace: TraceWriter): AgentRunner {
  const base =
    config.runtimeProvider === "container"
      ? new ContainerCodexRunner(config)
      : new CodexRunner(config);
  return new ObservabilityRunner(base, trace);
}
