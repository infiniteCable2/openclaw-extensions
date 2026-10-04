import { afterEach, describe, expect, it, vi } from "vitest";
import { createMediaRequestLifecycle } from "./request-lifecycle.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("local service request ownership", () => {
  it("sends one bounded cancellation for the same opaque job on timeout and repeated abort", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const job = createMediaRequestLifecycle({
      baseUrl: "http://127.0.0.1:8010/v1",
      timeoutMs: 100,
    });
    const id = job.headers["X-OpenClaw-Request-Id"];
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
    await vi.advanceTimersByTimeAsync(100);
    await job.cancel();
    expect(job.signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `http://127.0.0.1:8010/v1/requests/${id}/cancel`,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    job.finish();
  });

  it("does not cancel completed work when its former caller aborts", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const caller = new AbortController();
    const job = createMediaRequestLifecycle({
      baseUrl: "http://127.0.0.1:8020/v1",
      timeoutMs: 100,
      signal: caller.signal,
    });
    job.finish();
    caller.abort();
    await vi.advanceTimersByTimeAsync(200);
    await job.cancel();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles cancellation before admission and an unavailable cancellation endpoint", async () => {
    const fetchMock = vi.fn(() => {
      throw new Error("unavailable");
    });
    vi.stubGlobal("fetch", fetchMock);
    const caller = new AbortController();
    caller.abort();
    const job = createMediaRequestLifecycle({
      baseUrl: "http://127.0.0.1:8020/v1",
      timeoutMs: 100,
      signal: caller.signal,
    });
    expect(job.signal.aborted).toBe(true);
    await expect(job.cancel()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    job.finish();
  });

  it("bounds server duration and refuses remote cancellation targets", () => {
    const job = createMediaRequestLifecycle({
      baseUrl: "http://127.0.0.1:8010/v1",
      timeoutMs: 900_000,
    });
    expect(Number(job.headers["X-OpenClaw-Request-Timeout-Ms"])).toBeLessThanOrEqual(300_000);
    job.finish();
    expect(() =>
      createMediaRequestLifecycle({ baseUrl: "https://example.org/v1", timeoutMs: 100 }),
    ).toThrow("loopback");
    expect(() =>
      createMediaRequestLifecycle({ baseUrl: "http://127.0.0.1:8010/v1", timeoutMs: 0 }),
    ).toThrow("deadline");
  });
});
