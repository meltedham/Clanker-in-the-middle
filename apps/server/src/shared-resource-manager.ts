import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveWithinRoot } from "./safe-path.js";

export interface SharedResourceSummary {
  name: string;
  size: number;
  updatedAt: string;
}

export class SharedResourceManager {
  constructor(private readonly root: string) {}

  resourcePath(name: string): string {
    return resolveWithinRoot(this.root, name);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(
      path.join(this.root, "README.md"),
      [
        "# Shared resources",
        "",
        "Files here are available to all authorized agents through RAG.",
        "Do not place secrets here.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  async list(): Promise<SharedResourceSummary[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    const summaries: SharedResourceSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === "README.md") {
        continue;
      }
      const filePath = path.join(this.root, entry.name);
      const stat = await import("node:fs/promises").then(({ stat }) => stat(filePath));
      summaries.push({
        name: entry.name,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
      });
    }
    return summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async write(name: string, content: string): Promise<SharedResourceSummary> {
    await mkdir(this.root, { recursive: true });
    const filePath = this.resourcePath(name);
    await writeFile(filePath, content, "utf8");
    return this.describe(name);
  }

  async delete(name: string): Promise<void> {
    await rm(this.resourcePath(name), { force: true });
  }

  async read(name: string): Promise<string> {
    return readFile(this.resourcePath(name), "utf8");
  }

  async exists(name: string): Promise<boolean> {
    try {
      await access(this.resourcePath(name));
      return true;
    } catch {
      return false;
    }
  }

  private async describe(name: string): Promise<SharedResourceSummary> {
    const stat = await import("node:fs/promises").then(({ stat }) => stat(this.resourcePath(name)));
    return {
      name,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  }
}