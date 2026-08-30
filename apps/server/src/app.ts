import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import type { TraceReader } from "./middleware/trace-store.js";
import type { AuthUser } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

function safeTokenEquals(candidate: string, expected: string): boolean {
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return (
    candidateBuffer.length === expectedBuffer.length &&
    timingSafeEqual(candidateBuffer, expectedBuffer)
  );
}

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const grantIdParams = z.object({ id: z.string().uuid(), grantId: z.string().uuid() });
const resourceNameParams = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^/\\]+$/, "Resource names must not contain path separators"),
});
const createUserBody = z.object({
  name: z.string().trim().min(1).max(80),
  // role only has any effect when the caller is already authenticated as an
  // admin -- AgentService re-validates this itself; the route never trusts
  // it on its own. password is optional: without one, this account can
  // only ever authenticate with the token returned right here (today's
  // original behavior).
  role: z.enum(["member", "admin"]).optional(),
  password: z.string().min(8).max(200).optional(),
});
const loginBody = z.object({
  name: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200),
});
const grantBody = z.object({
  // Not `.uuid()`: a seeded APP_USERS id can be any string (e.g. "u-alice").
  userId: z.string().trim().min(1),
  role: z.enum(["viewer", "operator"]),
});
const tokenBudgetField = z.number().int().positive().nullable().optional();
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
  // Runtime policy. AgentService restricts changing these to the Agent's
  // owner or an admin, even though ordinary fields above only need "write".
  sandboxMode: z.enum(["read-only", "workspace-write"]).optional(),
  networkAccess: z.boolean().optional(),
  tokenBudget: tokenBudgetField,
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const uploadBody = z.object({
  name: z.string().trim().min(1).max(200).regex(/^[^/\\]+$/),
  content: z.string().max(2_000_000).optional(),
  contentBase64: z.string().max(4_000_000).optional(),
  mimeType: z.string().max(200).optional(),
}).refine(
  (body) => Boolean(body.content?.length ?? 0) || Boolean(body.contentBase64?.length ?? 0),
  {
    message: "Either content or contentBase64 is required",
  },
);

/**
 * `trace` is a `TraceReader`, not the concrete trace-store writer -- the
 * API layer (Experience Layer boundary) only ever needs read access to the
 * Observability middleware's data; writes happen exclusively inside
 * `middleware/observability-runner.ts`, which this function never touches.
 */
export async function createApp(
  config: AppConfig,
  service: AgentService,
  trace: TraceReader,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 8_388_608,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth" ||
      request.url === "/api/login"
    ) {
      // /api/login is a credential exchange (name+password -> token), so it
      // necessarily runs before any token exists to present.
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (request.url === "/api/users") {
      // Reachable pre-auth on purpose: GET only ever returns id/name (no
      // tokens), and POST is self-registration, so a caller needs no
      // credential yet to see who exists or to become someone. But if a
      // valid token IS presented, resolve it anyway -- an authenticated
      // owner/admin uses this same POST to promote a role or bundle a
      // Grant, and AgentService needs request.authUser to check that.
      if (service.hasIdentityEnabled() && candidate) {
        const user = service.resolveUserByToken(candidate);
        if (user) request.authUser = user;
      }
      return;
    }

    if (service.hasIdentityEnabled()) {
      // Access-control mode: activates the moment any user exists (seeded
      // via APP_USERS, or self-registered through POST /api/users). Each
      // caller must present a token that resolves to a real user; that
      // identity drives ownership/Grant checks in AgentService for the
      // rest of the request.
      const user = service.resolveUserByToken(candidate);
      if (!user) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      request.authUser = user;
      return;
    }

    if (!config.authToken) {
      return;
    }
    if (!safeTokenEquals(candidate, config.authToken)) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({
    required: config.authToken.length > 0 || service.hasIdentityEnabled(),
    // Once any user exists, the legacy shared token stops being checked at
    // all (see the onRequest hook above) -- the frontend uses this to stop
    // offering it as an option once it can never actually work.
    identityEnabled: service.hasIdentityEnabled(),
  }));

  app.get("/api/whoami", async (request) => ({
    user: request.authUser ?? null,
  }));

  app.get("/api/users", async () => ({ users: service.listUsers() }));

  app.post("/api/users", async (request, reply) => {
    const body = createUserBody.parse(request.body);
    const result = await service.createUser(body.name, {
      actor: request.authUser ?? null,
      role: body.role,
      password: body.password,
    });
    return reply.code(201).send(result);
  });

  app.post("/api/login", async (request, reply) => {
    const body = loginBody.parse(request.body);
    const result = await service.login(body.name, body.password);
    return reply.code(200).send(result);
  });

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async (request) => ({
    agents: service.listAgents(request.authUser ?? null),
  }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body, request.authUser?.id);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id, request.authUser ?? null) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body, request.authUser ?? null) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id, request.authUser ?? null);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id, request.authUser ?? null) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id, request.authUser ?? null) };
  });

  app.post("/api/agents/:id/kill", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.killAgent(id, request.authUser ?? null) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id, request.authUser ?? null) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id, request.authUser ?? null) };
  });

  app.get("/api/agents/:id/uploads", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { uploads: await service.listUploads(id, request.authUser ?? null) };
  });

  app.post("/api/agents/:id/uploads", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = uploadBody.parse(request.body);
    return reply.code(201).send({
      upload: await service.uploadAgentResource(id, body, request.authUser ?? null),
    });
  });

  app.delete("/api/agents/:id/uploads/:name", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const { name } = resourceNameParams.parse(request.params);
    await service.deleteAgentUpload(id, name, request.authUser ?? null);
    return { ok: true };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content, request.authUser ?? null);
    return reply.code(202).send(result);
  });

  app.get("/api/shared-resources", async () => ({
    resources: await service.listSharedResources(),
  }));

  app.post("/api/shared-resources", async (request, reply) => {
    const body = uploadBody.parse(request.body);
    return reply.code(201).send({
      resource: await service.uploadSharedResource(body),
    });
  });

  app.delete("/api/shared-resources/:name", async (request) => {
    const { name } = resourceNameParams.parse(request.params);
    await service.deleteSharedResource(name);
    return { ok: true };
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id, request.authUser ?? null) };
  });

  app.get("/api/runs/:id/trace", async (request) => {
    const { id } = runIdParams.parse(request.params);
    service.getRun(id, request.authUser ?? null); // Control Plane confirms the Run exists and access is allowed (404/403 otherwise)...
    return { events: await trace.read(id) }; // ...Observability Layer supplies its data.
  });

  app.post("/api/agents/:id/grants", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = grantBody.parse(request.body);
    const grant = await service.createGrant(id, request.authUser ?? null, body.userId, body.role);
    return reply.code(201).send({ grant });
  });

  app.get("/api/agents/:id/grants", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { grants: service.listGrants(id, request.authUser ?? null) };
  });

  app.delete("/api/agents/:id/grants/:grantId", async (request, reply) => {
    const { id, grantId } = grantIdParams.parse(request.params);
    await service.revokeGrant(id, grantId, request.authUser ?? null);
    return reply.code(204).send();
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}
