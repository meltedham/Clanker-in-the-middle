# Solution 2: Client Reconnect & Live-View Resilience

Addresses [`00-problem-disconnect-persistence.md`](./00-problem-disconnect-persistence.md)
§3 (client disconnect).

## Implementation status: **Done, core fix only — SSE stretch not built** (2026-08-29)

The retry/backoff/resync design (§§1–4 of this doc) is fully implemented and
tested. The "Optional stretch: replace polling with push updates (SSE)"
section was, as the doc itself says, explicitly optional and was **not**
attempted in this session — resilient polling alone closes the correctness
gap, and there was no time pressure to justify the bigger lift. `npm run
typecheck` / `npm run build` / `npm run test` all pass for `@launchpad/web`.

**Files changed / added:**
- `apps/web/src/reconnect.ts` (new) — `withRetry()` and
  `isRetryableApiError()`, exactly as designed: pure, DOM-free, injectable
  `sleep` for tests.
- `apps/web/src/reconnect.test.ts` (new) — 7 cases covering immediate
  success, retryable-then-recovers with capped backoff, non-retryable
  rethrows immediately, and exhausting `maxAttempts`.
- `apps/web/src/App.tsx` — `pollRun`'s single network call now goes through
  `withRetry`; a `connectionState: "connected" | "lost"` state renders a
  "Reconnecting to the control plane…" banner distinct from the existing
  "thinking" spinner; a new effect listens for `focus`/`online`/
  `visibilitychange` and immediately resyncs (`refreshAgents` +
  `refreshMessages` + re-arms `pollRun` if the last known Run is still
  `queued`/`running`) instead of waiting on the 900ms poll cadence or a
  timer that may have been suspended while backgrounded.
- `apps/web/src/styles.css` — `.connection-banner`, sharing the
  `.config-banner`/`.error-banner` layout rule and a similar warm/amber
  palette (distinct from the red `.error-banner`, since a lost connection
  isn't the same severity as a hard error).
- `apps/web/package.json` — added `vitest` devDependency and a `"test":
  "vitest run"` script (this workspace had no test runner at all before
  this work).
- `package.json` (repo root) — `"test"` script changed from
  `npm run test -w @launchpad/server` to `npm run test --workspaces
  --if-present`, so `npm run check` now runs both workspaces' test suites
  (matches the pattern already used by the root `typecheck` script).

**Deviations from the design sketch:** none of substance. `withRetry`'s
`catch` block inside `pollRun`'s loop uses a bare `continue` after setting
`connectionState` to `"lost"`, matching the doc's description exactly (the
outer 900ms loop becomes the retry window once `withRetry`'s own budget of
8 attempts / ~2 minutes is exhausted).

**Not implemented / deferred:** the optional SSE stretch (§ near the end of
the doc, "Optional stretch: replace polling with push updates"). If picked
up later, it depends on nothing from this session except perhaps reusing
the trace event stream from [`03-solution-run-event-trace-log.md`](./03-solution-run-event-trace-log.md)
as the SSE payload source.

**Not manually verified in a real browser this session** (no browser tooling
available in this environment) — the retry/backoff logic itself is unit
tested and the component compiles/builds cleanly, but the actual DevTools
offline/online demo described below and the visibility/focus resync were
not clicked through by a human. Worth a quick manual pass before treating
this as demo-ready.

## Problem this solves

`pollRun` in `apps/web/src/App.tsx` has no error handling inside its poll
loop. The first network failure — a Wi-Fi drop, a laptop sleep, a VPN
hiccup — throws out of the loop entirely and is never retried. The Run may
finish successfully on the server seconds later, but the browser has no way
to find out short of the user manually reselecting the Agent. This is a
*visibility* persistence problem, not a data-loss problem: the server has
the answer, the client just stops asking for it.

## Goal

- A transient network failure while polling should be retried with backoff,
  not treated as terminal.
- Regaining focus/connectivity (tab refocus, laptop wake, `navigator.onLine`
  flipping back to `true`) should trigger an immediate resync instead of
  waiting for the next lucky poll tick.
- The UI should be able to tell the user "reconnecting" apart from "the Agent
  is still thinking" — right now both render as the same spinner, which
  hides the actual problem.

