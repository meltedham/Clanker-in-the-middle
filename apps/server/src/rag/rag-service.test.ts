import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "../agent-service.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "../types.js";
import { WorkspaceManager } from "../workspace.js";
import { RagService } from "./rag-service.js";

class FakeRunner implements AgentRunner {
  public readonly prompts: string[] = [];

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.prompts.push(request.prompt);
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-rag-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    OPENROUTER_API_KEY: "test-key",
    OPENROUTER_MODEL: "test-model",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

function toBase64(content: string): string {
  return Buffer.from(content, "utf8").toString("base64");
}

function buildFakePdf(text: string): string {
  const streamBody = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >> endobj",
    "4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    `5 0 obj << /Length ${streamBody.length} >> stream\n${streamBody}\nendstream endobj`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += object + "\n";
  }
  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets) {
    pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return pdf;
}

describe("RAG retrieval", () => {
  // First test to trigger local embedding retrieval in this file pays the
  // cost of loading the Transformers.js model, which can exceed Vitest's
  // default 5s timeout on a cold run.
  it("enriches the runner prompt with workspace and shared resources", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-rag-"));
    temporaryDirectories.push(root);
    const runner = new FakeRunner();
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      SHARED_RESOURCE_ROOT: path.join(root, "shared"),
      CODEX_HOME: path.join(root, "codex"),
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_MODEL: "test-model",
    });
    const service = new AgentService(
      config,
      new JsonStore(path.join(root, "data", "db.json")),
      new WorkspaceManager(path.join(root, "workspaces")),
      runner,
    );
    await service.initialize();

    const agent = await service.createAgent({ name: "Retriever" });
    await mkdir(config.sharedResourceRoot, { recursive: true });
    await writeFile(
      path.join(agent.workspacePath, "workspace-notes.md"),
      "Workspace clue: the widget integration depends on cached summaries.",
      "utf8",
    );
    await writeFile(
      path.join(config.sharedResourceRoot, "shared-notes.md"),
      "Shared resource clue: the widget integration is documented for all agents.",
      "utf8",
    );

    const { run } = await service.sendMessage(agent.id, "how should I wire the widget integration?");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const enrichedPrompt = runner.prompts.at(-1) ?? "";
    expect(enrichedPrompt).toContain("Workspace clue");
    expect(enrichedPrompt).toContain("Shared resource clue");
    expect(service.getRun(run.id).retrieval?.status).not.toBe("no_context");
  }, 30_000);

  it("extracts PDF uploads into searchable context", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "PDF Retriever" });
    const fakePdf = buildFakePdf("Invoice total 42");

    await service.uploadAgentResource(agent.id, {
      name: "invoice.pdf",
      contentBase64: toBase64(fakePdf),
      mimeType: "application/pdf",
    });

    const { run } = await service.sendMessage(agent.id, "what is the invoice total?");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(runner.prompts.at(-1)).toContain("Invoice total 42");
    expect(service.getRun(run.id).retrieval?.status).not.toBe("no_context");
  });

  it("reports no_context and never surfaces platform-managed scaffolding files", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Empty" });

    const { run } = await service.sendMessage(agent.id, "search for something");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(service.getRun(run.id).retrieval).toMatchObject({
      status: "no_context",
    });
    const prompt = runner.prompts.at(-1) ?? "";
    expect(prompt).toContain("search for something");
    expect(prompt).not.toContain("Retrieved context:");
    expect(prompt).not.toContain("AGENTS.md");
    expect(prompt).not.toContain("README.md");
    expect(prompt).not.toContain(".gitignore");
  });

  it("reports no_context when the RAG corpus is empty", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-empty-rag-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      SHARED_RESOURCE_ROOT: path.join(root, "shared"),
      CODEX_HOME: path.join(root, "codex"),
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_MODEL: "test-model",
    });
    const store = new JsonStore(path.join(root, "data", "db.json"));
    await store.initialize();
    const ragService = new RagService(config, store);
    const context = await ragService.buildContext(
      {
        id: "agent",
        workspacePath: path.join(root, "empty"),
      } as never,
      "search for something",
      null,
    );

    expect(context.summary).toMatchObject({
      status: "no_context",
      confidence: 0,
      topScore: null,
      candidateCount: 0,
      matchCount: 0,
    });
    expect(context.prompt).toBe("search for something");
    expect(context.matches).toHaveLength(0);
  });

  it("stops using deleted uploads in later prompts", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Delete Check" });

    await service.uploadAgentResource(agent.id, {
      name: "committee.md",
      content: "Election committee members are the chair, vice chair, and secretary.",
    });
    await service.deleteAgentUpload(agent.id, "committee.md");

    const { run } = await service.sendMessage(agent.id, "who is on the committee?");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const prompt = runner.prompts.at(-1) ?? "";
    expect(prompt).not.toContain("chair, vice chair, and secretary");
  });
});
