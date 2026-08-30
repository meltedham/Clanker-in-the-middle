import type { Agent, AgentRun } from "./types.js";

/** Maximum ancestor chain depth a delegation may reach (A -> B -> C -> ...). */
export const MAX_DELEGATION_DEPTH = 5;

/** Tree-wide cap on delegation rounds across an entire orchestration chain. */
export const MAX_ORCHESTRATION_ITERATIONS = 10;

/** Maximum number of new Agents a single `` ```create-agents `` block may request. */
export const MAX_AGENTS_PER_CREATE_BLOCK = 10;

export interface DelegationRequest {
  agentName: string;
  task: string;
}

export interface AgentCreationRequest {
  name: string;
  description?: string;
  instructions?: string;
}

/**
 * The exact contract text embedded in every Agent's AGENTS.md. Kept as one
 * shared constant so the instructions given to the model and the parser
 * that reads its output can never drift apart.
 */
export const DELEGATE_BLOCK_INSTRUCTIONS = [
  "## Delegating to other Agents",
  "",
  "You can hand off part of this task to another Agent in this workspace when",
  "it is a better fit for the sub-task, or when you need work done in that",
  "Agent's own workspace. To do this, end your ENTIRE response with exactly",
  "one fenced block, and write nothing after it:",
  "",
  "```delegate",
  "agent: <exact Agent name>",
  "task: <a clear, self-contained description of what you need done>",
  "```",
  "",
  "(A JSON object body -- {\"agent\": \"...\", \"task\": \"...\"} -- inside the same",
  "```delegate fence is also accepted, if that is more natural for you to",
  "produce.)",
  "",
  "This is a REAL mechanism, not a simulation -- the named Agent actually",
  "runs and its real output comes back to you. Never fabricate what another",
  "Agent would say, and never simulate a multi-agent workflow yourself with",
  "files or made-up output -- if the task calls for another Agent's help,",
  "use this block to actually ask it.",
  "",
  "You will be resumed automatically with that Agent's result as your next",
  "input, and can continue from there -- delegate again, or give your final",
  "answer. Do not delegate to yourself, and avoid creating a delegation loop",
  "(Agent A asking Agent B to ask Agent A again).",
].join("\n");

/**
 * The exact contract text for the sibling agent-creation mechanism. Kept
 * separate from `DELEGATE_BLOCK_INSTRUCTIONS` so each fenced block name
 * self-documents exactly one action, rather than overloading one block with
 * a discriminator field the model has to remember to set correctly.
 */
export const CREATE_AGENTS_BLOCK_INSTRUCTIONS = [
  "## Creating new Agents",
  "",
  "If this task genuinely needs a specialized Agent that does not exist yet",
  "in the roster below, you can create one -- or several at once -- instead",
  "of simulating its work yourself. End your ENTIRE response with exactly",
  "one fenced block containing a JSON array (a single JSON object is also",
  "fine for one Agent), and write nothing after it:",
  "",
  "```create-agents",
  '[{"name": "<Agent name>", "description": "<short purpose>", "instructions": "<optional, more detailed instructions for that Agent>"}]',
  "```",
  "",
  "This actually creates real, persistent Agents, each with their own",
  "workspace -- it is not a simulation. Do not invent fake agent files or",
  "pretend to create Agents yourself. Newly created Agents appear in the",
  "roster on your next turn and can then be handed work with a",
  "```delegate block. Do not recreate an Agent that already exists below.",
].join("\n");

// Requires the fence to be the last non-whitespace content in the output,
// so a chatty final answer that happens to include an unrelated code fence
// is never misparsed as a delegation directive.
const DELEGATE_BLOCK = /```delegate\s*\n([\s\S]*?)\n```\s*$/;

/**
 * Parses a trailing `` ```delegate `` block out of a Run's raw output.
 * Returns null (never throws) for absent, malformed, or non-trailing
 * blocks -- the caller treats null as "no delegation, this is the final
 * answer," so parsing always fails closed.
 *
 * Accepts two body formats: the documented `agent: X` / `task: Y` lines,
 * and a JSON object (`{"agent": "X", "task": "Y"}`) -- observed live that a
 * model will sometimes emit JSON for the block body despite the documented
 * format, since that's a common default for anything that looks like
 * structured parameters. Both are tried; either satisfies the contract.
 */
