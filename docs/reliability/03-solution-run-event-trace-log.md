# Solution 3: Persisted Run Event Trace

Builds on [`01-solution-durable-run-reconciliation.md`](./01-solution-durable-run-reconciliation.md)'s
`onProgress`/`onHandle` hooks. Turns the disconnect problem from something
that is merely *fixed* into something that is *demonstrable* — a reviewer
(or a user) can see exactly what happened to an interrupted Run instead of
taking the platform's word for it.

## Implementation status: **Done, and refactored into real middleware** (2026-08-29)

Implemented end to end: server storage + API route, a minimal web UI panel,
**and** — after a follow-up review — restructured so the tracing behavior is
a genuine `AgentRunner`-wrapping middleware instead of being inlined into
`AgentService`. `npm run typecheck` / `npm run build` pass for both
workspaces; server tests pass (see Solution 1's status note for the one
pre-existing, unrelated Windows-path test failure elsewhere in the suite).

**Why this got refactored:** the first pass (see git history / the original
version of this doc) called `trace.append(...)` directly from inside
`AgentService.executeRun()`/`reconcileRun()`/`progressCallbacks()`. That
worked, but it wasn't middleware in the sense `bff.pdf`/`AGENT_BRIEF.md`
mean by the term — it was core Control Plane logic with observability code
woven through it, with no boundary a reviewer could point at or a future
team could unplug. The fix: move all trace-writing into a new
`ObservabilityRunner` class that implements the same `AgentRunner` interface
it wraps, so it plugs in at the exact seam `AGENT_BRIEF.md` already calls
out ("keep the runner abstraction as the place for runtime-specific
behavior... a key architectural seam"). `AgentService` now depends only on
the plain `AgentRunner` type and has zero knowledge that tracing exists —
see [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md#middleware) for the boundary
writeup and updated diagram.

**Files changed / added (current shape, post-refactor):**
- `apps/server/src/middleware/trace-store.ts` (new; originally `trace.ts`,
  relocated) — `RunEvent`, `RunEventType`, `TraceWriter` (per-run NDJSON
  files under `<dataDirectory>/traces/`, append-only, redacts
  `OPENROUTER_API_KEY=...` / `Bearer ...` / `sk-...`-shaped strings before they
  ever touch disk), `redact()`, `truncate()`, and a new `TraceReader`
  interface (`{ read(runId): Promise<RunEvent[]> }`) so read-only consumers
  (the API layer) don't depend on the concrete writer.
- `apps/server/src/middleware/trace-store.test.ts` (new; relocated +
  renamed from `trace.test.ts`) — ordering, redaction (asserts the *raw file
  bytes* never contain the secret, not just the parsed return value),
  missing-file → `[]`, per-run file isolation, and a concurrency test for
  the queued-write ordering guarantee (see Deviation below).
- `apps/server/src/middleware/observability-runner.ts` (new) —
  `ObservabilityRunner implements AgentRunner`: wraps an inner runner,
  mirrors every `onHandle`/`onProgress` firing plus the terminal outcome
  (`completed`/`cancelled`/`error`) and every `reconcile()` decision into
  the trace store, while still invoking the caller's own callbacks and
  returning/throwing the inner runner's result/error completely unchanged.
  A `safeAppend()` wrapper swallows trace-write failures so observability
  can never break the Run it's observing.
- `apps/server/src/middleware/observability-runner.test.ts` (new) — 6 cases:
  transparency on success (callbacks forwarded, result unchanged, full
  event sequence traced), cancellation traced + rethrown, a real failure
  traced as `error` (not `cancelled`) + rethrown, a reconciliation decision
  traced + outcome returned unchanged, trace-store failures never breaking
  the underlying run (success or failure), and `cancel()`/`isAvailable()`
  passthrough.
- `apps/server/src/agent-service.ts` — **no longer imports or knows about
  tracing at all.** `progressCallbacks()` is back to pure store
  checkpointing; `executeRun()`/`reconcileRun()` lost their `trace.append`
  calls entirely; the now-unnecessary `getRunTrace()` method was removed
  (the API route gets trace data directly from the trace store instead, see
  below). The constructor is back to its original 4 parameters.
- `apps/server/src/runner-factory.ts` — `createRunner(config, trace)` now
  builds the concrete runner (`CodexRunner`/`ContainerCodexRunner`) and
  wraps it in `ObservabilityRunner` before returning — the one place in the
  codebase where the middleware is composed.
- `apps/server/src/app.ts` — `createApp(config, service, trace: TraceReader)`
  takes the trace reader as an explicit third dependency (not reached via
  `service`); the `GET /api/runs/:id/trace` route asks `service.getRun(id)`
  for the 404 check (Control Plane) and `trace.read(id)` for the data
  (Observability Layer) — two independent components composed at the route,
  neither owning the other.
- `apps/server/src/app.test.ts` — updated the two existing tests to pass a
  trivial `TraceReader` stub as the new required third argument; rewrote the
  two trace-route tests to mock `TraceReader` instead of a
  now-nonexistent `service.getRunTrace`, and added an assertion that the
  404 case never even calls `trace.read` (had to fix a test bug along the
  way too — an all-`1` UUID like `11111111-...-1111` fails Zod's `.uuid()`
  RFC4122 variant-nibble check; needed `8111` in the variant position
  instead).
- `apps/server/src/index.ts` — constructs the `TraceWriter`, passes it into
  `createRunner()` and `createApp()`.
- `apps/server/src/types.ts` — `RunnerRequest` gained a `runId: string`
  field, and `AgentRunner.reconcile()` gained a `runId: string` parameter.
  Neither `CodexRunner` nor `ContainerCodexRunner` use it — it exists purely
  so `ObservabilityRunner` (or any future runner-wrapping middleware) can
  correlate its own side-channel data to the right Run without reaching into
  the JsonStore (which only `AgentService` is allowed to touch).
- `apps/server/src/codex-runner.ts`, `container-codex-runner.ts`,
  `codex-runner.test.ts`, `container-codex-runner.test.ts`,
  `agent-service.test.ts` — updated for the `runId` parameter addition
  (mechanical: new required field/param threaded through call sites and test
  fixtures; two of the reconciliation tests in `agent-service.test.ts` now
  also assert the middleware's `runId` is threaded through correctly).
- `docs/ARCHITECTURE.md` — new "Middleware" section documenting the boundary
  contract, an updated diagram showing `ObservabilityRunner` wrapping the
  concrete runner, corrected the stale "Interrupted Runs become `cancelled`
  after a restart" line (no longer true post-Solution-1), and a note in
  "Extension seams" that Glass Box is now implemented as a template for a
  future Bouncer/Kill Switch middleware.
- `apps/web/src/types.ts` — `RunEvent`, `RunEventType`, and an optional
  `partial` field on the web `AgentRun` type (mirrors the server schema;
  not yet rendered anywhere in the UI beyond being available).
- `apps/web/src/api.ts` — `api.trace(runId)`.
- `apps/web/src/App.tsx` — a "View trace" toggle next to the session-info
  pill in the Playground header (visible whenever there's an `activeRun`);
  a collapsible panel below it rendering `seq · time · type · summary` as a
  flat list, per the doc's "no timeline library" scope decision.
- `apps/web/src/styles.css` — `.trace-panel`, `.trace-list`, `.trace-event`
  and related rules, following the existing muted/pill visual language.

(The web-side files are unchanged by the middleware refactor — the
`GET /api/runs/:id/trace` response shape never changed, only how the server
produces it.)

**Deviation from the original design sketch:** the design sketch used an
in-memory `Map<runId, seq>` counter with a bare `appendFile` per event and
no queuing, relying on the assumption that events for one run wouldn't
overlap enough to race. Since `onProgress` can fire in tight succession, the
actual `TraceWriter` adds a **per-run write queue** (chained promises keyed
by `runId`) so concurrent `void this.safeAppend(...)` fire-and-forget calls
from `observability-runner.ts`'s `observe()` wrapper can never interleave
their `appendFile` writes out of `seq` order. This was driven by a real test
failure while writing `trace-store.test.ts`'s concurrency case, not a
hypothetical. Terminal events (`completed`/`cancelled`/`error`/
`reconciliation`) are `await`-ed inside `ObservabilityRunner.run()`/
`reconcile()` (not fire-and-forget) specifically so a caller that reads the
trace immediately after a Run settles (as tests, and presumably an attentive
user, would) isn't racing an in-flight disk write — the higher-frequency
`onHandle`/`onProgress` events stay fire-and-forget as originally designed,
since the internal queue already guarantees their relative order regardless.

**Not implemented / deferred:** the doc's "raw event" expandable `detail`
view is not built — the panel only renders `summary`, per the doc's own
"a flat list of summary strings ... is enough for a first pass" scope call.
`detail` is still captured and redacted server-side (e.g. `usage` on the
`completed` event), just not surfaced in the UI yet — a natural next step if
someone wants richer trace inspection later.

## Problem this solves

Even after Solution 1 stops discarding partial state, there is still no
record of *what happened during the interruption itself*: which events
arrived before the disconnect, whether reconciliation found a live container
or salvaged a checkpoint, and when the thread ID was actually discovered.
That sequence currently exists, if at all, only as scattered `console`/pino
log lines — not as something correlated to a specific Run and inspectable
after the fact. This is precisely the gap between "the bug is fixed" and
"we can prove the bug is fixed," which is what the brief's evaluation
criteria (40% end-to-end behavior with convincing evidence, 20%
verification/robustness) actually reward.

## Goal

Every Run accumulates an ordered, append-only event log — `thread_started`,
`agent_message`, `turn_completed`, `error`, `cancelled`, and, new in this
design, `reconciliation` events describing what the server found when it
came back up. The log persists independently of whether the Run ultimately
succeeds, and survives a server restart because it is written incrementally,
not assembled only at the end.

## Architecture boundary

This is the **Observability Layer** described in `bff.pdf` §7's layered
architecture table, sitting beside — not inside — `AgentService`.

| Owner | Responsibility |
| --- | --- |
| `AgentRunner` implementations | Already emit `onProgress`/`onHandle` per Solution 1 — no further change needed here. |
| New `TraceWriter` (`apps/server/src/trace.ts`) | Append one `RunEvent` per meaningful moment to a per-run file. Read them back for the API. Redact obvious secret-shaped content before writing. |
| `AgentService` | Calls `TraceWriter.append(...)` from the same callback sites already added for Solution 1 (`onProgress`, `onHandle`, the reconciliation pass in `initialize()`), plus explicit `cancelled`/`completed`/`failed` terminal events. |
| Fastify API | One new read-only route, `GET /api/runs/:id/trace`. |
| Web UI | One small, optional panel rendering the event list for the currently viewed Run — explicitly minimal, per the brief's "add only the UI needed to expose your middleware." |

**Why a separate store instead of adding `runEvents: RunEvent[]` to the
existing `Database`:** `JsonStore.mutate()` does a full
`structuredClone` + `JSON.stringify` + atomic rename of the *entire*
database on every call (`apps/server/src/store.ts:39-59`). That's fine at
the frequency Agent/Run/message mutations happen today, but event-level
trace data is emitted multiple times per second during an active Run —
routing it through the same full-document rewrite would make every Run
proportionally slower to observe and would bloat `launchpad.json` with
data nothing else needs to load into memory on every mutation. Trace data
is append-only and read by run ID, which is exactly what a per-run NDJSON
file is good at, without touching `JsonStore` at all.

## Design

### 1. Event shape

```ts
// apps/server/src/trace.ts
export type RunEventType =
  | "thread_started"
  | "agent_message"
  | "turn_completed"
  | "error"
  | "cancelled"
  | "completed"
  | "reconciliation";

export interface RunEvent {
  seq: number;           // monotonic per-run counter, not wall-clock-derived
  runId: string;
  agentId: string;
  type: RunEventType;
  occurredAt: string;    // ISO timestamp
  summary: string;       // short, redacted, human-readable line
  detail?: Record<string, unknown>; // optional structured payload, also redacted
}
```

`summary` is what the UI renders in the timeline by default; `detail` is
available for an expandable "raw event" view but is never required reading —
this keeps the minimal-UI requirement easy to satisfy (a flat list of
`summary` strings with icons/colors per `type` is enough for a first pass).

### 2. Append-only writer, one file per Run

```ts
// apps/server/src/trace.ts
import { appendFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";

const SECRET_PATTERN = /(sk-|OPENROUTER_API_KEY|Bearer\s+)[A-Za-z0-9._-]{8,}/g;

function redact(value: string): string {
  return value.replace(SECRET_PATTERN, "[redacted]");
}

export class TraceWriter {
  private readonly counters = new Map<string, number>();

  constructor(private readonly root: string) {}

  private filePath(runId: string): string {
    return path.join(this.root, runId + ".ndjson");
  }

  async append(event: Omit<RunEvent, "seq">): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const seq = (this.counters.get(event.runId) ?? 0) + 1;
    this.counters.set(event.runId, seq);
    const record: RunEvent = {
      ...event,
      seq,
      summary: redact(event.summary),
      detail: event.detail
        ? (JSON.parse(redact(JSON.stringify(event.detail))) as Record<string, unknown>)
        : undefined,
    };
    await appendFile(this.filePath(event.runId), JSON.stringify(record) + "\n", "utf8");
  }

  async read(runId: string): Promise<RunEvent[]> {
    try {
      const raw = await readFile(this.filePath(runId), "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RunEvent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
```

`appendFile` is used deliberately instead of read-modify-write: it is the
one part of this design that must stay cheap even under frequent calls, and
it fails closed (an append that doesn't land just means one missing line,
not a corrupted trace) unlike a read-modify-write that races with itself.

The in-memory `counters` map is intentionally not persisted — on a server
restart it's fine for sequence numbers to restart from a value that's still
monotonic for *that run's remaining events* as long as new events are
appended after existing ones in the file, which `appendFile` guarantees. If
strict global monotonicity across a restart matters later, seed the counter
from the last line of the existing file on first append.

### 3. Wiring into `AgentService`

Reuse the exact same callback sites Solution 1 adds:

- `onHandle` (fires once, when the runner/container starts) →
  `trace.append({ type: "thread_started" ... })` once a thread ID is known,
  or a generic "run started, runner handle: <handle>" event immediately.
- `onProgress` (fires per parsed Codex event) →
  `trace.append({ type: "agent_message", summary: truncate(progress.message, 200) })`.
- The reconciliation pass in `initialize()` →
  `trace.append({ type: "reconciliation", summary: outcome.stillRunning
    ? "Reattached to a container still running after restart"
    : "Server restarted; salvaged last checkpointed output" })`.
- The terminal branches of `executeRun` (success, cancelled, failed) →
  one closing `completed`/`cancelled`/`error` event each, including
  `run.error` (redacted) when present.

None of this requires new state in `AgentService` beyond a `TraceWriter`
instance injected the same way `JsonStore` and `WorkspaceManager` already
are.

### 4. Read API

```ts
// apps/server/src/app.ts — one new route
app.get("/api/runs/:id/trace", async (request) => {
  const { id } = runIdParams.parse(request.params);
  service.getRun(id); // 404s if the run doesn't exist — reuse existing check
  return { events: await trace.read(id) };
});
```

### 5. Minimal UI

A collapsible "Trace" section under the Run's message in the Playground
(or a small icon button that opens a side panel), backed by one
`api.trace(runId)` call. Render `events` as a simple vertical list:
`seq · occurredAt · type · summary`. No timeline library, no virtualization —
Run event counts in a hackathon demo are small enough that a plain list is
sufficient and keeps this from becoming a UI project of its own.

## Implementation steps

1. `apps/server/src/trace.ts` — new file: `RunEvent`, `RunEventType`,
   `TraceWriter`, `redact`.
2. `apps/server/src/agent-service.ts` — accept a `TraceWriter` in the
   constructor; call `.append(...)` from the callback sites listed in §3.
3. `apps/server/src/app.ts` — add `GET /api/runs/:id/trace`; construct and
   pass the `TraceWriter` (root: `path.join(config.dataDirectory, "traces")`,
   mirroring how `config.dataDirectory` already anchors `launchpad.json`).
4. `apps/server/src/config.ts` — no new env var strictly required; the trace
   root can derive from `dataDirectory`.
5. `apps/web/src/api.ts` — add `trace: (runId) => request<{ events: RunEvent[] }>("/api/runs/" + runId + "/trace")`.
6. `apps/web/src/App.tsx` — minimal collapsible panel per §5.

## Failure / recovery case to demonstrate

This is the same server-restart scenario as Solution 1, but now with visible
proof instead of an inference from status codes:

1. Start a Run, let it reach `running` with a thread started.
2. Kill and restart the server mid-run (as in Solution 1's demo).
3. Open the Run's trace panel and show the actual sequence: `thread_started`
   → several `agent_message` events → `reconciliation` (stating whether it
   reattached or salvaged a checkpoint) → a terminal event.
4. Contrast with today's behavior, where the only artifact of this scenario
   is a single generic string: `"Server restarted while this run was
   active"`, with no way to tell what Codex had actually done before the
   restart.

This single trace view is also reusable as the required "show at least one
real ... action" and "demonstrate the middleware behavior and the evidence
it produces" steps in the brief's required live demo (`bff.pdf` §8).

## Tests to add

- `trace.test.ts`:
  - `append` then `read` returns events in the order written, with
    increasing `seq`.
  - `redact` scrubs an `OPENROUTER_API_KEY`/`Bearer ...`-shaped string from both
    `summary` and `detail` before it is written to disk (read the raw file
    contents in the test, not just the parsed return value, to prove it
    never touches disk unredacted).
  - `read` on a run ID with no trace file returns `[]`, not an error.
- `app.test.ts`: `GET /api/runs/:id/trace` returns `{ events: [] }` for a
  freshly created run with no events yet, and 404s for an unknown run ID
  (reusing the existing `getRun` 404 path).
- `agent-service.test.ts`: after a mocked run completes, assert the injected
  `TraceWriter` received `thread_started` → `agent_message` → `completed`
  events in that order (mock `TraceWriter.append` with a spy, no real
  filesystem needed).

## Limitations / out of scope

- Trace files are not rotated, compacted, or capped. For a hackathon-scale
  demo this is fine; a real deployment would need a retention policy — noted
  as a known limitation rather than implemented.
- Redaction is a heuristic regex, not a guarantee against every possible
  secret shape. Treat it as a second line of defense, not the only one — the
  primary defense is still that `OPENROUTER_API_KEY` is never placed in Codex's
  stdout/stderr in the first place (`childEnvironment()` in both runners
  only forwards it to the Codex process's own env, not to anything that
  gets echoed back).
- This design assumes Solution 1's `onProgress`/`onHandle` hooks exist;
  without them, `TraceWriter` can still be wired to the *existing*
  start/success/failure points in `executeRun` for a strictly weaker trace
  (no mid-run granularity, no reconciliation events) if Solution 1 is
  deferred.
