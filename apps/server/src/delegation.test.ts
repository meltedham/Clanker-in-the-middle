import { describe, expect, it } from "vitest";
import {
  MAX_DELEGATION_DEPTH,
  collectAncestorAgentIds,
  findRootRun,
  formatRoster,
  parseAgentCreation,
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
    actorId: null,
    awaitingChildRunId: null,
    orchestrationIterationCount: 0,
    retrieval: null,
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

  it("accepts a JSON object body (observed live from a real model)", () => {
    const output = '```delegate\n{\n  "agent": "Diet Manager",\n  "task": "log breakfast"\n}\n```';
    expect(parseDelegation(output)).toEqual({ agentName: "Diet Manager", task: "log breakfast" });
  });

  it("accepts a single-line JSON object body", () => {
    const output = '```delegate\n{"agent": "Researcher", "task": "find X"}\n```';
    expect(parseDelegation(output)).toEqual({ agentName: "Researcher", task: "find X" });
  });

  it("returns null for JSON missing agent or task fields", () => {
    expect(parseDelegation('```delegate\n{"agent": "Researcher"}\n```')).toBeNull();
    expect(parseDelegation('```delegate\n{"task": "find X"}\n```')).toBeNull();
    expect(parseDelegation("```delegate\n{}\n```")).toBeNull();
  });

  it("returns null for JSON that isn't an object", () => {
    expect(parseDelegation('```delegate\n"just a string"\n```')).toBeNull();
    expect(parseDelegation("```delegate\n[1, 2, 3]\n```")).toBeNull();
    expect(parseDelegation("```delegate\nnot json or the line format\n```")).toBeNull();
  });

  it("prefers the line format when both would technically parse", () => {
    // Sanity check: the two formats never collide in practice, but make
    // sure well-formed line-format input never falls through to the JSON
    // parser and gets mangled.
    const output = "```delegate\nagent: Helper\ntask: {not actually json}\n```";
    expect(parseDelegation(output)).toEqual({ agentName: "Helper", task: "{not actually json}" });
  });
});

describe("parseAgentCreation", () => {
  it("parses a single JSON object", () => {
    const output = '```create-agents\n{"name": "Researcher", "description": "Finds things"}\n```';
    expect(parseAgentCreation(output)).toEqual([{ name: "Researcher", description: "Finds things" }]);
  });

  it("parses a JSON array of several Agents, description/instructions optional", () => {
    const output =
      '```create-agents\n[{"name": "A", "description": "d"}, {"name": "B", "instructions": "i"}, {"name": "C"}]\n```';
    expect(parseAgentCreation(output)).toEqual([
      { name: "A", description: "d" },
      { name: "B", instructions: "i" },
      { name: "C" },
    ]);
  });

  it("returns null when there is no create-agents block", () => {
    expect(parseAgentCreation("Just a normal final answer.")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseAgentCreation("```create-agents\nnot json\n```")).toBeNull();
  });

  it("drops entries with no name and returns null if none remain", () => {
    expect(parseAgentCreation('```create-agents\n[{"description": "no name"}]\n```')).toBeNull();
    const output = '```create-agents\n[{"description": "no name"}, {"name": "Valid"}]\n```';
    expect(parseAgentCreation(output)).toEqual([{ name: "Valid" }]);
  });

  it("never throws on garbage input", () => {
    expect(() => parseAgentCreation("")).not.toThrow();
    expect(() => parseAgentCreation("```create-agents")).not.toThrow();
  });

  it("requires the block to be the last thing in the output", () => {
    const output = '```create-agents\n{"name": "A"}\n```\n\nOne more thought after.';
    expect(parseAgentCreation(output)).toBeNull();
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
