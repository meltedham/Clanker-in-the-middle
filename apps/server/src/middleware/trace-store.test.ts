import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TraceWriter, redact, truncate } from "./trace-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-trace-test-"));
  temporaryDirectories.push(root);
  return root;
}

describe("redact", () => {
  it("scrubs secret-shaped strings", () => {
    expect(redact("using OPENROUTER_API_KEY=abcd1234efgh5678 now")).toBe("using [redacted] now");
    expect(redact("Authorization: Bearer abcd1234efgh5678")).toBe("Authorization: [redacted]");
    expect(redact("sk-abcd1234efgh5678wxyz")).toBe("[redacted]");
    expect(redact("nothing secret here")).toBe("nothing secret here");
  });
});

describe("truncate", () => {
  it("leaves short strings alone and clips long ones with an ellipsis", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("a".repeat(20), 10)).toBe("a".repeat(10) + "…");
  });
});

describe("TraceWriter", () => {
  it("appends events in order and reads them back with increasing seq", async () => {
    const trace = new TraceWriter(await makeRoot());
    await trace.append({
      runId: "run-1",
      agentId: "agent-1",
      type: "runner_attached",
      occurredAt: "2024-01-01T00:00:00.000Z",
      summary: "Runner handle: container:test",
    });
    await trace.append({
      runId: "run-1",
      agentId: "agent-1",
      type: "thread_started",
      occurredAt: "2024-01-01T00:00:01.000Z",
      summary: "Thread started: thread-1",
    });
    await trace.append({
      runId: "run-1",
      agentId: "agent-1",
      type: "completed",
      occurredAt: "2024-01-01T00:00:02.000Z",
      summary: "Run completed",
    });

    const events = await trace.read("run-1");
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.type)).toEqual([
      "runner_attached",
      "thread_started",
      "completed",
    ]);
  });

  it("redacts secret-shaped content in summary and detail before it ever touches disk", async () => {
    const root = await makeRoot();
    const trace = new TraceWriter(root);
    await trace.append({
      runId: "run-secret",
      agentId: "agent-1",
      type: "error",
      occurredAt: "2024-01-01T00:00:00.000Z",
      summary: "failed using OPENROUTER_API_KEY=abcd1234efgh5678",
      detail: { header: "Authorization: Bearer abcd1234efgh5678" },
    });

    const raw = await readFile(path.join(root, "run-secret.ndjson"), "utf8");
    expect(raw).not.toContain("abcd1234efgh5678");
    expect(raw).toContain("[redacted]");

    const [event] = await trace.read("run-secret");
    expect(event?.summary).not.toContain("abcd1234efgh5678");
    expect(event?.detail?.header).toBe("Authorization: [redacted]");
  });

  it("returns an empty array for a run with no trace file", async () => {
    const trace = new TraceWriter(await makeRoot());
    expect(await trace.read("never-appended")).toEqual([]);
  });

  it("keeps events from different runs in separate files", async () => {
    const trace = new TraceWriter(await makeRoot());
    await trace.append({
      runId: "run-a",
      agentId: "agent-1",
      type: "completed",
      occurredAt: "2024-01-01T00:00:00.000Z",
      summary: "a",
    });
    await trace.append({
      runId: "run-b",
      agentId: "agent-1",
      type: "completed",
      occurredAt: "2024-01-01T00:00:00.000Z",
      summary: "b",
    });
    expect((await trace.read("run-a")).map((event) => event.summary)).toEqual(["a"]);
    expect((await trace.read("run-b")).map((event) => event.summary)).toEqual(["b"]);
  });

  it("preserves seq order under concurrent fire-and-forget appends for the same run", async () => {
    const trace = new TraceWriter(await makeRoot());
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        trace.append({
          runId: "run-concurrent",
          agentId: "agent-1",
          type: "agent_message",
          occurredAt: "2024-01-01T00:00:00.000Z",
          summary: "chunk " + index,
        }),
      ),
    );
    const events = await trace.read("run-concurrent");
    expect(events).toHaveLength(20);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
  });
});
