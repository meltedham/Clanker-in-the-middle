import type {
  Agent,
  AgentRun,
  Message,
  ResourceSummary,
  RunEvent,
  SandboxMode,
  SystemInfo,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

let authToken = "";

export function setAuthToken(token: string): void {
  authToken = token.trim();
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = {
    ...(options?.body ? { "Content-Type": "application/json" } : {}),
    ...(authToken ? { Authorization: "Bearer " + authToken } : {}),
    ...options?.headers,
  };
  const response = await fetch(url, {
    ...options,
    headers,
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    // The server's custom error handler sends `{error: "<specific reason>"}`.
    // A Fastify-plugin quirk under NODE_ENV=production instead sends the
    // default `{statusCode, error: "<generic HTTP reason phrase>", message:
    // "<specific reason>"}` for some routes -- `message`, when present, is
    // always the more specific one, so prefer it.
    throw new ApiError(data.message ?? data.error ?? "Request failed", response.status);
  }
  return data;
}

export type UserRole = "admin" | "member";
export type GrantRole = "viewer" | "operator";

export interface AuthUser {
  id: string;
  name: string;
  role: UserRole;
}

// Every admin appears here too, as a synthetic entry with revocable:false --
// they have full access to every Agent regardless of any Grant, so there's
// nothing to revoke.
export interface Grant {
  id: string;
  userId: string;
  userName: string;
  role: GrantRole | "admin";
  revocable: boolean;
  createdAt: string;
}

export const api = {
  auth: () => request<{ required: boolean; identityEnabled: boolean }>("/api/auth"),
  whoami: () => request<{ user: AuthUser | null }>("/api/whoami"),
  listUsers: () => request<{ users: Array<{ id: string; name: string }> }>("/api/users"),
  createUser: (name: string, options?: { role?: UserRole; password?: string }) =>
    request<{ user: AuthUser; token: string }>("/api/users", {
      method: "POST",
      body: JSON.stringify({ name, ...options }),
    }),
  login: (name: string, password: string) =>
    request<{ user: AuthUser; token: string }>("/api/login", {
      method: "POST",
      body: JSON.stringify({ name, password }),
    }),
  listGrants: (agentId: string) =>
    request<{ grants: Grant[] }>("/api/agents/" + agentId + "/grants"),
  createGrant: (agentId: string, userId: string, role: GrantRole) =>
    request<{ grant: Grant }>("/api/agents/" + agentId + "/grants", {
      method: "POST",
      body: JSON.stringify({ userId, role }),
    }),
  revokeGrant: (agentId: string, grantId: string) =>
    request<void>("/api/agents/" + agentId + "/grants/" + grantId, {
      method: "DELETE",
    }),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
    tokenBudget: number | null;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: {
      name: string;
      description: string;
      instructions: string;
      tokenBudget: number | null;
      // Only ever sent when the caller can see the runtime-policy controls
      // (owner/admin) -- AgentService still re-checks this itself either way.
      sandboxMode?: SandboxMode;
      networkAccess?: boolean;
    },
  ) =>
    request<{ agent: Agent }>("/api/agents/" + id, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteAgent: (id: string) =>
    request<{ archivedWorkspace: string }>("/api/agents/" + id, {
      method: "DELETE",
    }),
  startAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/start", {
      method: "POST",
    }),
  stopAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/stop", {
      method: "POST",
    }),
  killAgent: (id: string) =>
    request<{ agent: Agent }>("/api/agents/" + id + "/kill", {
      method: "POST",
    }),
  messages: (id: string) =>
    request<{ messages: Message[] }>("/api/agents/" + id + "/messages"),
  runs: (id: string) =>
    request<{ runs: AgentRun[] }>("/api/agents/" + id + "/runs"),
  uploads: (id: string) =>
    request<{ uploads: ResourceSummary[] }>("/api/agents/" + id + "/uploads"),
  uploadAgentResource: (
    id: string,
    body: {
      name: string;
      content?: string;
      contentBase64?: string;
      mimeType?: string;
    },
  ) =>
    request<{ upload: ResourceSummary }>("/api/agents/" + id + "/uploads", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteAgentUpload: (id: string, name: string) =>
    request<{ ok: boolean }>("/api/agents/" + id + "/uploads/" + encodeURIComponent(name), {
      method: "DELETE",
    }),
  sharedResources: () =>
    request<{ resources: ResourceSummary[] }>("/api/shared-resources"),
  createSharedResource: (
    body: {
      name: string;
      content?: string;
      contentBase64?: string;
      mimeType?: string;
    },
  ) =>
    request<{ resource: ResourceSummary }>("/api/shared-resources", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteSharedResource: (name: string) =>
    request<{ ok: boolean }>("/api/shared-resources/" + encodeURIComponent(name), {
      method: "DELETE",
    }),
  sendMessage: (id: string, content: string) =>
    request<{
      run: AgentRun;
      message: Message;
      assistantMessage?: Message;
      retrieval: AgentRun["retrieval"];
    }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  trace: (id: string) => request<{ events: RunEvent[] }>("/api/runs/" + id + "/trace"),
};
