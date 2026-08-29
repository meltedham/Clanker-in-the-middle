import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import type { AuthUser, Grant, GrantRole } from "./api";
import type { Agent, AgentRun, Message, SandboxMode, SystemInfo } from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDenied, setErrorDenied] = useState(false);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [identityEnabled, setIdentityEnabled] = useState(false);
  const [authInput, setAuthInput] = useState("");
  const [authMode, setAuthMode] = useState<"token" | "create" | "login">("token");
  const [newUserName, setNewUserName] = useState("");
  const [newUserPassword, setNewUserPassword] = useState("");
  const [loginName, setLoginName] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [whoami, setWhoami] = useState<AuthUser | null>(null);
  const [showShare, setShowShare] = useState(false);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [shareUserId, setShareUserId] = useState("");
  const [shareRole, setShareRole] = useState<GrantRole>("viewer");
  const [allUsers, setAllUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [policySandboxMode, setPolicySandboxMode] = useState<SandboxMode>("workspace-write");
  const [policyNetworkAccess, setPolicyNetworkAccess] = useState(true);
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const ownerName = useCallback(
    (ownerId: string) => allUsers.find((user) => user.id === ownerId)?.name ?? "Unclaimed",
    [allUsers],
  );

  // Without identity (or before allUsers has loaded), everything renders as
  // "yours" -- this only ever splits the list once whoami is populated, so
  // the single-user baseline UI is unaffected.
  const ownAgents = useMemo(
    () => agents.filter((agent) => !whoami || agent.ownerId === whoami.id),
    [agents, whoami],
  );
  const otherAgents = useMemo(
    () => agents.filter((agent) => whoami && agent.ownerId !== whoami.id),
    [agents, whoami],
  );

  // Mirrors the server's own rule: only the owner or an admin may change
  // sandbox/network policy or stop a run -- not merely anyone with write
  // access. Without identity, everyone is effectively the sole operator.
  // Owner/admin only -- mirrors the server's stricter checks on stopAgent,
  // deleteAgent, and sandbox/network policy. An operator Grant is enough to
  // *use* an Agent, not to destroy it, kill its active run, or reconfigure
  // how dangerous it's allowed to be.
  const canManagePolicy = useMemo(
    () =>
      !selected ||
      selected.myRole === null ||
      selected.myRole === "owner" ||
      selected.myRole === "admin",
    [selected],
  );

  // Starting is harmless (nothing is running yet), so it stays available to
  // an operator too -- only stopping and deleting are owner/admin-only.
  const canStart = useMemo(
    () =>
      !selected ||
      selected.myRole === null ||
      selected.myRole === "owner" ||
      selected.myRole === "admin" ||
      selected.myRole === "operator",
    [selected],
  );

  // Granting an admin a role is refused server-side (they already bypass
  // ownership entirely) -- derived from the Active Grants list itself
  // (loaded whenever Share is open), which always includes a synthetic
  // entry for every admin, so no separate lookup is needed.
  const adminUserIds = useMemo(
    () => new Set(grants.filter((grant) => grant.role === "admin").map((grant) => grant.userId)),
    [grants],
  );

  // Every catch block in this file routes through here instead of calling
  // setError directly, so a 403 (refused by assertAccess on the server --
  // read-only Grant tried a write, or a non-owner tried an owner-only
  // action) always gets the distinct "denied" banner, not the generic one.
  const reportError = (reason: unknown) => {
    if (reason instanceof ApiError && reason.status === 403) {
      setError(reason.message);
      setErrorDenied(true);
    } else {
      setError(reason instanceof Error ? reason.message : String(reason));
      setErrorDenied(false);
    }
  };

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([
      refreshAgents(),
      api.system().then(setSystem),
      api.whoami().then((result) => setWhoami(result.user)),
      api.listUsers().then((result) => setAllUsers(result.users)),
    ]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required, identityEnabled: enabled }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        setIdentityEnabled(enabled);
        // Once any account exists anywhere, the shared token can never work
        // again -- default straight to the screen that actually applies.
        setAuthMode(enabled ? "login" : "token");
        if (!required) await bootstrap();
      })
      .catch((reason) => reportError(reason));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setShowSettings(false);
    setShowShare(false);
    if (!selectedId) {
      setMessages([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), api.runs(selectedId)])
      .then(([, result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) =>
            reportError(reason),
          );
        }
      })
      .catch((reason) =>
        reportError(reason),
      );
  }, [refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
      });
      setPolicySandboxMode(selected.sandboxMode);
      setPolicyNetworkAccess(selected.networkAccess);
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  // Auto-dismiss: a banner that persists until you click something else is
  // an interruption, not a notification. The × button still works for
  // dismissing it early.
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => {
      setError(null);
      setErrorDenied(false);
    }, 6000);
    return () => window.clearTimeout(timer);
  }, [error]);

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(form);
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      reportError(reason);
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, {
        ...form,
        // Only ever included when the controls are actually shown, so an
        // operator's ordinary edit never trips the owner/admin-only check.
        ...(canManagePolicy
          ? { sandboxMode: policySandboxMode, networkAccess: policyNetworkAccess }
          : {}),
      });
      await refreshAgents();
      setShowSettings(false);
    } catch (reason) {
      reportError(reason);
    } finally {
      setBusy(false);
    }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      reportError(reason);
    } finally {
      setBusy(false);
    }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      reportError(reason);
    } finally {
      setBusy(false);
    }
  };

  const openShare = async () => {
    if (!selected) return;
    setShowShare(true);
    setShowSettings(false);
    setError(null);
    try {
      const [grantsResult, usersResult] = await Promise.all([
        api.listGrants(selected.id),
        api.listUsers(),
      ]);
      setGrants(grantsResult.grants);
      setUsers(usersResult.users);
    } catch (reason) {
      reportError(reason);
    }
  };

  const submitShare = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !shareUserId) return;
    setBusy(true);
    setError(null);
    try {
      await api.createGrant(selected.id, shareUserId, shareRole);
      const refreshedGrants = await api.listGrants(selected.id);
      setGrants(refreshedGrants.grants);
    } catch (reason) {
      reportError(reason);
    } finally {
      setBusy(false);
    }
  };

  const revokeGrant = async (grantId: string) => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.revokeGrant(selected.id, grantId);
      setGrants((current) => current.filter((grant) => grant.id !== grantId));
    } catch (reason) {
      reportError(reason);
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
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

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      reportError(reason);
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
        setErrorDenied(false);
      } else {
        reportError(reason);
      }
    } finally {
      setBusy(false);
    }
  };

  const createAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.createUser(newUserName.trim(), { password: newUserPassword });
      setAuthToken(result.token);
      await bootstrap();
      setAuthRequired(false);
      setIdentityEnabled(true);
      setAuthMode("login");
      setNewUserName("");
      setNewUserPassword("");
    } catch (reason) {
      reportError(reason);
    } finally {
      setBusy(false);
    }
  };

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(loginName.trim(), loginPassword);
      setAuthToken(result.token);
      await bootstrap();
      setAuthRequired(false);
      setAuthMode("login");
      setLoginName("");
      setLoginPassword("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("That name and password don't match an account.");
        setErrorDenied(false);
      } else {
        reportError(reason);
      }
    } finally {
      setBusy(false);
    }
  };

  const logout = () => {
    setAuthToken("");
    setWhoami(null);
    setAgents([]);
    setSelectedId(null);
    setMessages([]);
    setError(null);
    setAuthRequired(true);
    // Identity is guaranteed active by now -- you can't log out without
    // having logged in first -- so "log in" is always the right next step.
    setAuthMode("login");
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? (
            <div className={"error-banner" + (errorDenied ? " error-banner-denied" : "")} role="alert">
              {errorDenied ? "Permission denied: " : ""}
              {error}
            </div>
          ) : (
            <Spinner />
          )}
        </section>
      </main>
    );
  }

  if (authRequired) {
    if (authMode === "create") {
      return (
        <main className="auth-screen">
          <form className="auth-card" onSubmit={createAccount}>
            <div className="brand-mark">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Sign up</h1>
            <p>Pick a name and password — that's your account, no email needed.</p>
            {error && (
              <div className={"error-banner" + (errorDenied ? " error-banner-denied" : "")} role="alert">
                {errorDenied ? "Permission denied: " : ""}
                {error}
              </div>
            )}
            <label>
              Name
              <input
                autoFocus
                value={newUserName}
                onChange={(event) => setNewUserName(event.target.value)}
                placeholder="Alice"
                required
                maxLength={80}
              />
            </label>
            <label>
              Password (8+ characters)
              <input
                type="password"
                value={newUserPassword}
                onChange={(event) => setNewUserPassword(event.target.value)}
                autoComplete="new-password"
                minLength={8}
                maxLength={200}
                required
              />
            </label>
            <button
              className="button button-primary"
              disabled={busy || !newUserName.trim() || newUserPassword.length < 8}
            >
              {busy ? <Spinner /> : "Sign up"}
            </button>
            <button
              type="button"
              className="button button-ghost"
              onClick={() => {
                setAuthMode(identityEnabled ? "login" : "token");
                setError(null);
              }}
            >
              {identityEnabled ? "I already have an account" : "Use the shared access token instead"}
            </button>
          </form>
        </main>
      );
    }

    if (authMode === "login") {
      return (
        <main className="auth-screen">
          <form className="auth-card" onSubmit={login}>
            <div className="brand-mark">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Log in</h1>
            <p>Enter the name and password you signed up with.</p>
            {error && (
              <div className={"error-banner" + (errorDenied ? " error-banner-denied" : "")} role="alert">
                {errorDenied ? "Permission denied: " : ""}
                {error}
              </div>
            )}
            <label>
              Name
              <input
                autoFocus
                value={loginName}
                onChange={(event) => setLoginName(event.target.value)}
                placeholder="Alice"
                required
                maxLength={80}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <button
              className="button button-primary"
              disabled={busy || !loginName.trim() || !loginPassword}
            >
              {busy ? <Spinner /> : "Log in"}
            </button>
            <button
              type="button"
              className="button button-ghost"
              onClick={() => {
                setAuthMode("create");
                setError(null);
              }}
            >
              Sign up instead
            </button>
          </form>
        </main>
      );
    }

    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && (
              <div className={"error-banner" + (errorDenied ? " error-banner-denied" : "")} role="alert">
                {errorDenied ? "Permission denied: " : ""}
                {error}
              </div>
            )}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
          <button
            type="button"
            className="button button-ghost"
            onClick={() => {
              setAuthMode("create");
              setError(null);
            }}
          >
            Sign up instead
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="agent-lists">
          <div className="sidebar-label">
            <span>Your Agents</span>
            <span>{ownAgents.length}</span>
          </div>
          <nav className="agent-list">
            {ownAgents.map((agent) => (
              <button
                className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
                key={agent.id}
                onClick={() => setSelectedId(agent.id)}
              >
                <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
                <div className="agent-card-copy">
                  <strong>{agent.name}</strong>
                  <span>{agent.description || "Coding Agent"}</span>
                </div>
                <span className={"mini-dot mini-" + agent.status} />
              </button>
            ))}
            {ownAgents.length === 0 && (
              <div className="empty-sidebar">
                <span>◇</span>
                Create your first coding Agent.
              </div>
            )}
          </nav>

          {otherAgents.length > 0 && (
            <>
              <div className="sidebar-label">
                <span>
                  {whoami?.role === "admin" ? "Everyone Else's Agents" : "Shared With You"}
                </span>
                <span>{otherAgents.length}</span>
              </div>
              <nav className="agent-list">
                {otherAgents.map((agent) => (
                  <button
                    className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
                    key={agent.id}
                    onClick={() => setSelectedId(agent.id)}
                  >
                    <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
                    <div className="agent-card-copy">
                      <strong>{agent.name}</strong>
                      <span>Owned by {ownerName(agent.ownerId)}</span>
                    </div>
                    <span className={"mini-dot mini-" + agent.status} />
                  </button>
                ))}
              </nav>
            </>
          )}
        </div>

        <div className="sidebar-footer">
          {whoami && (
            <div className="identity-card">
              <span className="eyebrow">Signed in as</span>
              <strong>
                {whoami.name} <span className={"role-pill role-" + whoami.role}>{whoami.role}</span>
              </strong>
              <button type="button" onClick={logout}>
                Switch user
              </button>
            </div>
          )}
          <div className="runtime-card">
            <span className="eyebrow">Runtime</span>
            <strong>{system?.runtime ?? "Checking…"}</strong>
            <span>
              {system?.arkModel ?? "Ark model not configured"}
              {system?.containerEngine ? " · " + system.containerEngine : ""}
            </span>
          </div>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className={"error-banner" + (errorDenied ? " error-banner-denied" : "")} role="alert">
            <span>{errorDenied ? "Permission denied: " : ""}{error}</span>
            <button
              onClick={() => {
                setError(null);
                setErrorDenied(false);
              }}
            >
              ×
            </button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                  {whoami && selected.ownerId !== whoami.id && (
                    <span className="role-pill role-viewer">
                      owned by {ownerName(selected.ownerId)}
                    </span>
                  )}
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                {whoami && (selected.myRole === "admin" || selected.myRole === "owner") && (
                  <button
                    className="button button-ghost"
                    onClick={() => (showShare ? setShowShare(false) : openShare())}
                    disabled={busy}
                  >
                    Share
                  </button>
                )}
                <button
                  className="button button-ghost"
                  onClick={() => {
                    setShowSettings((value) => !value);
                    setShowShare(false);
                  }}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                {(selected.status === "stopped" ? canStart : canManagePolicy) && (
                  <button className="button button-ghost" onClick={toggleAgent} disabled={busy}>
                    {selected.status === "stopped" ? "Start" : "Stop"}
                  </button>
                )}
                {canManagePolicy && (
                  <button
                    className="button button-danger"
                    onClick={deleteAgent}
                    disabled={busy || selected.status === "busy"}
                  >
                    Delete
                  </button>
                )}
              </div>
            </header>

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>

                {(selected.myRole === "viewer" || selected.myRole === "operator") && (
                  <div className={"role-pill role-" + selected.myRole + " permission-summary"}>
                    {selected.myRole === "operator"
                      ? "You have Read + Write access to this Agent (shared with you)."
                      : "You have Read only access to this Agent (shared with you)."}
                  </div>
                )}

                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      disabled={selected.myRole === "viewer"}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      disabled={selected.myRole === "viewer"}
                      maxLength={500}
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    disabled={selected.myRole === "viewer"}
                    rows={5}
                    maxLength={10_000}
                  />
                </label>

                {canManagePolicy && (
                  <div className="form-grid runtime-policy">
                    {system?.runtimeProvider !== "container" && (
                      <div className="runtime-policy-warning">
                        Network access can't actually be restricted right now: this
                        Runtime is running Codex as a host process ({system?.runtime
                          ?? "local-process"}), which has no container boundary to cut
                        network from. The setting below is saved but has no effect
                        until this instance runs with RUNTIME_PROVIDER=container.
                      </div>
                    )}
                    <label>
                      File access
                      <select
                        value={policySandboxMode}
                        onChange={(event) =>
                          setPolicySandboxMode(event.target.value as SandboxMode)
                        }
                      >
                        <option value="read-only">Read only (can view files, can't change them)</option>
                        <option value="workspace-write">Read + write, workspace only (default)</option>
                      </select>
                    </label>
                    <label>
                      Network access
                      <select
                        value={policyNetworkAccess ? "on" : "off"}
                        onChange={(event) => setPolicyNetworkAccess(event.target.value === "on")}
                      >
                        <option value="on">On</option>
                        <option value="off">Off (blocks installs, API calls, etc.)</option>
                      </select>
                    </label>
                  </div>
                )}

                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  {selected.myRole !== "viewer" && (
                    <button className="button button-primary" disabled={busy}>
                      {busy ? <Spinner /> : "Save changes"}
                    </button>
                  )}
                </div>
              </form>
            )}

            {showShare && (
              <form className="settings-panel" onSubmit={submitShare}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Access control</span>
                    <h2>Share this Agent</h2>
                  </div>
                  <button type="button" onClick={() => setShowShare(false)}>×</button>
                </div>

                <div className="form-grid">
                  <label>
                    User
                    <select
                      value={shareUserId}
                      onChange={(event) => setShareUserId(event.target.value)}
                      required
                    >
                      <option value="" disabled>
                        Choose a user
                      </option>
                      {users
                        .filter((user) => user.id !== whoami?.id && !adminUserIds.has(user.id))
                        .map((user) => (
                          <option key={user.id} value={user.id}>
                            {user.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    Role
                    <select
                      value={shareRole}
                      onChange={(event) => setShareRole(event.target.value as GrantRole)}
                    >
                      <option value="viewer">Viewer (read-only)</option>
                      <option value="operator">Operator (read + write)</option>
                    </select>
                  </label>
                </div>

                <div className="grants-list">
                  <span className="eyebrow">Active grants</span>
                  {grants.every((grant) => !grant.revocable) && (
                    <p className="muted">No one else has been granted access yet.</p>
                  )}
                  {grants.map((grant) => (
                    <div className="grant-row" key={grant.id}>
                      <span>{grant.userName}</span>
                      <span className={"role-pill role-" + grant.role}>
                        {grant.role === "admin"
                          ? "Admin · full access"
                          : grant.role === "operator"
                            ? "Read + Write"
                            : "Read only"}
                      </span>
                      {grant.revocable ? (
                        <button type="button" onClick={() => revokeGrant(grant.id)} disabled={busy}>
                          Revoke
                        </button>
                      ) : (
                        <span className="grant-unrevocable">Unrevokable</span>
                      )}
                    </div>
                  ))}
                </div>

                <div className="panel-footer">
                  <span />
                  <button className="button button-primary" disabled={busy || !shareUserId}>
                    {busy ? <Spinner /> : "Share"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {activeRun?.status === "failed" && (
                  <article className="run-error">
                    <strong>Run failed</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
