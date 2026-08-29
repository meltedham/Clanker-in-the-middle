# Problem: information loss when a Run is disconnected

> **Status (2026-08-29):** all three root causes described below have
> corresponding implemented fixes — see [`README.md`](./README.md)'s status
> table for what's done and what's still unverified. This document is kept
> as originally written; it describes the code as it was *before* those
> fixes landed.

## Summary

"Disconnect" in this platform can mean three different things, and the current
implementation loses information in all three cases:

1. **Server disconnect** — the Node process restarts or crashes while a Run is
   `queued` or `running`.
2. **Runner disconnect** — the Agent's own Run is cancelled or interrupted
   mid-turn (explicit Stop, container/process kill, timeout).
3. **Client disconnect** — the browser tab loses network connectivity or is
   backgrounded while polling an in-progress Run.

In every case, the root cause is the same: **all progress made by a Run exists
only as in-memory JavaScript state until the Run finishes naturally.** Nothing
is checkpointed. Cheap-to-run reconciliation logic (a hard "declare it dead")
takes the place of contextual recovery ("figure out what actually happened").

This document traces each case to the responsible code so the solution docs in
this folder can be implemented against a concrete root cause instead of a
symptom.

## 1. Server disconnect: restart wipes any run in flight

`AgentService.initialize()` runs on every boot:

```ts
// apps/server/src/agent-service.ts:29-47
for (const run of database.runs) {
  if (run.status === "queued" || run.status === "running") {
    run.status = "cancelled";
    run.error = "Server restarted while this run was active";
    run.completedAt = now();
  }
}
for (const agent of database.agents) {
  if (agent.status === "busy") {
    agent.status = "ready";
    agent.updatedAt = now();
  }
}
```

