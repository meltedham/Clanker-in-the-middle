# Disconnect persistence: investigation and solutions

This folder investigates why the platform loses information whenever a Run
is interrupted, and proposes three implementation-ready solutions. Start
with the root-cause document, then read the solution docs in order.

## Overall status: all three solutions implemented, Solution 3 rebuilt as real middleware (2026-08-29)

All three solutions have working, tested code in this repo, not just design
docs — see each doc's own "Implementation status" section for exact files,
deviations, and gaps. Quick summary for anyone resuming this work:

| Solution | Status | Verified by |
| --- | --- | --- |
| 1. Durable Run Reconciliation | Done | Unit tests (mocked `AgentRunner`); **not** exercised against a real `docker`/Codex process |
| 3. Run Event Trace | Done, and refactored into an `AgentRunner`-wrapping middleware (`apps/server/src/middleware/`) | Unit tests + `npm run build` for both workspaces; UI panel exists but only shows `summary`, not `detail` |
| 2. Client Reconnect Resilience | Done, SSE stretch skipped | Unit tests for `reconnect.ts`; **not** clicked through in a real browser |

**On the middleware refactor:** the first pass of Solution 3 worked but
called trace-writing code directly from inside `AgentService` — functionally
correct, but not "middleware" in the sense the hackathon brief (`bff.pdf`)
and `AGENT_BRIEF.md` mean by the term (a capability layered on at a defined
boundary, not woven into the Control Plane). After explicit feedback on
this, it was rebuilt as `middleware/observability-runner.ts`
(`ObservabilityRunner implements AgentRunner`), composed once in
`runner-factory.ts`. `AgentService` now has zero dependency on tracing.
Read [`03-solution-run-event-trace-log.md`](./03-solution-run-event-trace-log.md)'s
"Implementation status" section for the full before/after, and
[`docs/ARCHITECTURE.md`](../ARCHITECTURE.md#middleware) for the boundary
writeup that got added there as a result. **Solution 1's reconciliation
policy deliberately stayed inside `AgentService`** — per `bff.pdf`'s own
layered-architecture table, "Run orchestration and reconciliation" is
explicitly the Control Plane's job, not Observability's; only the
trace-*writing* side effect was ever a middleware candidate.

**To verify the current state from a fresh session:**

```sh
npm install                          # if node_modules isn't present yet
npm run typecheck                    # both workspaces, should be clean
npm run test -w @launchpad/server    # 32/33 pass -- see note below
npm run test -w @launchpad/web       # 7/7 pass
npm run build -w @launchpad/server   # tsc compile
npm run build -w @launchpad/web      # vite build
```

`npm run check` at the repo root chains `typecheck && test && build` and
will **stop after the server test step** because of one failing test,
`container-codex-runner.test.ts > builds an isolated Docker/Podman-compatible
invocation`. This failure is **pre-existing and unrelated to this work** —
confirmed via `git diff` that the test file was never touched here. It's a
Windows-only path-separator mismatch (`path.resolve("/tmp/codex-home")`
normalizes differently on Windows than the test's hard-coded Unix-style
assertion expects), and the repo's own docs already scope this project to
macOS/Linux. Don't spend time on it as part of this thread of work unless
the user asks; if you do fix it, it's an easy fix — a cross-platform
substring/path comparison in that one test.

**What a future session should do next, roughly in priority order:**

1. **Exercise Solution 1 against a real container engine.** Everything was
   validated with a mocked `AgentRunner`; nobody has actually started a Run
   under `RUNTIME_PROVIDER=container`, killed the server mid-run, and
   watched `ContainerCodexRunner.reconcile()` really run `docker ps` /
   `docker logs -f` against a live Docker/Colima/Podman daemon. This is the
   single most valuable thing to do before calling any of this demo-ready,
   since it's also the flagship "before vs. after" demo moment.
2. **Click through Solution 2's demo by hand** (DevTools offline toggle,
   laptop sleep/wake) — no browser tooling was available in the session that
   built this, so the UI change compiles and its pure logic is unit tested,
   but nobody has watched the "Reconnecting to the control plane…" banner
   actually appear and clear.
