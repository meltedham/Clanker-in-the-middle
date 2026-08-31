# Access Control Middleware

Identity and access-control layer added on top of the Agent Launchpad starter kit.

## 1. The problem

The starter kit's only guard is one shared bearer token — anyone holding it can
read, edit, run, or delete every Agent. No accounts, no ownership, no way to share
one Agent without handing over full control, no limit on what files a running
Agent can actually touch.

## 2. Where enforcement lives

Every decision is made in `AgentService` (`apps/server/src/agent-service.ts`), not
in Fastify routes or the React UI. Hitting the raw API directly gets the same
refusals as the browser — the check is in the service layer every route goes
through.

- **`assertAccess(agent, actor, level, grants)`** — throws `403` unless `actor` may
  `"read"` or `"write"` `agent`. Order: no identity configured (bypass) → admin →
  owner → Grant (viewer = read only, operator = read+write).
- **`myRoleFor(agent, actor, grants)`** — same precedence, returns the role
  (`"owner" | "admin" | "operator" | "viewer" | null`) instead of throwing, for the UI.
- **`isOwnerOrAdmin(agent, actor)`** — stricter check for actions beyond ordinary
  write (§4).

## 3. Data model

```
User    { id, name, tokenHash, passwordHash?, role: "admin"|"member", createdAt }
Grant   { id, agentId, userId, role: "viewer"|"operator", createdAt, revokedAt }
Agent  += { ownerId, sandboxMode: "read-only"|"workspace-write" }
```

- `tokenHash` — SHA-256 (tokens are already high-entropy).
- `passwordHash` — `scrypt`, not SHA-256 (passwords are low-entropy, need a slow KDF).
  Optional; only accounts with one can use `/api/login`.
- `Grant` is re-checked on every request — revoking takes effect immediately, nothing
  is cached.
- `sandboxMode` is per-Agent, not platform-wide (§5). Old records without this field
  are backfilled to the platform default on load.
- Every actor parameter defaults to `null`, preserving single-user behavior for
  anyone who never creates a user.

## 4. Identity and roles

- **Signup** (`POST /api/users`) — name only required, password optional, no
  credential needed to call it.
- **Bootstrap admin** — first account ever created becomes `admin` automatically.
  Every account after that defaults to `member`; only an existing admin can create
  another admin.
- **Login** (`POST /api/login`) — name+password → fresh token, invalidates the old
  one (one session per account). Wrong password and unknown name both return the
  same `401`, so the response can't be used to enumerate names.
- **Legacy shared token** works only until the first account exists anywhere, then
  is never checked again for any route.
