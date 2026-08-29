import type { Agent, AgentRun } from "./types.js";

/** Maximum ancestor chain depth a delegation may reach (A -> B -> C -> ...). */
export const MAX_DELEGATION_DEPTH = 5;

/** Tree-wide cap on delegation rounds across an entire orchestration chain. */
export const MAX_ORCHESTRATION_ITERATIONS = 10;

export interface DelegationRequest {
  agentName: string;
  task: string;
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
  "You will be resumed automatically with that Agent's result as your next",
  "input, and can continue from there -- delegate again, or give your final",
  "answer. Do not delegate to yourself, and avoid creating a delegation loop",
  "(Agent A asking Agent B to ask Agent A again).",
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
 */
export function parseDelegation(output: string): DelegationRequest | null {
  const match = output.trim().match(DELEGATE_BLOCK);
  if (!match) return null;
  const body = match[1] ?? "";
  const agentMatch = body.match(/^agent:\s*(.+)$/m);
  const taskMatch = body.match(/^task:\s*([\s\S]+)$/m);
  if (!agentMatch || !taskMatch) return null;
  const agentName = agentMatch[1]?.trim();
  const task = taskMatch[1]?.trim();
  if (!agentName || !task) return null;
  return { agentName, task };
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
