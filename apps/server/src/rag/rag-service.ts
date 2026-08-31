import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { JsonStore } from "../store.js";
import type { Agent } from "../types.js";
import { createEmbeddingClient } from "./embeddings.js";
import type { EmbeddingClient, RagContext, RagMatch, RagStatus, RagSourceType } from "./types.js";

interface ChunkCandidate {
  sourceType: RagSourceType;
  sourceId: string;
  title: string;
  content: string;
}

interface EligibleFile {
  path: string;
  mtimeMs: number;
}

// Unbounded growth guard for chunkEmbeddingCache -- once it crosses this
// many entries, the oldest half (Map preserves insertion order) is evicted
// rather than letting a long-running server accumulate one entry per
// unique chunk of text it has ever scanned, forever.
const MAX_CACHED_EMBEDDINGS = 5_000;

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".deleted",
  ".codex",
  "node_modules",
  "dist",
]);

// Platform-managed scaffolding, not user content — excluded so retrieval
// never surfaces these filenames (or their contents) to end users.
const DEFAULT_IGNORED_FILES = new Set([".DS_Store", "AGENTS.md", "README.md", ".gitignore"]);

export class RagService {
  private readonly embeddingClient: EmbeddingClient;
  private readonly chunkEmbeddingCache = new Map<string, number[]>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
  ) {
    this.embeddingClient = createEmbeddingClient(config);
  }

  async buildContext(agent: Agent, prompt: string): Promise<RagContext> {
    const [workspaceChunks, sharedChunks] = await Promise.all([
      this.collectFilesystemChunks(agent.workspacePath, "workspace", agent.id),
      this.collectFilesystemChunks(this.config.sharedResourceRoot, "shared", "shared-root"),
    ]);

    const candidates = [...workspaceChunks, ...sharedChunks];
    if (candidates.length === 0) {
      return {
        prompt,
        matches: [],
        summary: {
          status: "no_context",
          confidence: 0,
          topScore: null,
          candidateCount: 0,
          matchCount: 0,
        },
      };
    }

    const [queryEmbedding] = await this.embeddingClient.embed([prompt]);
    const chunkEmbeddings = await this.embedChunksCached(candidates);
    const scored = candidates.map((candidate, index) => ({
      ...candidate,
      score: cosineSimilarity(queryEmbedding ?? [], chunkEmbeddings[index] ?? []),
    }));

    const ordered = scored.sort((left, right) => right.score - left.score);
    const topScore = ordered[0]?.score ?? null;
    const includedMatches = ordered
      .slice(0, this.config.ragTopK)
      .map((match): RagMatch => ({
        sourceType: match.sourceType,
        sourceId: match.sourceId,
        title: match.title,
        content: match.content,
        score: match.score,
      }));
    const summary = summarizeMatches(
      candidates.length,
      includedMatches.length,
      topScore,
      this.config.ragMinScore,
      this.config.ragStrongScore,
    );

    return {
      prompt: buildAugmentedPrompt(prompt, includedMatches, this.config.ragMaxContextChars),
      matches: includedMatches,
      summary,
    };
  }

  private async embedChunksCached(candidates: ChunkCandidate[]): Promise<number[][]> {
    const uncachedContent: string[] = [];
    for (const candidate of candidates) {
      if (!this.chunkEmbeddingCache.has(candidate.content)) {
        uncachedContent.push(candidate.content);
      }
    }
    if (uncachedContent.length > 0) {
      const freshEmbeddings = await this.embeddingClient.embed(uncachedContent);
      uncachedContent.forEach((content, index) => {
        const embedding = freshEmbeddings[index];
        if (embedding) {
          this.chunkEmbeddingCache.set(content, embedding);
        }
      });
      // Map preserves insertion order, so the earliest-inserted (typically
      // longest-untouched) entries are the ones dropped.
      while (this.chunkEmbeddingCache.size > MAX_CACHED_EMBEDDINGS) {
        const oldestKey = this.chunkEmbeddingCache.keys().next().value;
        if (oldestKey === undefined) break;
        this.chunkEmbeddingCache.delete(oldestKey);
      }
    }
    return candidates.map((candidate) => this.chunkEmbeddingCache.get(candidate.content) ?? []);
  }

  /**
   * Collects every eligible file under `root` first (cheap: just stats,
   * no content read), ranks by mtime descending, and only reads/chunks
   * enough of the newest files to fill `ragScanLimit`. This is what makes
   * the cap "the N most recently touched chunks" rather than whatever
   * order the OS's readdir happens to return -- readdir order is not
   * guaranteed, so truncating mid-walk (the previous approach) silently
   * dropped content in an effectively arbitrary, non-relevance-based way.
   */
  private async collectFilesystemChunks(
    root: string,
    sourceType: "workspace" | "shared",
    sourceId: string,
  ): Promise<ChunkCandidate[]> {
    const eligibleFiles: EligibleFile[] = [];
    await this.listEligibleFiles(root, eligibleFiles);
    eligibleFiles.sort((left, right) => right.mtimeMs - left.mtimeMs);

    const chunks: ChunkCandidate[] = [];
    for (const file of eligibleFiles) {
      if (chunks.length >= this.config.ragScanLimit) {
        break;
      }
      let content: string;
      try {
        content = await readFile(file.path, "utf8");
      } catch {
        continue;
      }
      if (!isLikelyText(content)) {
        continue;
      }
      for (const chunk of chunkText(content, this.config.ragChunkSize)) {
        if (chunks.length >= this.config.ragScanLimit) {
          break;
        }
        chunks.push({
          sourceType,
          sourceId,
          title: file.path,
          content: chunk,
        });
      }
    }
    return chunks;
  }

  private async listEligibleFiles(currentPath: string, out: EligibleFile[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        await this.listEligibleFiles(path.join(currentPath, entry.name), out);
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
      // Kept in sync with the same limit enforced at upload time
      // (AgentService.uploadAgentResource/uploadSharedResource) -- a file
      // too big to ever be scanned is rejected loudly there instead of
      // accepted here and then silently never surfaced.
      if (fileStat.size > this.config.ragMaxFileBytes) {
        continue;
      }
      out.push({ path: filePath, mtimeMs: fileStat.mtimeMs });
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

function summarizeMatches(
  candidateCount: number,
  matchCount: number,
  topScore: number | null,
  minimumScore: number,
  strongScore: number,
): { status: RagStatus; confidence: number; topScore: number | null; candidateCount: number; matchCount: number } {
  if (candidateCount === 0 || topScore === null) {
    return {
      status: "no_context",
      confidence: 0,
      topScore: null,
      candidateCount,
      matchCount: 0,
    };
  }
  if (topScore < minimumScore || matchCount === 0) {
    return {
      status: "weak",
      confidence: clampConfidence(topScore),
      topScore,
      candidateCount,
      matchCount,
    };
  }
  if (topScore >= strongScore) {
    return {
      status: "strong",
      confidence: clampConfidence(topScore),
      topScore,
      candidateCount,
      matchCount,
    };
  }
  return {
    status: "moderate",
    confidence: clampConfidence(topScore),
    topScore,
    candidateCount,
    matchCount,
  };
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}