- **Admins bypass ownership** on every Agent, and can't be granted a role
  (`createGrant` refuses with `403` — a Grant on an admin would be meaningless and
  would falsely suggest they're limited to viewer/operator).

### Permission matrix

| Action | Owner | Admin | Operator (Grant) | Viewer (Grant) | No relationship |
|---|---|---|---|---|---|
| Read Agent / messages / runs | ✅ | ✅ | ✅ | ✅ | ❌ 403 |
| Edit name/description/instructions | ✅ | ✅ | ✅ | ❌ 403 | ❌ 403 |
| Send a message | ✅ | ✅ | ✅ | ❌ 403 | ❌ 403 |
| Start | ✅ | ✅ | ✅ | ❌ 403 | ❌ 403 |
| **Stop** | ✅ | ✅ | ❌ 403 | ❌ 403 | ❌ 403 |
| **Delete** | ✅ | ✅ | ❌ 403 | ❌ 403 | ❌ 403 |
| **Change sandbox policy** | ✅ | ✅ | ❌ 403 | ❌ 403 | ❌ 403 |
| Grant / revoke / list grants | ✅ | ✅ | ❌ 403 | ❌ 403 | ❌ 403 |

Bolded rows are stricter than plain write: an operator Grant lets you *use* an
Agent, not kill its run, destroy it, or widen what it can do. A user can never stop,
delete, or reconfigure another user's Agent — only its owner or an admin can.
(`stopAgent`/`deleteAgent` originally only required write, which let an operator
stop or delete an Agent they didn't own; both were tightened to `isOwnerOrAdmin`,
with tests proving the refusal.)

### Error messages are specific

A viewer denied on a write action is told they have read access, not that they have
none. The stricter checks each name exactly who is allowed ("Only the Agent's owner
or an admin can stop it"), never a generic "forbidden."

## 5. Per-Agent runtime policy

`sandboxMode`, chosen because it has a real, OS-enforced mechanism underneath —
Codex has no way to distinguish "an install command" from any other shell
command, so a fake per-command allow/deny list wouldn't be a real control.

- **`sandboxMode`** (UI label: "File access") — `read-only` or `workspace-write`,
  passed straight to Codex CLI's own `--sandbox` flag. Per-Agent now, previously
  one fixed value for the whole platform (`CODEX_SANDBOX_MODE` in `.env`).
  - No `danger-full-access` option: removed from the type, the per-Agent schema,
    and the platform env enum, not just the UI — it can't be set via API call or
    config either. Startup now refuses to run rather than silently falling back to
    it when Codex's Landlock sandbox is unavailable on the host kernel
    (`start-local-poc.sh`, `deploy-existing-ecs.sh`).

Changing it requires owner/admin, stricter than the "write" needed to edit an
Agent's name or instructions.

## 6. Web UI

- **Auth screen** — "Enter shared token"/"Sign up" before any account exists,
  "Log in"/"Sign up" after. Signup always sets a password and logs straight in.
- **Sidebar** — "Your Agents" vs. "Shared With You," fixed-height scrollable list,
  role badge next to your name.
- **Share panel** — grant/revoke `viewer`/`operator` for an existing user; admins
  excluded from the grantee dropdown. Active Grants always lists every admin too,
  labeled **"Admin · full access"** with an **"Unrevokable"** tag instead of Revoke.
- **Settings panel** — File access dropdown shown only to owner/admin. Shared
  Agents show a banner with your actual permission; a `viewer` sees disabled
  fields and no Save button.
- **Permission-denied notifications** — a `403` gets a distinct amber banner
  ("Permission denied: …"), auto-dismisses after 6 seconds like a toast.
- **Stop/Delete/Share/policy buttons** are hidden client-side for anyone who can't
  use them — cosmetic on top of the real server-side refusal, never a substitute.

## 7. API surface added

| Route | Auth | Notes |
|---|---|---|
| `POST /api/users` | none | Self-signup. Role/grant claims re-validated server-side regardless of what's sent. |
| `GET /api/users` | none | `{id, name}` only — never token or role. |
| `POST /api/login` | none | name+password → fresh token, invalidates the previous one. |
| `GET /api/whoami` | token | Your resolved identity, or `null`. |
| `POST /api/agents/:id/grants` | owner/admin | Upserts — re-granting changes the role, doesn't duplicate. |
| `GET /api/agents/:id/grants` | owner/admin | Real Grants + synthetic non-revocable admin entries. |
| `DELETE /api/agents/:id/grants/:grantId` | owner/admin | Immediate. |
| `GET /api/agents` | any | Each Agent includes `myRole` for the caller. |
| `POST` / `PATCH /api/agents` | varies | `PATCH` accepts `sandboxMode`, owner/admin-only. |

`GET /api/auth` also gained `identityEnabled`, so the frontend knows when the
shared token has permanently stopped working.

## 8. Testing

Real `AgentService` + real Fastify `app.inject` calls, no mocking of access-control
logic:

- `access-control.test.ts` (7) — baseline preserved with zero users; identity
  activates the moment the first account exists.
- `grants.test.ts` (17) — admin bootstrap/bypass, viewer vs. operator, live
  revocation, upsert-not-duplicate, owner-only grant management, admins can't be
  granted a role, operator can start but not stop/delete or change sandbox
  policy, an invalid or removed (`danger-full-access`) `sandboxMode` is rejected
  with `400` before reaching `AgentService`, `myRole` correctness.
- `password-login.test.ts` (5) — signup+login round trip, wrong password/unknown
  name → identical `401`, re-login rotates the token, duplicate names rejected.
- `agent-service.test.ts` — sandbox backfill reads the real configured default,
  not a hardcoded string; `systemInfo().runtimeProvider` reports the true
  configured value.
- `container-codex-runner.test.ts` — `--sandbox` actually changes based on the
  Agent's own policy.
- `sandbox-enforcement.test.ts` — real Docker + Codex's own Landlock, no model call
  involved: a write is genuinely blocked without a write grant, genuinely allowed
  inside the workspace with one, and still refused outside the workspace even then.
  Verifies the actual OS-level mechanism `sandboxMode` depends on, not just that the
  right flag is passed. Skips itself (with a clear message, not a failure) if the
  `volc-agent-launchpad:local` Runtime image hasn't been built locally.

Run everything: `npm run check`.

## 9. Known limitations

- **No message-level Grant scoping** — a viewer/operator sees an Agent's entire
  conversation history, not a per-grantee slice.
- **New routes don't auto-inherit protection** — a teammate's new endpoint starts
  unprotected until it explicitly calls into `AgentService`'s checks.
- **Self-signup is fully open** — anyone can create an account with just a name.
- **One active session per password account** — logging in again invalidates the
  previous token.
- **Stopping a run is shared between owner/admin** — either can stop a run the
  other started.
- **Requires Landlock on the host kernel** for `workspace-write` to mean anything —
  without it, startup refuses to run rather than downgrading to unrestricted access.

## 10. Trying it

`scripts/demo-access-control.sh` — scripted curl walkthrough (two accounts,
deny → grant → revoke). Short version:

```bash
curl -X POST http://localhost:3000/api/users -d '{"name":"Alice","password":"correct-horse-battery"}' -H 'Content-Type: application/json'
# -> first account: role "admin". Log in as Alice, create an Agent.
curl -X POST http://localhost:3000/api/users -d '{"name":"Bob","password":"another-long-one"}' -H 'Content-Type: application/json'
# -> "member". Bob reading Alice's Agent -> 403. Alice grants Bob "viewer" -> Bob can read, still 403 on write.
```
