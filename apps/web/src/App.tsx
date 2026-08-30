import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import { isRetryableApiError, withRetry } from "./reconnect";
import type { AuthUser, Grant, GrantRole } from "./api";
import type {
  Agent,
  AgentRun,
  Message,
  ResourceSummary,
  RunEvent,
  SandboxMode,
  SystemInfo,
} from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyResourceForm = {
  name: "",
  content: "",
};

type AgentFormState = {
  name: string;
  description: string;
  instructions: string;
  tokenBudgetMode: "unlimited" | "limited";
  tokenBudgetValue: string;
};

const emptyForm: AgentFormState = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
  tokenBudgetMode: "unlimited",
  tokenBudgetValue: "",
};

function countRunTokens(usage: AgentRun["usage"]): number {
  return (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
}

function formatTokenBudget(tokenBudget: number | null): string {
  return tokenBudget === null ? "Unlimited" : tokenBudget.toLocaleString() + " tokens";
}

function formatTokenCount(tokenCount: number): string {
  return tokenCount.toLocaleString() + " tokens";
}

function resolveTokenBudget(form: AgentFormState): number | null {
  if (form.tokenBudgetMode === "unlimited") {
    return null;
  }
  const parsed = Number.parseInt(form.tokenBudgetValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Token budget must be a positive whole number or set to unlimited.");
  }
  return parsed;
}

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

function retrievalLabel(status: NonNullable<AgentRun["retrieval"]>["status"]): string {
  switch (status) {
    case "no_context":
      return "No context";
    case "weak":
      return "Weak";
    case "moderate":
      return "Moderate";
    case "strong":
      return "Strong";
    default:
      return status;
  }
}

function RetrievalBadge({ retrieval }: { retrieval: NonNullable<AgentRun["retrieval"]> }) {
  return (
    <div className={"retrieval-badge retrieval-" + retrieval.status}>
      <span>Context</span>
      <strong>{retrievalLabel(retrieval.status)}</strong>
      <span>{Math.round(retrieval.confidence * 100)}% match</span>
      <small>
        {retrieval.matchCount}/{retrieval.candidateCount} chunks
      </small>
    </div>
  );
}

async function fileToUploadBody(file: File): Promise<{
  name: string;
  contentBase64: string;
  mimeType: string;
}> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return {
    name: file.name,
    contentBase64: btoa(binary),
    mimeType: file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain"),
  };
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [uploads, setUploads] = useState<ResourceSummary[]>([]);
  const [sharedResources, setSharedResources] = useState<ResourceSummary[]>([]);
  const [uploadForm, setUploadForm] = useState(emptyResourceForm);
  const [sharedForm, setSharedForm] = useState(emptyResourceForm);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [sharedFile, setSharedFile] = useState<File | null>(null);
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [connectionState, setConnectionState] = useState<"connected" | "lost">("connected");
  const [showTrace, setShowTrace] = useState(false);
  const [traceEvents, setTraceEvents] = useState<RunEvent[] | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);
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
  const [showResources, setShowResources] = useState(false);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [shareUserId, setShareUserId] = useState("");
  const [shareRole, setShareRole] = useState<GrantRole>("viewer");
  const [allUsers, setAllUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [policySandboxMode, setPolicySandboxMode] = useState<SandboxMode>("workspace-write");
  const [policyNetworkAccess, setPolicyNetworkAccess] = useState(true);
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const activeRunRef = useRef<AgentRun | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;
  activeRunRef.current = activeRun;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const tokenUsage = useMemo(
    () => runs.reduce((total, run) => total + countRunTokens(run.usage), 0),
    [runs],
  );

  const tokenBudgetRemaining = useMemo(() => {
    if (!selected || selected.tokenBudget === null) return null;
    return Math.max(selected.tokenBudget - tokenUsage, 0);
  }, [selected, tokenUsage]);

  const tokenBudgetProgress = useMemo(() => {
    if (!selected || selected.tokenBudget === null || selected.tokenBudget === 0) return 0;
    return Math.min(100, (tokenUsage / selected.tokenBudget) * 100);
  }, [selected, tokenUsage]);

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

  // Owner/admin only -- mirrors the server's stricter checks on stopAgent,
  // deleteAgent, and sandbox/network policy. An operator Grant is enough to
  // *use* an Agent, not to destroy it, kill its active run, or reconfigure
  // how dangerous it's allowed to be. Without identity, everyone is
  // effectively the sole operator.
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

  const refreshUploads = useCallback(async (agentId: string) => {
    const result = await api.uploads(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setUploads(result.uploads);
    }
  }, []);

  const refreshSharedResources = useCallback(async () => {
    const result = await api.sharedResources();
    if (mountedRef.current) {
      setSharedResources(result.resources);
    }
  }, []);

  const refreshRuns = useCallback(async (agentId: string) => {
    const result = await api.runs(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setRuns(result.runs);
    }
    return result;
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([
      refreshAgents(),
      refreshSharedResources(),
      api.system().then(setSystem),
      api.whoami().then((result) => setWhoami(result.user)),
      api.listUsers().then((result) => setAllUsers(result.users)),
    ]);
  }, [refreshAgents, refreshSharedResources]);

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
    setShowResources(false);
    setShowTrace(false);
    setTraceEvents(null);
    setConnectionState("connected");
    if (!selectedId) {
      setMessages([]);
      setUploads([]);
      setRuns([]);
      return;
    }
    void Promise.all([refreshMessages(selectedId), refreshUploads(selectedId), refreshRuns(selectedId)])
      .then(([, , result]) => {
        if (selectedIdRef.current !== selectedId) return;
        const latest = result.runs[0] ?? null;
        setActiveRun(latest);
        if (latest && ["queued", "running"].includes(latest.status)) {
          void pollRun(latest.id, selectedId).catch((reason) => reportError(reason));
        }
      })
      .catch((reason) => reportError(reason));
  }, [refreshMessages, refreshUploads, refreshRuns, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
        tokenBudgetMode: selected.tokenBudget === null ? "unlimited" : "limited",
        tokenBudgetValue: selected.tokenBudget === null ? "" : String(selected.tokenBudget),
      });
      setPolicySandboxMode(selected.sandboxMode);
      setPolicyNetworkAccess(selected.networkAccess);
    }
  }, [selected]);

  useEffect(() => {
    setUploadFile(null);
    setUploadForm(emptyResourceForm);
  }, [selectedId]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  useEffect(() => {
    const resync = () => {
      const agentId = selectedIdRef.current;
      if (!agentId || !mountedRef.current) return;
      void refreshAgents();
      void refreshMessages(agentId);
      const run = activeRunRef.current;
      // pollRun's own `pollingRunIds` guard makes a redundant call a safe no-op.
      if (run && ["queued", "running"].includes(run.status)) {
        void pollRun(run.id, agentId);
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") resync();
    };
    window.addEventListener("focus", resync);
    window.addEventListener("online", resync);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", resync);
      window.removeEventListener("online", resync);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshAgents, refreshMessages]);

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
      const { agent } = await api.createAgent({
        name: form.name,
        description: form.description,
        instructions: form.instructions,
        tokenBudget: resolveTokenBudget(form),
      });
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
        name: form.name,
        description: form.description,
        instructions: form.instructions,
        tokenBudget: resolveTokenBudget(form),
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

  const killAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.killAgent(selected.id);
      await refreshAgents();
      await refreshMessages(selected.id);
      setActiveRun(null);
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
    setShowResources(false);
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

  const publishSharedResource = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    setBusy(true);
    setError(null);
    try {
      const payload = sharedFile
        ? {
            ...sharedForm,
            ...(await fileToUploadBody(sharedFile)),
            name: sharedForm.name.trim() || sharedFile.name,
          }
        : sharedForm;
      await api.createSharedResource(payload);
      formElement.reset();
      setSharedForm(emptyResourceForm);
      setSharedFile(null);
      await refreshSharedResources();
    } catch (reason) {
      reportError(reason);
    } finally {
      setBusy(false);
    }
  };

  const uploadWorkspaceResource = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const formElement = event.currentTarget;
    setBusy(true);
    setError(null);
    try {
      const payload = uploadFile
        ? {
            ...uploadForm,
            ...(await fileToUploadBody(uploadFile)),
            name: uploadForm.name.trim() || uploadFile.name,
          }
        : uploadForm;
      await api.uploadAgentResource(selected.id, payload);
      formElement.reset();
      setUploadForm(emptyResourceForm);
      setUploadFile(null);
      await refreshUploads(selected.id);
    } catch (reason) {
      reportError(reason);
    } finally {
      setBusy(false);
    }
  };

  const deleteShared = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteSharedResource(name);
      await refreshSharedResources();
    } catch (reason) {
      reportError(reason);
    } finally {
      setBusy(false);
    }
  };

  const deleteUpload = async (name: string) => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgentUpload(selected.id, name);
      await refreshUploads(selected.id);
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
        let result: { run: AgentRun };
        try {
          result = await withRetry(() => api.run(runId), {
            maxAttempts: 8,
            baseDelayMs: 1_000,
            maxDelayMs: 15_000,
            isRetryable: isRetryableApiError,
          });
        } catch {
          // Exhausted the retry budget (roughly two minutes) for this tick.
          // Don't give up on the Run -- the server may still finish it --
          // just surface that the connection is unhealthy and let the
          // outer 900ms loop try again on the next tick.
          if (mountedRef.current) setConnectionState("lost");
          continue;
        }
        if (mountedRef.current) setConnectionState("connected");
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        // Orchestration Runs stay "running" across every delegation/creation
        // round, so refresh the sidebar on every tick -- otherwise newly
        // created sub-agents stay invisible until the whole chain finishes.
        if (mountedRef.current) void refreshAgents();
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshRuns(agentId), refreshAgents()]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const toggleTrace = async () => {
    if (showTrace) {
      setShowTrace(false);
      return;
    }
    setShowTrace(true);
    if (!activeRun) return;
    setTraceLoading(true);
    try {
      const result = await api.trace(activeRun.id);
      setTraceEvents(result.events);
    } catch (reason) {
      reportError(reason);
    } finally {
      setTraceLoading(false);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    if (selected.status === "busy" || (activeRun != null && ["queued", "running"].includes(activeRun.status))) {
      setError("This Agent is still working on the previous message.");
      return;
    }
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) =>
          result.assistantMessage
            ? [...current, result.message, result.assistantMessage]
            : [...current, result.message],
        );
        setActiveRun(result.run);
        setRuns((current) => [result.run, ...current.filter((run) => run.id !== result.run.id)]);
      }
      if (["queued", "running"].includes(result.run.status)) {
        setAgents((current) =>
          current.map((agent) =>
            agent.id === selected.id ? { ...agent, status: "busy" } : agent,
          ),
        );
        await pollRun(result.run.id, selected.id);
      } else {
        await refreshAgents();
        await refreshMessages(selected.id);
      }
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 409) {
        setError(selected.lastError ?? "This Agent is still working on the previous message.");
        setErrorDenied(false);
      } else {
        reportError(reason);
      }
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
              {system?.openRouterModel ?? "OpenRouter model not configured"}
              {system?.containerEngine ? " · " + system.containerEngine : ""}
            </span>
          </div>
        </div>
      </aside>

      <main className="main">
        {!system?.openRouterConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.openRouterConfigured
                  ? "Set OPENROUTER_API_KEY and OPENROUTER_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {connectionState === "lost" && (
          <div className="connection-banner" role="status">
            <Spinner />
            Reconnecting to the control plane…
          </div>
        )}

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
                <p>Token budget: {formatTokenBudget(selected.tokenBudget)}</p>
              </div>
              {selected.lastError && (
                <div className="agent-notice" role="status" aria-live="polite">
                  <strong>Paused</strong>
                  <span>{selected.lastError}</span>
                </div>
              )}
              <div className="usage-card" aria-label="Token usage summary">
                <div className="usage-card-header">
                  <span className="eyebrow">Usage</span>
                  <strong>
                    {selected.tokenBudget === null ? "Unlimited" : `${Math.round(tokenBudgetProgress)}%`}
                  </strong>
                </div>
                <div className="usage-meter" aria-hidden="true">
                  <div
                    className="usage-meter-fill"
                    style={{ width: selected.tokenBudget === null ? "100%" : `${tokenBudgetProgress}%` }}
                  />
                </div>
                <div className="usage-meta">
                  <span>{formatTokenCount(tokenUsage)} used</span>
                  <span>
                    {selected.tokenBudget === null
                      ? `${runs.length} runs logged`
                      : `${formatTokenCount(tokenBudgetRemaining ?? 0)} remaining`}
                  </span>
                </div>
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
                    setShowResources((value) => !value);
                    setShowSettings(false);
                    setShowShare(false);
                  }}
                  disabled={busy}
                >
                  Resources
                </button>
                <button
                  className="button button-ghost"
                  onClick={() => {
                    setShowSettings((value) => !value);
                    setShowShare(false);
                    setShowResources(false);
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
                {selected.status === "busy" && canManagePolicy && (
                  <button
                    className="button button-danger"
                    onClick={killAgent}
                    disabled={busy}
                    title="Force-terminate the active run and clean up the workspace"
                  >
                    Kill switch
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
              <div className="modal-backdrop" onMouseDown={() => setShowSettings(false)}>
              <form
                className="modal settings-panel"
                onSubmit={saveAgent}
                onMouseDown={(event) => event.stopPropagation()}
              >
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
                <div className="form-grid">
                  <label>
                    Token budget
                    <select
                      value={form.tokenBudgetMode}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          tokenBudgetMode: event.target.value === "limited" ? "limited" : "unlimited",
                        })
                      }
                    >
                      <option value="unlimited">Unlimited</option>
                      <option value="limited">Allocate tokens</option>
                    </select>
                  </label>
                  <label>
                    Budget amount
                    <div
                      className={
                        "token-budget-shell " +
                        (form.tokenBudgetMode === "unlimited" ? "token-budget-shell-disabled" : "")
                      }
                    >
                      <input
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        placeholder="50000"
                        value={form.tokenBudgetValue}
                        onChange={(event) =>
                          setForm({ ...form, tokenBudgetValue: event.target.value })
                        }
                        disabled={form.tokenBudgetMode === "unlimited"}
                        required={form.tokenBudgetMode === "limited"}
                      />
                      {form.tokenBudgetMode === "unlimited" && (
                        <div className="token-budget-overlay">Locked while Unlimited is selected</div>
                      )}
                    </div>
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
              </div>
            )}

            {showShare && (
              <div className="modal-backdrop" onMouseDown={() => setShowShare(false)}>
              <form
                className="modal settings-panel"
                onSubmit={submitShare}
                onMouseDown={(event) => event.stopPropagation()}
              >
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
              </div>
            )}

            {showResources && (
              <div className="modal-backdrop" onMouseDown={() => setShowResources(false)}>
              <div className="modal modal-wide" onMouseDown={(event) => event.stopPropagation()}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Context</span>
                    <h2>Workspace &amp; shared resources</h2>
                  </div>
                  <button type="button" onClick={() => setShowResources(false)}>×</button>
                </div>
                <section className="resource-grid">
              <form className="resource-panel" onSubmit={uploadWorkspaceResource}>
                <div className="resource-panel-heading">
                  <div>
                    <span className="eyebrow">Workspace uploads</span>
                    <h2>Private context</h2>
                  </div>
                </div>
                <label>
                  File name
                  <input
                    value={uploadForm.name}
                    onChange={(event) => setUploadForm({ ...uploadForm, name: event.target.value })}
                    placeholder="notes.md"
                    maxLength={200}
                  />
                </label>
                <label>
                  File
                  <input
                    type="file"
                    accept=".md,.markdown,.pdf,text/markdown,text/plain,application/pdf"
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      setUploadFile(file);
                      if (file) {
                        setUploadForm((current) => ({
                          ...current,
                          name: current.name.trim() || file.name,
                          content: "",
                        }));
                      }
                    }}
                  />
                </label>
                {uploadFile && (
                  <div className="file-chip">
                    <strong>{uploadFile.name}</strong>
                    <span>{uploadFile.type || "file"}</span>
                  </div>
                )}
                <label>
                  Content {uploadFile ? "(not needed — using the chosen file)" : "(or choose a file above)"}
                  <textarea
                    value={uploadForm.content}
                    onChange={(event) =>
                      setUploadForm({ ...uploadForm, content: event.target.value })
                    }
                    rows={5}
                    placeholder="Paste a document to add it to this Agent's RAG corpus."
                    maxLength={1_000_000}
                    disabled={Boolean(uploadFile)}
                  />
                </label>
                <div className="resource-list">
                  {uploads.length > 0 ? (
                    uploads.map((item) => (
                      <div className="resource-row" key={item.name}>
                        <div>
                          <strong>{item.name}</strong>
                          <span>{Math.max(1, Math.ceil(item.size / 1024))} KB</span>
                        </div>
                        <button type="button" className="button button-ghost" onClick={() => deleteUpload(item.name)}>
                          Delete
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="resource-empty">No uploads yet for this Agent.</p>
                  )}
                </div>
                <div className="panel-footer">
                  <span>Stored inside {selected.name}&apos;s workspace</span>
                  <button
                    className="button button-primary"
                    disabled={
                      busy ||
                      !uploadForm.name.trim() ||
                      (!uploadForm.content.trim() && !uploadFile)
                    }
                  >
                    {busy ? <Spinner /> : "Upload resource"}
                  </button>
                </div>
              </form>

              <form className="resource-panel" onSubmit={publishSharedResource}>
                <div className="resource-panel-heading">
                  <div>
                    <span className="eyebrow">Shared resources</span>
                    <h2>Reusable context</h2>
                  </div>
                </div>
                <label>
                  File name
                  <input
                    value={sharedForm.name}
                    onChange={(event) => setSharedForm({ ...sharedForm, name: event.target.value })}
                    placeholder="shared-notes.md"
                    maxLength={200}
                  />
                </label>
                <label>
                  File
                  <input
                    type="file"
                    accept=".md,.markdown,.pdf,text/markdown,text/plain,application/pdf"
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      setSharedFile(file);
                      if (file) {
                        setSharedForm((current) => ({
                          ...current,
                          name: current.name.trim() || file.name,
                          content: "",
                        }));
                      }
                    }}
                  />
                </label>
                {sharedFile && (
                  <div className="file-chip">
                    <strong>{sharedFile.name}</strong>
                    <span>{sharedFile.type || "file"}</span>
                  </div>
                )}
                <label>
                  Content {sharedFile ? "(not needed — using the chosen file)" : "(or choose a file above)"}
                  <textarea
                    value={sharedForm.content}
                    onChange={(event) =>
                      setSharedForm({ ...sharedForm, content: event.target.value })
                    }
                    rows={5}
                    placeholder="Paste content that all authorized agents can retrieve."
                    maxLength={1_000_000}
                    disabled={Boolean(sharedFile)}
                  />
                </label>
                <div className="resource-list">
                  {sharedResources.length > 0 ? (
                    sharedResources.map((item) => (
                      <div className="resource-row" key={item.name}>
                        <div>
                          <strong>{item.name}</strong>
                          <span>{Math.max(1, Math.ceil(item.size / 1024))} KB</span>
                        </div>
                        <button type="button" className="button button-ghost" onClick={() => deleteShared(item.name)}>
                          Delete
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="resource-empty">No shared resources yet.</p>
                  )}
                </div>
                <div className="panel-footer">
                  <span>Available to all authorized agents via RAG</span>
                  <button
                    className="button button-primary"
                    disabled={
                      busy ||
                      !sharedForm.name.trim() ||
                      (!sharedForm.content.trim() && !sharedFile)
                    }
                  >
                    {busy ? <Spinner /> : "Publish shared resource"}
                  </button>
                </div>
              </form>
                </section>
              </div>
              </div>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="playground-status">
                  <div className="session-info">
                    <span className="pulse" />
                    {selected.codexThreadId ? "Session connected" : "New session"}
                    {activeRun && (
                      <button type="button" className="button button-ghost" onClick={toggleTrace}>
                        {showTrace ? "Hide trace" : "View trace"}
                      </button>
                    )}
                  </div>
                  {activeRun?.retrieval && <RetrievalBadge retrieval={activeRun.retrieval} />}
                </div>
              </div>

              {showTrace && activeRun && (
                <div className="trace-panel" aria-live="polite">
                  {traceLoading ? (
                    <Spinner />
                  ) : traceEvents && traceEvents.length > 0 ? (
                    <ul className="trace-list">
                      {traceEvents.map((event) => (
                        <li key={event.seq} className={"trace-event trace-" + event.type}>
                          <span className="trace-seq">{event.seq}</span>
                          <span className="trace-time">{formatTime(event.occurredAt)}</span>
                          <span className="trace-type">{event.type}</span>
                          <span className="trace-summary">{event.summary}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="trace-empty">No trace events recorded for this Run yet.</p>
                  )}
                </div>
              )}

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
                {activeRun?.status === "cancelled" && (
                  <article className="run-terminated">
                    <strong>Run terminated</strong>
                    <span>{activeRun.error ?? "Stopped by a control action."}</span>
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
            <div className="form-grid">
              <label>
                Token budget
                <select
                  value={form.tokenBudgetMode}
                  onChange={(event) =>
                    setForm({
                      ...form,
                      tokenBudgetMode: event.target.value === "limited" ? "limited" : "unlimited",
                    })
                  }
                >
                  <option value="unlimited">Unlimited</option>
                  <option value="limited">Allocate tokens</option>
                </select>
              </label>
              <label>
                Budget amount
                <div
                  className={
                    "token-budget-shell " +
                    (form.tokenBudgetMode === "unlimited" ? "token-budget-shell-disabled" : "")
                  }
                >
                  <input
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    placeholder="50000"
                    value={form.tokenBudgetValue}
                    onChange={(event) =>
                      setForm({ ...form, tokenBudgetValue: event.target.value })
                    }
                    disabled={form.tokenBudgetMode === "unlimited"}
                    required={form.tokenBudgetMode === "limited"}
                  />
                  {form.tokenBudgetMode === "unlimited" && (
                    <div className="token-budget-overlay">Locked while Unlimited is selected</div>
                  )}
                </div>
              </label>
            </div>
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