export function parseDelegation(output: string): DelegationRequest | null {
  const match = output.trim().match(DELEGATE_BLOCK);
  if (!match) return null;
  const body = (match[1] ?? "").trim();

  const lineFormat = parseLineFormat(body);
  if (lineFormat) return lineFormat;

  const jsonFormat = parseJsonFormat(body);
  if (jsonFormat) return jsonFormat;

  return null;
}

function parseLineFormat(body: string): DelegationRequest | null {
  const agentMatch = body.match(/^agent:\s*(.+)$/m);
  const taskMatch = body.match(/^task:\s*([\s\S]+)$/m);
  if (!agentMatch || !taskMatch) return null;
  const agentName = agentMatch[1]?.trim();
  const task = taskMatch[1]?.trim();
  if (!agentName || !task) return null;
  return { agentName, task };
}

function parseJsonFormat(body: string): DelegationRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const agentName = typeof record.agent === "string" ? record.agent.trim() : "";
  const task = typeof record.task === "string" ? record.task.trim() : "";
  if (!agentName || !task) return null;
  return { agentName, task };
}

// Same trailing-fence requirement as DELEGATE_BLOCK, for the same reason.
const CREATE_AGENTS_BLOCK = /```create-agents\s*\n([\s\S]*?)\n```\s*$/;

/**
 * Parses a trailing `` ```create-agents `` block out of a Run's raw output.
 * The body must be a JSON array of `{name, description?, instructions?}`
 * objects, or a single such object. Returns null (never throws) for
 * absent, malformed, or non-trailing blocks, or a body that parses but
 * yields zero valid entries (e.g. every item missing `name`) -- the caller
 * treats null as "not a creation request."
 */
export function parseAgentCreation(output: string): AgentCreationRequest[] | null {
  const match = output.trim().match(CREATE_AGENTS_BLOCK);
  if (!match) return null;
  const body = (match[1] ?? "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  const requests: AgentCreationRequest[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) continue;
    const request: AgentCreationRequest = { name };
    if (typeof record.description === "string" && record.description.trim()) {
      request.description = record.description.trim();
    }
    if (typeof record.instructions === "string" && record.instructions.trim()) {
      request.instructions = record.instructions.trim();
    }
    requests.push(request);
  }
  return requests.length > 0 ? requests : null;
}

/** Renders the current roster (self excluded) for embedding into AGENTS.md. */
export function formatRoster(selfAgentId: string, roster: Agent[]): string {
  const others = roster.filter((agent) => agent.id !== selfAgentId);
  if (others.length === 0) {
    return "No other Agents exist in this workspace yet -- there is no one to delegate to right now.";
  }
  return others
    .map((agent) => "- " + agent.name + ": " + (agent.description || "No description"))
    .join("\n");
}

export interface DelegationValidationError {
  reason: string;
}

/**
 * Walks the `parentRunId` chain starting at `run` (inclusive) and returns
 * the agentIds involved, oldest ancestor first, capped at
 * `MAX_DELEGATION_DEPTH` entries (a chain longer than that is itself treated
 * as a depth-limit violation by the caller).
 */
export function collectAncestorAgentIds(run: AgentRun, allRuns: AgentRun[]): string[] {
  const byId = new Map(allRuns.map((item) => [item.id, item]));
  const chain: string[] = [];
  let current: AgentRun | undefined = run;
  let guard = 0;
  while (current && guard <= MAX_DELEGATION_DEPTH) {
    chain.unshift(current.agentId);
    current = current.parentRunId ? byId.get(current.parentRunId) : undefined;
    guard += 1;
  }
  return chain;
}

/** Finds the root Run of a delegation tree by walking `parentRunId` up. */
export function findRootRun(run: AgentRun, allRuns: AgentRun[]): AgentRun {
  const byId = new Map(allRuns.map((item) => [item.id, item]));
  let current = run;
  let guard = 0;
  while (current.parentRunId && guard <= MAX_DELEGATION_DEPTH + 1) {
    const parent = byId.get(current.parentRunId);
    if (!parent) break;
    current = parent;
    guard += 1;
  }
  return current;
}
