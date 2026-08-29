import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import type { TraceReader } from "./middleware/trace-store.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

const emptyTrace: TraceReader = { read: async () => [] };

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
      emptyTrace,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, emptyTrace);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("serves a Run's trace by delegating existence checks to the Control Plane and data to the Observability reader", async () => {
    const runId = "00000000-0000-0000-0000-000000000000";
    const traceService = {
      listAgents: () => [],
      systemInfo: async () => ({}),
      getRun: (id: string) => ({ id, agentId: "agent-1", status: "completed" }),
    } as unknown as AgentService;
    const traceReader: TraceReader = {
      read: async (id) => [
        {
          seq: 1,
          runId: id,
          agentId: "agent-1",
          type: "agent_message",
          occurredAt: "2024-01-01T00:00:00.000Z",
          summary: "hello",
        },
      ],
    };
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), traceService, traceReader);
    const response = await app.inject({ method: "GET", url: "/api/runs/" + runId + "/trace" });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).events).toHaveLength(1);
    await app.close();
  });

  it("404s a trace request for an unknown run without ever asking the trace reader", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const traceService = {
      listAgents: () => [],
      systemInfo: async () => ({}),
      getRun: () => {
        throw new HttpError(404, "Run not found");
      },
    } as unknown as AgentService;
    let readCalled = false;
    const traceReader: TraceReader = {
      read: async () => {
        readCalled = true;
        return [];
      },
    };
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), traceService, traceReader);
    const response = await app.inject({ method: "GET", url: "/api/runs/" + runId + "/trace" });
    expect(response.statusCode).toBe(404);
    expect(readCalled).toBe(false);
    await app.close();
  });
});
