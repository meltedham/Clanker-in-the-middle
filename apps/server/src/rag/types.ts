export type RagStatus = "no_context" | "weak" | "moderate" | "strong";

export interface RagSummary {
  status: RagStatus;
  confidence: number;
  topScore: number | null;
  candidateCount: number;
  matchCount: number;
}

export type RagSourceType = "workspace" | "shared" | "message";

export interface RagMatch {
  sourceType: RagSourceType;
  sourceId: string;
  title: string;
  content: string;
  score: number;
}

export interface RagContext {
  prompt: string;
  matches: RagMatch[];
  summary: RagSummary;
}

export interface EmbeddingClient {
  embed(texts: string[]): Promise<number[][]>;
}
