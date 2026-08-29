import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { isRetryableApiError, withRetry } from "./reconnect";

function fakeSleep() {
  const delays: number[] = [];
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  return { sleep, delays };
}

describe("isRetryableApiError", () => {
  it("retries a raw network failure (no ApiError at all)", () => {
    expect(isRetryableApiError(new TypeError("Failed to fetch"))).toBe(true);
  });

  it("retries 5xx and 429 ApiErrors", () => {
    expect(isRetryableApiError(new ApiError("Server error", 500))).toBe(true);
    expect(isRetryableApiError(new ApiError("Bad gateway", 502))).toBe(true);
    expect(isRetryableApiError(new ApiError("Too many requests", 429))).toBe(true);
  });

  it("does not retry a real client/server disagreement", () => {
    expect(isRetryableApiError(new ApiError("Not found", 404))).toBe(false);
    expect(isRetryableApiError(new ApiError("Unauthorized", 401))).toBe(false);
    expect(isRetryableApiError(new ApiError("Bad request", 400))).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns the result immediately on first success without sleeping", async () => {
    const { sleep, delays } = fakeSleep();
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(
      fn,
      { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1_000, isRetryable: () => true },
      sleep,
    );
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("retries a retryable failure with increasing, capped backoff and then succeeds", async () => {
    const { sleep, delays } = fakeSleep();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("Server error", 500))
      .mockRejectedValueOnce(new ApiError("Server error", 500))
      .mockRejectedValueOnce(new ApiError("Server error", 500))
      .mockResolvedValueOnce("recovered");

    const result = await withRetry(
      fn,
      { maxAttempts: 8, baseDelayMs: 1_000, maxDelayMs: 3_000, isRetryable: isRetryableApiError },
      sleep,
    );

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(4);
    // 1000, 2000, then capped at 3000 instead of 4000
    expect(delays).toEqual([1_000, 2_000, 3_000]);
  });

  it("rethrows immediately without retrying a non-retryable error", async () => {
    const { sleep, delays } = fakeSleep();
    const notFound = new ApiError("Not found", 404);
    const fn = vi.fn().mockRejectedValue(notFound);

    await expect(
      withRetry(fn, { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1_000, isRetryable: isRetryableApiError }, sleep),
    ).rejects.toBe(notFound);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("gives up and rethrows the last error after maxAttempts", async () => {
    const { sleep } = fakeSleep();
    const failure = new ApiError("Server error", 500);
    const fn = vi.fn().mockRejectedValue(failure);

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, isRetryable: () => true }, sleep),
    ).rejects.toBe(failure);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
