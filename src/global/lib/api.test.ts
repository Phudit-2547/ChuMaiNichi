import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import axios, { AxiosError, CanceledError } from "axios";
import { queryDB, isColdStartError } from "./api";

// Mock only the transport methods; keep axios.isAxiosError / axios.isCancel and
// the AxiosError / CanceledError classes real so error classification is exercised.
vi.mock("axios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("axios")>();
  return {
    ...actual,
    default: { ...actual.default, post: vi.fn(), get: vi.fn() },
  };
});

// Deterministic auth headers, no zustand/localStorage in the node test env.
vi.mock("../../features/auth/stores/auth-store", () => ({
  default: {
    getState: () => ({
      getAuthHeaders: () => ({ Authorization: "Bearer test" }),
    }),
  },
}));

function httpError(status: number): AxiosError {
  return new AxiosError(`HTTP ${status}`, "ERR_BAD_RESPONSE", undefined, undefined, {
    status,
    statusText: "",
    headers: {},
    // config is required by the type but unused here
    config: {} as never,
    data: { error: "boom" },
  });
}

function networkError(): AxiosError {
  return new AxiosError("Network Error", "ERR_NETWORK");
}

const post = vi.mocked(axios.post);

describe("isColdStartError", () => {
  it("treats 5xx responses as retryable", () => {
    expect(isColdStartError(httpError(500))).toBe(true);
    expect(isColdStartError(httpError(503))).toBe(true);
  });

  it("treats a missing response (network/timeout) as retryable", () => {
    expect(isColdStartError(networkError())).toBe(true);
  });

  it("does not retry 4xx responses", () => {
    expect(isColdStartError(httpError(401))).toBe(false);
    expect(isColdStartError(httpError(403))).toBe(false);
    expect(isColdStartError(httpError(400))).toBe(false);
  });

  it("does not retry caller-initiated cancellation", () => {
    expect(isColdStartError(new CanceledError())).toBe(false);
  });

  it("ignores non-axios errors", () => {
    expect(isColdStartError(new Error("nope"))).toBe(false);
  });
});

describe("queryDB cold-start retry", () => {
  beforeEach(() => {
    post.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a warming database and resolves once it wakes", async () => {
    post
      .mockRejectedValueOnce(httpError(500))
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce({ data: { rows: [{ ok: 1 }] } });

    const promise = queryDB("SELECT 1");
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual([{ ok: 1 }]);
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("does not retry an authentication failure", async () => {
    post.mockRejectedValue(httpError(401));

    await expect(queryDB("SELECT 1")).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget and wraps the last error", async () => {
    post.mockRejectedValue(httpError(500));

    const promise = queryDB("SELECT 1");
    const assertion = expect(promise).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
    });
    await vi.runAllTimersAsync();
    await assertion;

    expect(post).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it("stops retrying when the caller aborts mid-backoff", async () => {
    const controller = new AbortController();
    post.mockImplementation(() => {
      // Abort while the first backoff is pending.
      controller.abort();
      return Promise.reject(httpError(500));
    });

    const promise = queryDB("SELECT 1", [], controller.signal);
    const assertion = expect(promise).rejects.toBeDefined();
    await vi.runAllTimersAsync();
    await assertion;

    expect(post).toHaveBeenCalledTimes(1);
  });
});
