import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isModelProviderConfigured } from "./config.js";
import {
  MAX_AGENTS_PER_CREATE_BLOCK,
  MAX_DELEGATION_DEPTH,
  MAX_ORCHESTRATION_ITERATIONS,
  collectAncestorAgentIds,
  findRootRun,
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
  CreateAgentInput,
  Message,
  RagContext,
  RagSummary,
  RunnerCallbacks,
  RunnerResult,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

type IterationOutcome = { kind: "final" } | { kind: "continue"; nextPrompt: string };
type FinalizeOutcome =
  | { kind: "success"; result: RunnerResult }
  | { kind: "error"; error: unknown };

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
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
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

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      status: "ready",
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

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated, this.listAgents());
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
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

  async listUploads(agentId: string): Promise<Array<{ name: string; size: number; updatedAt: string }>> {
    this.getAgent(agentId);
    return this.workspaces.listUploads(agentId);
  }

  async uploadAgentResource(
    agentId: string,
    input: UploadInput,
  ): Promise<{ name: string; size: number; updatedAt: string }> {
    this.getAgent(agentId);
    const content = (await normalizeUploadContent(input)).trim();
    return this.workspaces.writeUpload(agentId, input.name, content);
  }

  async deleteAgentUpload(agentId: string, name: string): Promise<void> {
    this.getAgent(agentId);
    await this.workspaces.deleteUpload(agentId, name);
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message; retrieval: RagSummary }> {
    if (!isModelProviderConfigured(this.config)) {
      throw new HttpError(
        503,
        "OpenRouter is not configured. Set OPENROUTER_API_KEY and OPENROUTER_MODEL, then restart.",
      );
    }
    const { run, message, agentAtStart, ragContext } = await this.createRunAtomic(agentId, prompt, null);
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
  ): Promise<{
    run: AgentRun;
    message: Message;
    agentAtStart: Agent;
    ragContext: Pick<RagContext, "prompt" | "summary">;
  }> {
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId: targetAgentId,
      status: "queued",
      prompt,
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
      content: prompt,
      createdAt: timestamp,
    };
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === targetAgentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
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
      if (parentRunId) {
        const storedParent = database.runs.find((item) => item.id === parentRunId);
        if (storedParent) storedParent.awaitingChildRunId = run.id;
      }
      return snapshot;
    });

    let ragContext: RagContext;
    try {
      ragContext = await this.ragService.buildContext(agentAtStart, prompt, runId);
    } catch {
      ragContext = {
        prompt,
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

    return { run, message, agentAtStart, ragContext };
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
   * this is ever called.
   */
  private async delegateToAgent(
    parentRun: AgentRun,
    targetAgent: Agent,
    task: string,
  ): Promise<AgentRun> {
    const { run: childRun, agentAtStart, ragContext } = await this.createRunAtomic(
      targetAgent.id,
      task,
      parentRun.id,
    );
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
      return { ok: false, reason: 'No Agent named "' + targetName + '" exists in this workspace.' };
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
      const summary = await this.handleAgentCreation(creationRequests);
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
  private async handleAgentCreation(requests: AgentCreationRequest[]): Promise<string> {
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
        await this.createAgent({
          name: request.name,
          description: request.description,
          instructions: request.instructions,
        });
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
        storedRun.status = "completed";
        storedRun.output = outcome.result.output;
        storedRun.usage = outcome.result.usage;
        storedRun.partial = false;
        storedRun.awaitingChildRunId = null;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId,
          role: "assistant",
          content: outcome.result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = outcome.result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
      return;
    }

    const cancelled = outcome.error instanceof RunCancelledError;
    const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === runId);
      const agent = database.agents.find((item) => item.id === agentId);
      if (storedRun) {
        storedRun.status = cancelled ? "cancelled" : "failed";
        storedRun.error = message;
        storedRun.awaitingChildRunId = null;
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
    await this.runOrchestrationLoop(run.agentId, run.id, ragContext.prompt, agentAtStart.codexThreadId);
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
    const workspacePath = this.getAgent(agentId).workspacePath;
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
          { agentId, runId, workspacePath, prompt, threadId },
          this.progressCallbacks(runId, agentId),
        );
      } catch (error) {
        await this.finalizeRun(runId, agentId, { kind: "error", error });
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
