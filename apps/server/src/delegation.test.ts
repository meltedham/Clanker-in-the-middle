import { describe, expect, it } from "vitest";
import {
  MAX_DELEGATION_DEPTH,
  collectAncestorAgentIds,
  findRootRun,
  formatRoster,
  parseDelegation,
} from "./delegation.js";
import type { Agent, AgentRun } from "./types.js";

function makeRun(overrides: Partial<AgentRun> & { id: string; agentId: string }): AgentRun {
  return {
    status: "completed",
    prompt: "task",
    output: "done",
    error: null,
    usage: null,
    startedAt: null,
    completedAt: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    partial: false,
    runnerHandle: null,
    parentRunId: null,
    awaitingChildRunId: null,
    orchestrationIterationCount: 0,
    ...overrides,
  };
}

describe("parseDelegation", () => {
  it("parses a well-formed trailing delegate block", () => {
    const output = "I'll ask the Researcher.\n\n```delegate\nagent: Researcher\ntask: find X\n```";
    expect(parseDelegation(output)).toEqual({ agentName: "Researcher", task: "find X" });
  });

  it("returns null when there is no delegate block", () => {
    expect(parseDelegation("Just a normal final answer.")).toBeNull();
  });

  it("returns null when the block is not the last thing in the output", () => {
    const output = "```delegate\nagent: Researcher\ntask: find X\n```\n\nOne more thought after.";
    expect(parseDelegation(output)).toBeNull();
  });

  it("does not misparse an unrelated trailing code fence", () => {
    const output = "Here is the answer:\n\n```python\nprint('delegate')\n```";
    expect(parseDelegation(output)).toBeNull();
  });

  it("returns null when agent or task fields are missing", () => {
    expect(parseDelegation("```delegate\nagent: Researcher\n```")).toBeNull();
    expect(parseDelegation("```delegate\ntask: find X\n```")).toBeNull();
    expect(parseDelegation("```delegate\n```")).toBeNull();
  });

  it("never throws on garbage input", () => {
    expect(() => parseDelegation("")).not.toThrow();
    expect(() => parseDelegation("```delegate")).not.toThrow();
  });

  it("supports a multi-line task", () => {
    const output = "```delegate\nagent: Writer\ntask: line one\nline two\n```";
    expect(parseDelegation(output)).toEqual({
      agentName: "Writer",
      task: "line one\nline two",
    });
  });
});

describe("formatRoster", () => {
  const roster: Agent[] = [
    {
      id: "a",
      name: "Orchestrator",
      description: "",
      instructions: "",
      status: "ready",
      workspacePath: "/a",
      codexThreadId: null,
      lastError: null,
      createdAt: "",
      updatedAt: "",
    },
    {
      id: "b",
      name: "Researcher",
      description: "Finds things",
      instructions: "",
      status: "ready",
      workspacePath: "/b",
      codexThreadId: null,
      lastError: null,
      createdAt: "",
      updatedAt: "",
    },
  ];

  it("excludes self and shows description", () => {
    const text = formatRoster("a", roster);
    expect(text).not.toContain("Orchestrator");
    expect(text).toContain("Researcher: Finds things");
  });

  it("explains there is no one to delegate to when alone", () => {
    expect(formatRoster("a", [roster[0]!])).toMatch(/no other agents/i);
  });
});

describe("collectAncestorAgentIds / findRootRun", () => {
  it("walks a simple chain oldest-first", () => {
    const runs: AgentRun[] = [
      makeRun({ id: "r1", agentId: "A" }),
      makeRun({ id: "r2", agentId: "B", parentRunId: "r1" }),
      makeRun({ id: "r3", agentId: "C", parentRunId: "r2" }),
    ];
    expect(collectAncestorAgentIds(runs[2]!, runs)).toEqual(["A", "B", "C"]);
    expect(findRootRun(runs[2]!, runs).id).toBe("r1");
  });

  it("caps the walk at MAX_DELEGATION_DEPTH even on a corrupted/cyclic chain", () => {
    // Deliberately cyclic parentRunId links -- collectAncestorAgentIds must
    // never loop forever even if the store ever ended up in a bad state.
    const runs: AgentRun[] = [
      makeRun({ id: "r1", agentId: "A", parentRunId: "r2" }),
      makeRun({ id: "r2", agentId: "B", parentRunId: "r1" }),
    ];
    const chain = collectAncestorAgentIds(runs[0]!, runs);
    expect(chain.length).toBeLessThanOrEqual(MAX_DELEGATION_DEPTH + 1);
  });

  it("a root run with no parent is its own root", () => {
    const run = makeRun({ id: "r1", agentId: "A" });
    expect(findRootRun(run, [run]).id).toBe("r1");
  });
});
