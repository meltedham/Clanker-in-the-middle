# Solution 1: Durable Run Reconciliation & Resume

Addresses [`00-problem-disconnect-persistence.md`](./00-problem-disconnect-persistence.md)
§1 (server disconnect) and §2 (runner disconnect).

## Implementation status: **Done** (2026-08-29)

Implemented, typechecked, and covered by new tests. `npm run typecheck` and
`npm run build` pass for `@launchpad/server`; `npm run test -w
@launchpad/server` passes except one **pre-existing, unrelated** failure in
`container-codex-runner.test.ts` ("builds an isolated Docker/Podman-compatible
invocation") caused by `path.resolve()` normalizing `/tmp/codex-home` to a
Windows-style path on this Windows dev machine — confirmed via `git diff`
that this test file was never touched by this work. The repo's own docs
state macOS/Linux as the supported platform; this is a real but separate gap,
left as-is.

**Files changed:**
- `apps/server/src/types.ts` — added `RunnerProgress`, `RunnerCallbacks`,
  `ReconcileOutcome`, `AgentRunner.reconcile()`, and `AgentRun.partial` /
  `AgentRun.runnerHandle`.
- `apps/server/src/codex-runner.ts` — added `createProgressReporter()`
  (exported, shared with the container runner), wired `onHandle`/`onProgress`
  into `run()`, added `reconcile()` (always reports `stillRunning: false` —
  see "Deviation" below).
- `apps/server/src/container-codex-runner.ts` — same wiring, plus a real
  `reconcile()` that runs `docker ps --filter name=... status=running`, and
  if found, reattaches via `docker logs -f` through the same
  `parseCodexEventLine`/progress-reporter pipeline used by `run()`.
- `apps/server/src/agent-service.ts` — `initialize()` now calls a new
  `reconcileRun()` per interrupted Run instead of blind-cancelling;
  `progressCallbacks()` centralizes the `onHandle`/`onProgress` → store
  writes; `executeRun()` passes those callbacks into `runner.run()`.
- Tests: 3 new cases in `agent-service.test.ts` ("Run interruption and
  recovery" describe block), 2 new cases in `codex-runner.test.ts`
  (`createProgressReporter` behavior, `CodexRunner.reconcile()`).

**Update (2026-08-29, same day): `RunnerRequest`/`reconcile()` gained a
`runId` field/parameter.** Neither `CodexRunner` nor `ContainerCodexRunner`
use it themselves — it was added so the Solution 3 observability middleware
(`ObservabilityRunner`, see [`03-solution-run-event-trace-log.md`](./03-solution-run-event-trace-log.md))
can correlate its own trace events to the right Run without reaching into
`AgentService`'s store, which stays the only thing allowed to touch
`JsonStore` directly. `AgentService.progressCallbacks()` was also
subsequently stripped of everything except store checkpointing — tracing
moved out to the middleware entirely, so this file no longer has any
dependency on tracing at all. See Solution 3's status note for the full
story of that follow-up refactor; it doesn't change anything described
above for Solution 1 itself.

**Deviation from the original design sketch:** the design above describes
`reconcile()` as potentially returning `stillRunning: true` while a
reattachment continues *in the background*, with the caller leaving the Run
`running` until it settles later. The actual implementation is simpler:
`ContainerCodexRunner.reconcile()` blocks until the reattached container
exits (or is confirmed not running), then returns synchronously — including
an optional `result: RunnerResult` on `ReconcileOutcome` when reattachment
ran a Run to a real, successful completion. `AgentService.initialize()`
awaits `reconcileRun()` for each interrupted Run in sequence before finishing
boot. This is easier to reason about and test, at the cost of boot
potentially blocking for as long as a still-running container takes to
finish. Documented here so it doesn't look like a bug against the original
sketch. `ReconcileOutcome.reason` is also now **required**, not optional —
every outcome (reattached-and-completed, reattached-but-no-message,
not-found, query-failed) always carries a human-readable explanation, which
both the caller and the Solution 3 trace log depend on.

**Not implemented / left as designed:** `CodexRunner.reconcile()` (the
`local-process` profile) always returns `stillRunning: false` with a fixed
reason — this matches the doc's own stated limitation, not a gap.

**Manually verify the failure/recovery demo above** (kill `-9` the server
mid-run under `RUNTIME_PROVIDER=container`, or click Stop mid-turn) — this
was validated by unit test (mocked `AgentRunner`), not by an actual `docker`
run in this session (no Docker engine was exercised here). If picking this
back up: that live end-to-end run against a real container engine is the
next thing worth doing before calling this demo-ready.

**Update (2026-09-01): interrupted Runs that can't be reattached are now
automatically resumed, not just left `cancelled`.** Previously, when
`reconcile()` came back with `stillRunning: false` (no live process/container
to reattach to — the common case for a full restart of the `local-process`
profile, or any profile once the container itself has also been torn down),
`AgentService.reconcileRun()` finalized the Run as `cancelled`, preserving
the checkpointed thread id/partial output so the *next user message* would
resume the same thread. That still required a human to notice and send a
follow-up.

Now `reconcileRun()`'s non-reattached branch calls `runOrchestrationLoop()`
directly — the same "keep going from wherever it left off" engine
`resumeAfterChild()` already used for resuming a parent once its delegated
child settles — seeded with whatever `agent.codexThreadId` progress
checkpoints had already captured. The resume prompt
(`AgentService.synthesizeResumePrompt()`) resends the original prompt
verbatim if nothing had streamed back yet (`!run.partial`), or otherwise
restates the last checkpointed partial output alongside the original task so
Codex, on the same already-resumed thread, continues rather than repeats
itself. The existing tree-wide `MAX_ORCHESTRATION_ITERATIONS` cap (already
used to bound delegation loops) doubles as the ceiling here for free — an
environment that crashes on every attempt eventually stops retrying instead
of looping across restarts forever.

**Files changed:** `apps/server/src/agent-service.ts`
(`synthesizeResumePrompt`, `reconcileRun`); three new/updated cases in
`agent-service.test.ts`'s "Run interruption and recovery" describe block.

**Still a real limitation:** this resumes the *task*, not necessarily
mid-sentence — Codex's own thread transcript (persisted under `CODEX_HOME`,
which is itself a bind-mounted volume in `docker-compose.yml` and therefore
survives a container recreate) is what makes this possible; if `CODEX_HOME`
itself isn't persisted in a given deployment, there is no thread to resume
and this degrades to a fresh retry of the original prompt, same as
`!run.partial` today.

## Problem this solves

Today, any interruption between a Run's `queued` state and its natural
completion is treated as unrecoverable: the server restart handler in
`AgentService.initialize()` blindly stamps every in-flight Run as
`cancelled`, and cancellation inside `executeRun()` discards the Codex thread
ID and any transcript text that had already streamed back before the kill.
Real work Codex already did — including a resumable thread — is thrown away
instead of reconciled.

## Goal

A Run's outcome should be **derived from what actually happened**, not
assumed from the fact that the connection to it broke:

- If the underlying Codex process/container is still running when the server
  comes back up, **reattach to it** and let it finish normally instead of
  declaring it dead.
- If it cannot be reattached (already exited, host-process runner, engine
  doesn't support inspection), **persist whatever partial state was
  captured** — thread ID and transcript so far — instead of discarding it.
- A cancelled/interrupted Run must still leave the Agent able to **resume the
  same Codex thread** on the next message, if Codex had gotten far enough to
  open one.

## Architecture boundary

| Owner | Responsibility |
| --- | --- |
| `AgentRunner` implementations (`codex-runner.ts`, `container-codex-runner.ts`) | Surface partial progress (thread ID, streamed messages) to the caller *as it happens*, not only at the end. Expose enough identity (container name / PID) for a future process to check liveness. |
| `AgentService` | Persist partial progress incrementally to the store; on boot, reconcile instead of blind-cancel; keep `Agent.codexThreadId` up to date the moment a thread is discovered, independent of whether the Run ultimately succeeds. |
| `JsonStore` | No changes — `mutate()` already supports frequent small writes safely. |

Data crossing the boundary: `threadId` (string), incremental `messages`
(string[]), a `RunnerHandle` describing how to check on / reattach to the
underlying process (runtime kind, container name or PID), and the final
`RunnerResult`/error as today.

## Design

### 1. Stream partial progress out of the runner instead of buffering it silently

Add an optional progress callback to `RunnerRequest` handling. Simplest
change: give `AgentRunner.run()` a second parameter.

```ts
// apps/server/src/types.ts
export interface RunnerProgress {
  threadId?: string;
  message?: string; // latest agent_message text seen so far
}

export interface AgentRunner {
  run(
    request: RunnerRequest,
    onProgress?: (progress: RunnerProgress) => void,
  ): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
```

In both runners, call `onProgress` from inside `parseCodexEventLine`'s
call sites — i.e. right after `consume()` updates `parsed` — whenever
`parsed.threadId` changes or a new `item.completed` / `agent_message` is
seen. This requires no protocol change to Codex itself; it just stops
throwing away information the parser already extracts.

### 2. Persist partial progress incrementally, not just at Run completion

In `AgentService.executeRun()`, pass an `onProgress` callback into
`this.runner.run(...)` that does a small, cheap `store.mutate()`:

```ts
// apps/server/src/agent-service.ts (executeRun, sketch)
const result = await this.runner.run(
  { agentId: agentAtStart.id, workspacePath: agentAtStart.workspacePath,
    prompt: run.prompt, threadId: agentAtStart.codexThreadId },
  (progress) => {
    void this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      const agent = database.agents.find((item) => item.id === agentAtStart.id);
      if (progress.threadId && agent && !agent.codexThreadId) {
        agent.codexThreadId = progress.threadId; // resumable as soon as it exists
      }
      if (progress.message && storedRun) {
        storedRun.output = progress.message; // last-known-good partial transcript
        storedRun.partial = true;
      }
    });
  },
);
```

Two schema additions to `AgentRun` (`apps/server/src/types.ts`):

```ts
export interface AgentRun {
  // ...existing fields
  partial: boolean;       // true if output was captured before the run finished/failed
  runnerHandle: string | null; // e.g. "container:launchpad-default-<agentId>" or "pid:1234"
}
```

`partial` defaults to `false` and is cleared to `false` on a clean
completion. `runnerHandle` records enough to attempt reattachment (see next
section) and is set the moment the runner starts, cleared when it settles.

**Important:** on the cancellation/failure catch branch in `executeRun`,
stop wiping the Run clean. Keep `storedRun.output` (already partial from the
progress callback) instead of leaving it `null`, and keep
`agent.codexThreadId` as whatever the progress callback already set —
**do not overwrite it**. The only fields the catch branch should still set
are `status`, `error`, and `completedAt`.

### 3. Reconciliation on boot, not blind cancellation

Replace the unconditional cancel loop in `AgentService.initialize()` with a
reconciliation pass:

```ts
for (const run of database.runs) {
  if (run.status !== "queued" && run.status !== "running") continue;
  const outcome = await this.runner.reconcile(run.agentId, run.runnerHandle);
  if (outcome.stillRunning) {
    // leave status as "running"; re-attach a watcher (see below) instead
    // of finalizing the run here.
    continue;
  }
  run.status = run.partial ? "cancelled" : "cancelled";
  run.error = outcome.reason ?? "Run did not survive a server restart";
  run.completedAt = now();
  // run.output / agent.codexThreadId are left as whatever the last
  // progress checkpoint captured — NOT cleared.
}
```

Add `reconcile(agentId, handle)` to `AgentRunner`:

- **`ContainerCodexRunner.reconcile`**: parse the container name back out of
  `handle`, run `docker ps --filter name=<name> --format '{{.Status}}'`
  (`ContainerEngine` already has an execFile helper —
  `apps/server/src/container-codex-runner.ts:96-111` is the existing
  pattern to copy). If the container is still up, spawn `docker logs -f
  <name>` and feed its output through the *same* `parseCodexEventLine` /
  `onProgress` pipeline used by `run()`, waiting for the container to exit
  before resolving — effectively re-attaching to a Run that outlived the
  parent process. If the container is gone, return `{ stillRunning: false }`
  and let the last checkpointed `run.output`/`agent.codexThreadId` stand as
  the salvaged result.
- **`CodexRunner.reconcile`**: host processes are children of the Node
  process; on a hard crash they are typically reaped with it (this is a
  genuine limitation of `local-process` mode, not something this design can
  fully close — see Limitations). Implement `reconcile` to always return
  `{ stillRunning: false }`, but still honor the "don't clear partial state"
  rule from step 2 so the checkpointed thread ID/output survive even though
  the process itself couldn't be reattached.

### 4. Preserve thread continuity across a manual Stop

Because `agent.codexThreadId` is now written by the progress callback the
moment Codex reports `thread.started` — independent of whether the Run
ultimately completes, is cancelled, or fails — clicking **Stop** mid-turn no
longer forces the next message into a brand-new Codex session. This is a
direct, demoable behavior change from today's code, where `codexThreadId` is
only set on the success branch of `executeRun` (`agent-service.ts:271`).

## Implementation steps

1. `apps/server/src/types.ts` — add `RunnerProgress`, extend `AgentRunner.run`
   signature, add `partial` and `runnerHandle` to `AgentRun`, add
   `reconcile(agentId, handle): Promise<{ stillRunning: boolean; reason?: string }>`
   to `AgentRunner`.
2. `apps/server/src/codex-runner.ts` — thread `onProgress` through `consume()`;
   set `runnerHandle` to `"pid:" + child.pid` before returning from `run()`
   is not possible (handle needs to be known to the caller before/while
   running) — instead have `run()` accept an optional `onHandle` callback (or
   fold it into `onProgress` as a third variant) fired once, right after
   `spawn()`, with the handle string. Implement `reconcile()` per §3.
3. `apps/server/src/container-codex-runner.ts` — same `onProgress`/`onHandle`
   wiring; `runnerHandle` is `"container:" + containerName(...)`, known
   before `spawn()` even runs. Implement `reconcile()` per §3.
4. `apps/server/src/agent-service.ts` — wire `onProgress`/`onHandle` into
   incremental `store.mutate()` calls in `executeRun`; stop clearing
   `run.output`/`agent.codexThreadId` in the catch branch; replace the
   blind-cancel loop in `initialize()` with the reconciliation pass in §3.
5. `apps/server/src/store.ts` — no change needed; confirm `mutate()`'s
   serialized queue handles the higher write frequency from progress
   checkpoints without visible latency (it already serializes all writes
   through one `Promise` chain).

## Failure / recovery case to demonstrate

1. Start a Run with a prompt that takes a few seconds (e.g. "write and run a
   small test suite").
2. Once the Run reaches `running` and the Agent's thread has started, kill
   the server process directly (`kill -9` the Node PID, or `docker compose
   kill server` if running under compose) — **not** a graceful stop.
3. Restart the server.
4. **Before this fix:** the Run shows `cancelled` / "Server restarted while
   this run was active", `agent.codexThreadId` is whatever it was before
   this turn (possibly `null`), and the next message starts a fresh thread.
5. **After this fix:**
   - If the underlying container was still running, the Run reconciles to
     `completed` with the real output once `docker logs -f` finishes
     streaming, with no user action required.
   - If the container had already exited, the Run is marked `cancelled` but
     `run.output`/`run.partial` still show whatever transcript was
     captured, and `agent.codexThreadId` still points at the real,
     resumable Codex thread — provable by sending a follow-up message and
     showing Codex has context from the interrupted turn.

A second, simpler demo: click **Stop** mid-turn (no crash involved) and show
that the next message still resumes the same thread instead of starting a
new one — this alone demonstrates §2 without needing to kill the server.

## Tests to add

- `agent-service.test.ts`: mock `AgentRunner.run` to call `onProgress` with a
  thread ID before rejecting with `RunCancelledError`; assert
  `agent.codexThreadId` is set and `run.output`/`run.partial` are preserved
  after cancellation.
- `agent-service.test.ts`: simulate `initialize()` with a `queued` run in the
  fixture database and a mock `reconcile()` that returns `stillRunning:
  true`; assert the run is left `running` and a reattach watcher starts,
  instead of being force-cancelled.
- `container-codex-runner.test.ts`: unit test `reconcile()` against a mocked
  `execFile` that returns `docker ps` output, covering both "still running"
  and "not found" branches.
- `codex-runner.test.ts`: assert `onProgress` fires with the parsed thread ID
  as soon as a `thread.started` line is consumed, without waiting for the
  process to exit.

## Limitations / out of scope

- `local-process` (`CodexRunner`) cannot be reattached after a hard crash of
  the parent Node process — this is a real ceiling of that deployment
  profile, not something this design pretends to solve. The mitigation is
  limited to *not discarding whatever was checkpointed before the crash*.
- Reconciliation depends on the container engine CLI supporting `ps
  --filter name=` and `logs -f`; Docker, Podman, and Colima's Docker-CLI
  shim all support this, so no new dependency is introduced.
- This design keeps the single-process, single-writer assumption
  (`docs/ARCHITECTURE.md`) intact — it does not introduce a job queue or a
  second process. Reattachment is done in-process by the same server that
  restarted.
