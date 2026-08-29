import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { createEmbeddingClient } from "./embeddings.js";
import type { JsonStore } from "./store.js";
import type {
  Agent,
  EmbeddingClient,
  RagContext,
  RagMatch,
  RagSourceType,
} from "./types.js";

interface ChunkCandidate {
  sourceType: RagSourceType;
  sourceId: string;
  title: string;
  content: string;
}

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".deleted",
  ".codex",
  "node_modules",
  "dist",
]);

const DEFAULT_IGNORED_FILES = new Set([".DS_Store"]);

export class RagService {
  private readonly embeddingClient: EmbeddingClient;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
  ) {
    this.embeddingClient = createEmbeddingClient(config);
  }

  async buildContext(
    agent: Agent,
    prompt: string,
    excludeRunId: string | null,
  ): Promise<RagContext> {
    const [workspaceChunks, sharedChunks, messageChunks] = await Promise.all([
      this.collectFilesystemChunks(agent.workspacePath, "workspace", agent.id),
      this.collectFilesystemChunks(this.config.sharedResourceRoot, "shared", "shared-root"),
      this.collectMessageChunks(agent.id, excludeRunId),
    ]);

    const candidates = [...workspaceChunks, ...sharedChunks, ...messageChunks];
    if (candidates.length === 0) {
      return { prompt, matches: [] };
    }

    const [queryEmbedding] = await this.embeddingClient.embed([prompt]);
    const chunkEmbeddings = await this.embeddingClient.embed(candidates.map((candidate) => candidate.content));
    const scored = candidates.map((candidate, index) => ({
      ...candidate,
      score: cosineSimilarity(queryEmbedding ?? [], chunkEmbeddings[index] ?? []),
    }));

    const topMatches = scored
      .sort((left, right) => right.score - left.score)
      .slice(0, this.config.ragTopK)
      .map((match): RagMatch => ({
        sourceType: match.sourceType,
        sourceId: match.sourceId,
        title: match.title,
        content: match.content,
        score: match.score,
      }));

    return {
      prompt: buildAugmentedPrompt(prompt, topMatches, this.config.ragMaxContextChars),
      matches: topMatches,
    };
  }

  private async collectMessageChunks(
    agentId: string,
    excludeRunId: string | null,
  ): Promise<ChunkCandidate[]> {
    const messages = this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId && message.runId !== excludeRunId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    return messages.map((message) => ({
      sourceType: "message",
      sourceId: message.id,
      title: message.role + " message from " + message.createdAt,
      content: message.content,
    }));
  }

  private async collectFilesystemChunks(
    root: string,
    sourceType: "workspace" | "shared",
    sourceId: string,
  ): Promise<ChunkCandidate[]> {
    const chunks: ChunkCandidate[] = [];
    await this.walkDirectory(root, sourceType, sourceId, chunks);
    return chunks;
  }

  private async walkDirectory(
    currentPath: string,
    sourceType: "workspace" | "shared",
    sourceId: string,
    chunks: ChunkCandidate[],
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (chunks.length >= this.config.ragScanLimit) {
        return;
      }
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        await this.walkDirectory(path.join(currentPath, entry.name), sourceType, sourceId, chunks);
        continue;
      }
      if (!entry.isFile() || DEFAULT_IGNORED_FILES.has(entry.name)) {
        continue;
      }
      const filePath = path.join(currentPath, entry.name);
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        continue;
      }
      if (fileStat.size > 256_000) {
        continue;
      }
      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      if (!isLikelyText(content)) {
        continue;
      }
      for (const chunk of chunkText(content, this.config.ragChunkSize)) {
        chunks.push({
          sourceType,
          sourceId,
          title: filePath,
          content: chunk,
        });
        if (chunks.length >= this.config.ragScanLimit) {
          return;
        }
      }
    }
  }
}

function isLikelyText(content: string): boolean {
  return !content.includes("\u0000");
}

function chunkText(content: string, maxLength: number): string[] {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.length <= maxLength) {
    return [trimmed];
  }
  const paragraphs = trimmed.split(/\n\s*\n/g);
  const chunks: string[] = [];
  let buffer = "";
  for (const paragraph of paragraphs) {
    const candidate = buffer.length > 0 ? buffer + "\n\n" + paragraph : paragraph;
    if (candidate.length <= maxLength) {
      buffer = candidate;
      continue;
    }
    if (buffer.length > 0) {
      chunks.push(buffer);
      buffer = "";
    }
    if (paragraph.length <= maxLength) {
      buffer = paragraph;
      continue;
    }
    for (let index = 0; index < paragraph.length; index += maxLength) {
      chunks.push(paragraph.slice(index, index + maxLength));
    }
  }
  if (buffer.length > 0) {
    chunks.push(buffer);
  }
  return chunks;
}

function cosineSimilarity(left: number[], right: number[]): number {
  const size = Math.min(left.length, right.length);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < size; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function buildAugmentedPrompt(
  prompt: string,
  matches: RagMatch[],
  maxContextChars: number,
): string {
  if (matches.length === 0) {
    return prompt;
  }
  const sections: string[] = ["Retrieved context:"];
  let used = "Retrieved context:".length;
  for (const match of matches) {
    const section =
      "[" + match.sourceType + "] " + match.title + "\n" + match.content;
    if (used + section.length > maxContextChars) {
      break;
    }
    sections.push(section);
    used += section.length;
  }
  sections.push("User request:\n" + prompt);
  return sections.join("\n\n");
}
