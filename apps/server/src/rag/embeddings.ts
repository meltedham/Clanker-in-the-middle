import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import type { AppConfig } from "../config.js";
import type { EmbeddingClient } from "./types.js";

const LOCAL_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const RATE_LIMIT_RESET_HEADER = "x-ratelimit-reset";
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;

let localPipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

function getLocalPipeline(): Promise<FeatureExtractionPipeline> {
  if (!localPipelinePromise) {
    localPipelinePromise = pipeline("feature-extraction", LOCAL_MODEL_ID);
  }
  return localPipelinePromise;
}

class LocalTransformersEmbeddingClient implements EmbeddingClient {
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const extractor = await getLocalPipeline();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    const dimension = output.dims.at(-1) ?? 0;
    const flat = output.data as unknown as ArrayLike<number>;
    const vectors: number[][] = [];
    for (let index = 0; index < texts.length; index += 1) {
      const start = index * dimension;
      vectors.push(Array.from(flat).slice(start, start + dimension));
    }
    return vectors;
  }
}

class EmbeddingRequestError extends Error {
  constructor(
    readonly status: number,
    readonly rateLimitResetHeader: string | null,
  ) {
    super("Embedding request failed with status " + status);
  }
}

class OpenRouterEmbeddingClient implements EmbeddingClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
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
      throw new EmbeddingRequestError(response.status, response.headers.get(RATE_LIMIT_RESET_HEADER));
    }
    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    return (payload.data ?? []).map((item) => item.embedding ?? []);
  }
}

function resolveRateLimitReset(headerValue: string | null): number {
  const parsed = headerValue ? Number(headerValue) : NaN;
  if (Number.isFinite(parsed) && parsed > Date.now()) {
    return parsed;
  }
  return Date.now() + DEFAULT_RATE_LIMIT_COOLDOWN_MS;
}

/**
 * Prefers the remote client (e.g. OpenRouter's free-tier embedding models) and
 * falls back to a local model once the remote side starts returning 429s,
 * remembering the reset time so it doesn't keep re-triggering a rate limit
 * that's guaranteed to fail again until the window resets.
 */
class FallbackEmbeddingClient implements EmbeddingClient {
  private rateLimitedUntil = 0;

  constructor(
    private readonly primary: EmbeddingClient,
    private readonly fallback: EmbeddingClient,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (Date.now() < this.rateLimitedUntil) {
      return this.fallback.embed(texts);
    }
    try {
      return await this.primary.embed(texts);
    } catch (error) {
      if (error instanceof EmbeddingRequestError && error.status === 429) {
        this.rateLimitedUntil = resolveRateLimitReset(error.rateLimitResetHeader);
        return this.fallback.embed(texts);
      }
      throw error;
    }
  }
}

export function createEmbeddingClient(config: AppConfig): EmbeddingClient {
  const local = new LocalTransformersEmbeddingClient();
  if (config.openRouterApiKey && config.openRouterEmbeddingModel) {
    const openRouter = new OpenRouterEmbeddingClient(
      config.openRouterBaseUrl,
      config.openRouterApiKey,
      config.openRouterEmbeddingModel,
    );
    return new FallbackEmbeddingClient(openRouter, local);
  }
  return local;
}