## Architecture boundary

This is entirely a Web UI (Experience Layer) change. No API contract changes
are required for the core fix — `GET /api/runs/:id`,
`GET /api/agents/:id/messages`, and `GET /api/agents/:id/runs` already return
everything needed. An optional stretch extension (§4 below) adds a new
endpoint if the team wants push updates instead of resilient polling.

| Owner | Responsibility |
| --- | --- |
| `apps/web/src/api.ts` | Distinguish retryable failures (network error, 5xx, 429) from terminal ones (404, 401, 400); expose a small retry/backoff primitive. |
| `apps/web/src/App.tsx` | Use the retry primitive inside `pollRun`; add a `visibilitychange`/`online` listener that forces an immediate resync; surface connection state distinct from Run state. |

## Design

### 1. A pure, testable retry primitive

Add a small helper that the rest of the code composes rather than each call
site reinventing backoff:

```ts
// apps/web/src/reconnect.ts
export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable: (error: unknown) => boolean;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt >= options.maxAttempts || !options.isRetryable(error)) throw error;
      const delay = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      await sleep(delay);
    }
  }
}

export function isRetryableApiError(error: unknown): boolean {
  // ApiError with a 5xx/429 status, or a raw network failure (TypeError
  // from fetch, no `status` at all) are retryable. 4xx other than 429 is not.
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status: number }).status;
    return status === 429 || status >= 500;
  }
  return true; // fetch network failure — no response at all
}
```

Keeping this in its own module (not inline in `App.tsx`) makes it unit
testable without React or a DOM — see "Tests to add" below. `sleep` is
injected so tests can run instantly instead of waiting on real timers.

### 2. Wrap the poll loop, don't rewrite it

`pollRun` keeps its existing shape and only wraps the single network call:

