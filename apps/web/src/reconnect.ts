import { ApiError } from "./api";

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable: (error: unknown) => boolean;
}

/**
 * Retries `fn` with exponential backoff until it succeeds, the error is not
 * retryable, or `maxAttempts` is exhausted. `sleep` is injectable so tests
 * can run without waiting on real timers.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      if (attempt >= options.maxAttempts || !options.isRetryable(error)) throw error;
      const delay = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      await sleep(delay);
    }
  }
}

/**
 * A raw network failure (fetch rejects with no response at all) or a 5xx/429
 * from the server is worth retrying. Any other `ApiError` (400, 401, 404, ...)
 * reflects a real client/server disagreement that a retry cannot fix.
 */
export function isRetryableApiError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === 429 || error.status >= 500;
  }
  return true;
}
