import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export type RunEventType =
  | "runner_attached"
  | "thread_started"
  | "agent_message"
  | "turn_completed"
  | "error"
  | "cancelled"
  | "completed"
  | "reconciliation";

export interface RunEvent {
  seq: number;
  runId: string;
  agentId: string;
  type: RunEventType;
  occurredAt: string;
  summary: string;
  detail?: Record<string, unknown>;
}

/**
 * Read-only view of the trace store. The API layer depends on this narrow
 * shape rather than the concrete `TraceWriter`, so it's explicit that
 * reading a trace never requires (or grants) write access to it.
 */
export interface TraceReader {
  read(runId: string): Promise<RunEvent[]>;
}

const SECRET_PATTERN = /(sk-|ARK_API_KEY[=:]?\s*|Bearer\s+)[A-Za-z0-9._-]{8,}/gi;

export function redact(value: string): string {
  return value.replace(SECRET_PATTERN, "[redacted]");
}

function redactDetail(detail: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(redact(JSON.stringify(detail))) as Record<string, unknown>;
}

export class TraceWriter implements TraceReader {
  private readonly counters = new Map<string, number>();
  /** Per-run write queue so fire-and-forget `append()` calls from concurrent progress events cannot race each other's appendFile and land out of `seq` order. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  private filePath(runId: string): string {
    return path.join(this.root, runId + ".ndjson");
  }

  async append(event: Omit<RunEvent, "seq">): Promise<RunEvent> {
    const seq = (this.counters.get(event.runId) ?? 0) + 1;
    this.counters.set(event.runId, seq);
    const record: RunEvent = {
      ...event,
      seq,
      summary: redact(event.summary),
      ...(event.detail ? { detail: redactDetail(event.detail) } : {}),
    };
    const previous = this.queues.get(event.runId) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.root, { recursive: true });
        await appendFile(this.filePath(event.runId), JSON.stringify(record) + "\n", "utf8");
      });
    this.queues.set(event.runId, write);
    await write;
    return record;
  }

  async read(runId: string): Promise<RunEvent[]> {
    try {
      const raw = await readFile(this.filePath(runId), "utf8");
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as RunEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

export function truncate(value: string, maxLength = 400): string {
  return value.length > maxLength ? value.slice(0, maxLength) + "…" : value;
}
