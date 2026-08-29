import type { AppConfig } from "./config.js";
import type { EmbeddingClient } from "./types.js";

const DEFAULT_EMBEDDING_DIMENSION = 256;

function normalizeVector(vector: number[]): number[] {
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (length === 0) {
    return vector;
  }
  return vector.map((value) => value / length);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

class LocalEmbeddingClient implements EmbeddingClient {
  constructor(private readonly dimension = DEFAULT_EMBEDDING_DIMENSION) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = new Array<number>(this.dimension).fill(0);
      for (const token of tokenize(text)) {
        let hash = 0;
        for (let index = 0; index < token.length; index += 1) {
          hash = (hash * 31 + token.charCodeAt(index)) >>> 0;
        }
        const bucket = hash % this.dimension;
        vector[bucket] = (vector[bucket] ?? 0) + 1;
      }
      return normalizeVector(vector);
    });
  }
}

class OpenRouterEmbeddingClient implements EmbeddingClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(this.baseUrl + "/embeddings", {
      method: "POST",
      headers: {
        authorization: "Bearer " + this.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });
    if (!response.ok) {
      throw new Error("Embedding request failed with status " + response.status);
    }
    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    return (payload.data ?? []).map((item) => item.embedding ?? []);
  }
}

export function createEmbeddingClient(config: AppConfig): EmbeddingClient {
  if (config.openRouterApiKey && config.openRouterEmbeddingModel) {
    return new OpenRouterEmbeddingClient(
      config.openRouterBaseUrl,
      config.openRouterApiKey,
      config.openRouterEmbeddingModel,
    );
  }
  return new LocalEmbeddingClient();
}