```ts
// apps/web/src/App.tsx — pollRun, revised
const pollRun = async (runId: string, agentId: string) => {
  if (pollingRunIds.current.has(runId)) return;
  pollingRunIds.current.add(runId);
  try {
    while (mountedRef.current) {
      await new Promise((resolve) => window.setTimeout(resolve, 900));
      if (!mountedRef.current) return;
      let result: { run: AgentRun };
      try {
        result = await withRetry(() => api.run(runId), {
          maxAttempts: 8,
          baseDelayMs: 1_000,
          maxDelayMs: 15_000,
          isRetryable: isRetryableApiError,
        });
        setConnectionState("connected");
      } catch (reason) {
        setConnectionState("lost"); // surfaced in the UI, loop keeps going
        continue;
      }
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

Note the `catch` inside the `while` loop `continue`s rather than returning —
`withRetry` already exhausts its own backoff budget before throwing, so a
`catch` reaching this point means 8 attempts over roughly two minutes have
failed. Rather than giving up, the outer `while` loop's own 900ms cadence
becomes the next retry window, and `connectionState` stays `"lost"` until a
poll finally succeeds. This means the UI genuinely cannot get permanently
stuck from a transient network issue — only from the tab being closed
(`mountedRef.current` false) or the Run being explicitly abandoned.

### 3. Resync on refocus, not just on a timer

Add one effect near the other top-level effects in `App.tsx`:

```ts
useEffect(() => {
  const resync = () => {
    if (!selectedIdRef.current) return;
    void refreshAgents();
    void refreshMessages(selectedIdRef.current);
    // if activeRun is still queued/running and not already being polled,
    // pollRun's own `pollingRunIds` guard makes this a safe no-op call.
    if (activeRun && ["queued", "running"].includes(activeRun.status)) {
      void pollRun(activeRun.id, selectedIdRef.current);
    }
  };
  window.addEventListener("focus", resync);
  window.addEventListener("online", resync);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") resync();
  });
  return () => {
    window.removeEventListener("focus", resync);
    window.removeEventListener("online", resync);
  };
}, [refreshAgents, refreshMessages, activeRun]);
```

This covers the "laptop slept mid-Run" case, which today relies on whatever
polling loop happened to survive sleep (browsers throttle/suspend timers
while backgrounded, so the loop is often already dead by the time the tab
wakes — this effect gives it a deterministic restart point).

### 4. Surface connection state in the UI

Add one piece of state, `connectionState: "connected" | "lost"`, and render
it distinctly from the existing "Codex is reading, editing, or running
commands…" thinking indicator — e.g. a small banner: "Reconnecting to the
control plane…" This is the piece that actually fixes the *user-visible*
symptom: today a stalled poll and an Agent that is genuinely still working
look identical.

### Optional stretch: replace polling with push updates (SSE)

If time allows, add `GET /api/agents/:id/events` as a Server-Sent Events
stream that the `AgentService` progress hooks from
[`01-solution-durable-run-reconciliation.md`](./01-solution-durable-run-reconciliation.md)
publish to. The client would open an `EventSource` instead of polling, with
the resilient-polling design above kept as the automatic fallback when SSE
isn't available (e.g. behind a proxy that buffers responses). This is
explicitly optional — the retry/backoff/resync design already closes the
correctness gap without it, and SSE is a bigger, separate lift (new route,
connection-per-viewer bookkeeping, reconnection semantics of its own).

## Implementation steps

1. Add `apps/web/src/reconnect.ts` with `withRetry` and
   `isRetryableApiError` as pure, dependency-free functions.
2. Update `apps/web/src/api.ts` — no functional change needed, but confirm
   `ApiError` always carries `status` so `isRetryableApiError` can branch on
   it (it already does, per `api.ts:3-10`).
3. Update `apps/web/src/App.tsx`:
   - Wrap the network call inside `pollRun` with `withRetry`.
   - Add `connectionState` state and the banner.
   - Add the focus/online/visibilitychange effect.
4. Add a minimal frontend test setup (`apps/web` currently has none — see
   Tests to add).

## Failure / recovery case to demonstrate

1. Send a prompt that takes a few seconds to run.
2. While the Run is `running`, open browser devtools → Network → toggle
   **Offline**.
3. **Before this fix:** the first failed poll throws, the loop dies silently,
   the UI is stuck on the thinking spinner forever with no error, and no
   further requests are made even after re-enabling the network.
4. **After this fix:** the banner switches to "Reconnecting to the control
   plane…" (not stuck on "thinking"); toggle Network back to **Online** and
   show the poll recovering automatically within one backoff interval,
   catching up to the run's real status without the user touching anything.
5. Second demo: put the laptop to sleep (or throttle CPU heavily in
   devtools to simulate background tab suspension) mid-Run, wake it, and
   show the refocus effect immediately resyncing instead of waiting on a
   suspended timer.

## Tests to add

`apps/web` currently has no test runner configured (`package.json` only has
`dev`/`build`/`typecheck`). Add `vitest` as a devDependency (matching the
server's existing choice, so `npm run check` at the repo root can pick it up
consistently) and a `"test": "vitest run"` script. Because `withRetry` and
`isRetryableApiError` are pure functions with an injectable `sleep`, they are
testable without a DOM or React Testing Library:

- `reconnect.test.ts`:
  - retries on a network-shaped error and eventually succeeds, calling
    `sleep` with increasing delays capped at `maxDelayMs`.
  - stops retrying and rethrows immediately on a non-retryable `ApiError`
    (e.g. status 404).
  - gives up after `maxAttempts` and rethrows the last error.
- If React Testing Library is added later, a component-level test can mount
  `App`, mock `api.run` to fail N times then succeed, and assert the
  connection banner appears and clears — but this is a larger investment and
  not required to validate the core fix, which lives entirely in
  `reconnect.ts`.

## Limitations / out of scope

- This does not make the platform multi-viewer-aware — two browser tabs on
  the same Agent still poll independently; that is unchanged from today and
  not part of the disconnect problem.
- SSE (the optional stretch) is not required; resilient polling alone closes
  the correctness gap. Only add SSE if there's time left after §§1–4 and
  after [`01-solution-durable-run-reconciliation.md`](./01-solution-durable-run-reconciliation.md).
- Backoff parameters (`maxAttempts: 8`, `baseDelayMs: 1s`, `maxDelayMs: 15s`)
  are a starting point for the ~2-3 minute demo window, not a tuned
  production value.
