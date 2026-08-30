import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Database,
  Message,
  RunUsage,
  SendMessageResult,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();
const countUsageTokens = (usage: RunUsage | null): number =>
  (usage?.inputTokens ?? 0) + (usage?.cachedInputTokens ?? 0) + (usage?.outputTokens ?? 0);

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
      for (const agent of database.agents) {
        if (agent.tokenBudget === undefined) {
          agent.tokenBudget = null;
        }
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
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
      tokenBudget: input.tokenBudget ?? null,
      status: "ready",
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
      if (input.tokenBudget !== undefined) agent.tokenBudget = input.tokenBudget;
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
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

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  async killAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    void this.cancelExecution(id).catch(() => undefined);
    const killedAt = now();
    return this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === id);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      storedAgent.status = "stopped";
      storedAgent.lastError = null;
      storedAgent.updatedAt = killedAt;
      return structuredClone(storedAgent);
    });
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
  ): Promise<SendMessageResult> {
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
      throw new HttpError(
        400,
        "Prompt blocked by the runaway-execution safety policy.",
      );
    }
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
      prompt: normalizedPrompt,
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
    let exhaustedRun: AgentRun | null = null;
    let exhaustedNotice: Message | null = null;
    let busyRun: AgentRun | null = null;
    let busyNotice: Message | null = null;
    const budgetNotice = (completedAt: string): Message => ({
      id: randomUUID(),
      agentId,
      runId,
      role: "assistant",
      content: tokenBudgetExceededMessage,
      createdAt: completedAt,
    });
    const busyReply = (completedAt: string): Message => ({
      id: randomUUID(),
      agentId,
      runId,
      role: "assistant",
      content: agentBusyMessage,
      createdAt: completedAt,
    });
    const agentAtStart = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      const budgetExceeded =
        storedAgent.tokenBudget !== null &&
        totalAgentTokens(database, agentId) >= storedAgent.tokenBudget;
      if (budgetExceeded) {
        exhaustedNotice = budgetNotice(timestamp);
        exhaustedRun = {
          ...run,
          status: "completed",
          output: tokenBudgetExceededMessage,
          error: null,
          usage: null,
          startedAt: timestamp,
          completedAt: timestamp,
        };
        database.runs.push({
          ...run,
          status: "completed",
          output: tokenBudgetExceededMessage,
          error: null,
          usage: null,
          startedAt: timestamp,
          completedAt: timestamp,
        });
        database.messages.push(message, exhaustedNotice);
        storedAgent.status = "stopped";
        storedAgent.lastError = tokenBudgetExceededMessage;
        storedAgent.updatedAt = timestamp;
        return structuredClone(storedAgent);
      }
      if (storedAgent.status === "busy") {
        busyNotice = busyReply(timestamp);
        busyRun = {
          ...run,
          status: "completed",
          output: agentBusyMessage,
          error: null,
          usage: null,
          startedAt: timestamp,
          completedAt: timestamp,
        };
        database.runs.push({
          ...run,
          status: "completed",
          output: agentBusyMessage,
          error: null,
          usage: null,
          startedAt: timestamp,
          completedAt: timestamp,
        });
        database.messages.push(message, busyNotice);
        storedAgent.lastError = agentBusyMessage;
        storedAgent.updatedAt = timestamp;
        return structuredClone(storedAgent);
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
      return snapshot;
    });
    if (exhaustedRun && exhaustedNotice) {
      return { run: exhaustedRun, message, assistantMessage: exhaustedNotice };
    }
    if (busyRun && busyNotice) {
      return { run: busyRun, message, assistantMessage: busyNotice };
    }
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
      });
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        const completedTokens = countUsageTokens(result.usage);
        const totalTokens = totalAgentTokens(database, agent.id) + completedTokens;
        const budgetExceeded =
          agent.tokenBudget !== null && totalTokens >= agent.tokenBudget;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = budgetExceeded ? "stopped" : "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = budgetExceeded ? tokenBudgetExceededMessage : null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const cancelled = error instanceof RunCancelledError;
      const message = error instanceof Error ? error.message : String(error);
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
