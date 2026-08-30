import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { UserRole } from "./types.js";

/** A user seeded from the APP_USERS env var at boot. AgentService hashes
 * `token` before it ever touches the persisted store. */
export interface SeedUser {
  id: string;
  name: string;
  token: string;
  role: UserRole;
}

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  SHARED_RESOURCE_ROOT: z.string().default(path.resolve("shared-resources")),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().optional(),
  OPENROUTER_EMBEDDING_MODEL: z.string().optional(),
  // Optional users seeded into the store at boot, for reproducible demo
  // accounts. Format: "id:name:token,id:name:token[:role]", role is
  // "member" (default) or "admin". Additional users can also be created at
  // runtime via POST /api/users; identity/ownership enforcement activates
  // the moment any user exists in the store, seeded or not. Leave unset and
  // never call POST /api/users to keep the single-user baseline (or the
  // legacy shared APP_AUTH_TOKEN) unchanged.
  APP_USERS: z.string().trim().optional(),
  MAX_PROMPT_CHARS: z.coerce.number().int().min(1_000).default(20_000),
  // Applied only to POST /api/login (per source IP) -- a password-auth
  // endpoint with no other guard against credential-stuffing/brute-force.
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  OPENROUTER_BASE_URL: z
    .string()
    .url()
    .default("https://openrouter.ai/api/v1"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

function parseUsers(raw: string | undefined): SeedUser[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [id, name, token, role] = entry.split(":").map((part) => part.trim());
      if (!id || !name || !token) {
        throw new Error(
          `APP_USERS entry "${entry}" must be formatted as "id:name:token" or "id:name:token:role"`,
        );
      }
      if (role !== undefined && role !== "member" && role !== "admin") {
        throw new Error(
          `APP_USERS entry "${entry}" has role "${role}" -- must be "member" or "admin"`,
        );
      }
      return { id, name, token, role: role === "admin" ? "admin" : "member" };
    });
}

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const users = parseUsers(env.APP_USERS);
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
    for (const user of users) {
      if (user.token.length < 16) {
        throw new Error(
          `APP_USERS token for "${user.id}" must contain at least 16 characters for a non-loopback production server`,
        );
      }
    }
  }
  const duplicateIds = new Set<string>();
  for (const user of users) {
    if (duplicateIds.has(user.id)) {
      throw new Error(`APP_USERS contains a duplicate id "${user.id}"`);
    }
    duplicateIds.add(user.id);
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    openRouterApiKey: env.OPENROUTER_API_KEY?.trim() ?? "",
    openRouterModel: env.OPENROUTER_MODEL?.trim() ?? "",
    openRouterBaseUrl: env.OPENROUTER_BASE_URL.replace(/\/+$/, ""),
    openRouterEmbeddingModel: env.OPENROUTER_EMBEDDING_MODEL?.trim() ?? "",
    sharedResourceRoot: path.resolve(env.SHARED_RESOURCE_ROOT),
    users,
    maxPromptChars: env.MAX_PROMPT_CHARS,
    loginRateLimitMax: env.LOGIN_RATE_LIMIT_MAX,
    loginRateLimitWindowMs: env.LOGIN_RATE_LIMIT_WINDOW_MS,
    nodeEnv: env.NODE_ENV,
    ragTopK: 8,
    ragChunkSize: 1_200,
    ragScanLimit: 200,
    ragMaxContextChars: 12_000,
    ragMinScore: 0.22,
    ragStrongScore: 0.42,
  };
}

export function isModelProviderConfigured(config: AppConfig): boolean {
  return (
    config.openRouterApiKey.length > 0 &&
    !config.openRouterApiKey.startsWith("replace-") &&
    config.openRouterModel.length > 0 &&
    !config.openRouterModel.includes("replace-")
  );
}

export async function writeCodexConfig(config: AppConfig): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const toml = [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.openRouterModel || "openai/gpt-4o-mini"),
    'model_provider = "openrouter"',
    "",
    "[model_providers.openrouter]",
    'name = "OpenRouter"',
    "base_url = " + JSON.stringify(config.openRouterBaseUrl),
    'env_key = "OPENROUTER_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}