This is documented as intentional in `docs/ARCHITECTURE.md` ("Interrupted Runs
become `cancelled` after a restart"), but it is a blind overwrite, not a
reconciliation. It does not check whether the underlying Codex process or
Runtime container is still executing. Two concrete losses follow:

- **`ContainerCodexRunner` containers run detached from the reconciliation
  logic.** The container is started with `--rm` (`apps/server/src/container-codex-runner.ts:47`)
  and is only torn down by `removeContainer()`, which is only ever called from
  `cancel()` or from the timeout/output-exceeded paths inside the *same*
  process instance (`apps/server/src/container-codex-runner.ts:113-138`,
  `181-204`). If the Node process itself restarts, the `ActiveContainer` map
  (`apps/server/src/container-codex-runner.ts:92`) is gone, so nothing calls
  `docker rm`. The container keeps running unmanaged, may finish successfully
  seconds or minutes later, and its output is written to a stdout stream that
  no process is listening to anymore — even though the container is
  discoverable by name (`launchpad-<instance>-<agentId>`,
  `apps/server/src/container-codex-runner.ts:32-36`) and Codex's own thread
  transcript is persisted on disk (`CODEX_HOME` is bind-mounted at
  `apps/server/src/container-codex-runner.ts:82`).
- **The Run record is finalized with a synthetic `"cancelled"` status and a
  generic error message**, discarding whatever the model had already produced
  for that turn, even if the underlying process goes on to complete
  successfully.

## 2. Runner disconnect: cancellation discards buffered output

Both runner implementations parse Codex's streaming JSONL output into a
function-local accumulator:

```ts
// apps/server/src/codex-runner.ts:152-157 (identical shape in container-codex-runner.ts:169-174)
const parsed: ParsedEvents = {
  messages: [],
  threadId: request.threadId,
  usage: null,
  errors: [],
};
```

`parsed` is populated as JSONL lines arrive (`consume()` →
`parseCodexEventLine()`), including the **thread ID**, which Codex emits as
soon as the turn starts (`thread.started`, `apps/server/src/codex-runner.ts:52-54`).
`run()` only has two exit paths:

- **Success**: return a fully-formed `RunnerResult` (`codex-runner.ts:218-222`).
- **Anything else** (`RunCancelledError`, timeout, output-exceeded, non-zero
  exit): throw, and `parsed` — thread ID included — is discarded when the
  stack unwinds. There is no partial-result return type.

`AgentService.executeRun()` mirrors this all-or-nothing shape
(`apps/server/src/agent-service.ts:235-296`): `agent.codexThreadId` is only
ever written on the success branch (line 271). The catch branch
(`RunCancelledError` from an explicit Stop, a Delete, or the restart-recovery
path) writes `run.error` and flips the Agent back to `ready`, but never
persists the thread ID that Codex may have already assigned, and never
persists any of the `messages` Codex had already streamed before being
killed.

**Consequence:** if a user (or the platform) cancels a Run after Codex has
done real, useful work — written files, produced a partial answer, started a
resumable thread — the *files* survive (the workspace is a bind mount), but
the *conversational record* does not. The next message starts a brand-new
Codex thread with no memory of the interrupted turn, even though a valid,
resumable thread already exists in `CODEX_HOME` on disk.

## 3. Client disconnect: one network blip permanently stalls the UI

The frontend never uses push updates; it polls:

```ts
// apps/web/src/App.tsx:204-221
const pollRun = async (runId: string, agentId: string) => {
  if (pollingRunIds.current.has(runId)) return;
  pollingRunIds.current.add(runId);
  try {
    while (mountedRef.current) {
      await new Promise((resolve) => window.setTimeout(resolve, 900));
      if (!mountedRef.current) return;
      const result = await api.run(runId);   // <-- no try/catch here
      if (selectedIdRef.current === agentId) setActiveRun(result.run);
      if (!["queued", "running"].includes(result.run.status)) {
        await Promise.all([refreshMessages(agentId), refreshAgents()]);
        return;
      }
    }
  } finally {
    pollingRunIds.current.delete(runId);
  }
};
```

`api.run(runId)` throws `ApiError` on any non-2xx response and rejects on a
network failure. There is no `try/catch` around the call inside the loop, so
a single dropped request (Wi-Fi blip, laptop sleep, sandbox/VPN hiccup)
propagates out of `pollRun` entirely. The only handler is at the call sites
(`App.tsx:112-114` and `App.tsx:240-245`), which set a one-shot `error`
banner and stop — nothing re-arms polling. The Run may complete successfully
on the server seconds later, but the UI has no way to find out short of the
user manually reselecting the Agent (which happens to re-trigger the
`selectedId` effect at `App.tsx:99-120` and re-poll). This is not documented
or obvious to a user watching a frozen "Codex is reading, editing, or running
commands…" spinner.

There is also no resync on tab refocus/visibility change: if a laptop sleeps
mid-Run and wakes up later, nothing forces a re-fetch of the Agent, messages,
and Run state — the UI just resumes whatever polling loop happened to survive
(or didn't).

## Root cause, stated once

> Everything about a Run's progress — buffered transcript, discovered thread
> ID, token usage, and the client's live view of it — is held only in
> transient, per-process or per-tab memory until the Run finishes on its own.
> Any interruption between start and natural completion is handled as
> **total data loss dressed up as a status transition**, not as a
> reconciliation problem with a partial, recoverable result.

The three solution docs in this folder each address one layer of this:

| Doc | Layer | Fixes |
| --- | --- | --- |
| [`01-solution-durable-run-reconciliation.md`](./01-solution-durable-run-reconciliation.md) | Server ↔ Runner | Server disconnect (§1), Runner disconnect (§2) |
| [`02-solution-client-reconnect-resilience.md`](./02-solution-client-reconnect-resilience.md) | Client ↔ Server | Client disconnect (§3) |
| [`03-solution-run-event-trace-log.md`](./03-solution-run-event-trace-log.md) | Observability | Makes §1/§2 partial state inspectable and demoable |

See [`README.md`](./README.md) for suggested build order and how these map to
the hackathon brief's evaluation criteria.
