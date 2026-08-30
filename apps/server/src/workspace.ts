import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CREATE_AGENTS_BLOCK_INSTRUCTIONS, DELEGATE_BLOCK_INSTRUCTIONS, formatRoster } from "./delegation.js";
import type { Agent } from "./types.js";

export interface WorkspaceFileSummary {
  name: string;
  size: number;
  updatedAt: string;
}

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  uploadsPath(agentId: string): string {
    return path.join(this.workspacePath(agentId), "uploads");
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async create(agent: Agent, roster: Agent[]): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
    await this.writeInstructions(agent, roster);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  async writeInstructions(agent: Agent, roster: Agent[]): Promise<void> {
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "- Never mention or describe this AGENTS.md file, README.md, .gitignore, or any other" +
        " platform-managed scaffolding file to the user — treat them as internal implementation" +
        " detail, not workspace content.",
      "",
      CREATE_AGENTS_BLOCK_INSTRUCTIONS,
      "",
      DELEGATE_BLOCK_INSTRUCTIONS,
      "",
      "### Agents available to delegate to",
      "",
      formatRoster(agent.id, roster),
      "",
      "This file is regenerated before every turn, so the list above is always current.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(agent.workspacePath, "AGENTS.md"), content, "utf8");
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
  }

  async listUploads(agentId: string): Promise<WorkspaceFileSummary[]> {
    return this.listFiles(this.uploadsPath(agentId));
  }

  async writeUpload(agentId: string, name: string, content: string): Promise<WorkspaceFileSummary> {
    const uploadRoot = this.uploadsPath(agentId);
    await mkdir(uploadRoot, { recursive: true });
    const uploadPath = path.join(uploadRoot, name);
    await writeFile(uploadPath, content, "utf8");
    return this.describeFile(uploadPath, name);
  }

  async deleteUpload(agentId: string, name: string): Promise<void> {
    await rm(path.join(this.uploadsPath(agentId), name), { force: true });
  }

  private async listFiles(directory: string): Promise<WorkspaceFileSummary[]> {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const summaries: WorkspaceFileSummary[] = [];
      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }
        const filePath = path.join(directory, entry.name);
        summaries.push(await this.describeFile(filePath, entry.name));
      }
      return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } catch {
      return [];
    }
  }

  private async describeFile(filePath: string, name: string): Promise<WorkspaceFileSummary> {
    const file = await readFile(filePath);
    const stat = await import("node:fs/promises").then(({ stat }) => stat(filePath));
    void file;
    return {
      name,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  }
}