3. **Optional:** surface `RunEvent.detail` in the Solution 3 trace panel
   (currently captured and redacted, not rendered) if richer inspection is
   wanted for the live demo.
4. **Optional / explicitly out of scope unless asked:** the SSE stretch
   from Solution 2, and fixing the pre-existing Windows path test noted
   above.

**Everything below this point is the original design writeup**, kept as-is
since it's still an accurate description of intent — the "Implementation
status" sections inside each solution doc are where the as-built reality
and any deviations are recorded.

| Doc | What it covers |
| --- | --- |
| [`00-problem-disconnect-persistence.md`](./00-problem-disconnect-persistence.md) | Root cause: three kinds of "disconnect" (server, runner, client), traced to specific lines in `agent-service.ts`, `codex-runner.ts`, `container-codex-runner.ts`, and `App.tsx`. |
| [`01-solution-durable-run-reconciliation.md`](./01-solution-durable-run-reconciliation.md) | Server/runner side: stop discarding thread IDs and partial transcripts on cancellation or restart; reattach to still-running containers instead of blindly marking Runs `cancelled`. |
| [`02-solution-client-reconnect-resilience.md`](./02-solution-client-reconnect-resilience.md) | Client side: retry/backoff the poll loop instead of dying on the first network blip; resync on tab refocus; surface "reconnecting" distinctly from "thinking." |
| [`03-solution-run-event-trace-log.md`](./03-solution-run-event-trace-log.md) | Observability: persist an append-only per-Run event trace so the reconciliation behavior from Solution 1 is inspectable evidence, not just an inference from a status field. |

## Why three separate docs instead of one

The three problems live at different architecture boundaries (server
process ↔ runner, browser ↔ API, and a new observability layer) and can be
implemented, tested, and demoed independently. A team with limited time can
ship Solution 1 alone and already have a materially different, demoable
outcome; Solutions 2 and 3 are additive, not prerequisites for each other.
Solution 3 does assume Solution 1's callback hooks exist (noted in its own
Limitations section), but degrades gracefully without them.

## Suggested build order

1. **Solution 1** first — it's the actual data-loss fix and the one with
   the highest-value "before vs. after" demo (kill the server mid-run,
   watch the thread survive instead of resetting).
2. **Solution 3** second — cheap to add once Solution 1's hooks exist, and
   converts Solution 1's fix into visible, reviewable evidence, which is
   worth more in evaluation than the fix alone.
3. **Solution 2** third, or in parallel if two people are working — it's
   independent of the other two and has its own clean, self-contained demo
   (toggle DevTools offline/online).

If time only allows one: do Solution 1. It's the only one of the three that
fixes an actual correctness bug (data silently discarded) rather than a
visibility/UX gap.

## How this maps to the hackathon brief

Per `bff.pdf` §7, this work sits mainly in **lifecycle reconciliation and
failure recovery** (an explicitly named "Other Team-Designed Middleware"
direction), with Solution 3 doubling as a lightweight instance of the
**Trace, Audit, and Observability** track and Solution 2 as **Reliability**
in the same spirit. Each solution doc already follows the brief's required
shape for a middleware submission (§4 and §9–11 of `bff.pdf`):

- a stated problem and architecture boundary (which component owns the
  decision, what data crosses the boundary),
- real backend/Runtime behavior, not a UI-only change,
- a specific failure/recovery case to demo,
- automated tests to add,
- explicitly stated limitations.

Each doc's "Failure / recovery case to demonstrate" section can be used
directly as the three-minute live demo script (`bff.pdf` §8), and the
per-doc "Architecture boundary" tables can be merged into the one-page
architecture diagram required as a deliverable.
