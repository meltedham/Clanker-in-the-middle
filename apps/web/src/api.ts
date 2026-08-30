import type { Agent, AgentRun, Message, ResourceSummary, RunEvent, SystemInfo } from "./types";

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
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? "Request failed", response.status);
  }
  return data;
}

export const api = {
  auth: () => request<{ required: boolean }>("/api/auth"),
  system: () => request<SystemInfo>("/api/system"),
  listAgents: () => request<{ agents: Agent[] }>("/api/agents"),
  createAgent: (body: {
    name: string;
    description: string;
    instructions: string;
  }) =>
    request<{ agent: Agent }>("/api/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateAgent: (
    id: string,
    body: { name: string; description: string; instructions: string },
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
    request<{ run: AgentRun; message: Message; retrieval: AgentRun["retrieval"] }>(
      "/api/agents/" + id + "/messages",
      {
        method: "POST",
        body: JSON.stringify({ content }),
      },
    ),
  run: (id: string) => request<{ run: AgentRun }>("/api/runs/" + id),
  trace: (id: string) => request<{ events: RunEvent[] }>("/api/runs/" + id + "/trace"),
};
