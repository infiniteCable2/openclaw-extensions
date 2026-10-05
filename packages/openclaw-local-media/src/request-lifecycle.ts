import { randomUUID } from "node:crypto";
import { requireLoopbackBaseUrl } from "./local-url.js";

/** One bounded service job, including cancellation before server admission. */
export function createMediaRequestLifecycle(params: {
  baseUrl: string;
  timeoutMs: number;
  signal?: AbortSignal;
  requestId?: string;
}) {
  const baseUrl = requireLoopbackBaseUrl(params.baseUrl, "Local media request");
  if (!Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0) {
    throw new Error("Local media request deadline expired");
  }
  const timeoutMs = Math.min(300_000, Math.ceil(params.timeoutMs));
  const requestId = params.requestId ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId)) {
    throw new Error("Local media request ID must be a UUIDv4");
  }
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  let finished = false;
  let cancellation: Promise<void> | undefined;
  const cancelService = () => {
    if (finished) return Promise.resolve();
    // A separate deadline/connection lets the service remove queued work even
    // after the inference HTTP request has been aborted. Never retry a job.
    cancellation ??= Promise.resolve()
      .then(() =>
        fetch(`${baseUrl}/requests/${requestId}/cancel`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(1_000),
        }),
      )
      .then(async (response) => {
        await response.body?.cancel();
      })
      .catch(() => undefined);
    return cancellation;
  };
  const abort = () => {
    controller.abort(params.signal?.reason ?? new Error("Local media request cancelled"));
  };
  controller.signal.addEventListener(
    "abort",
    () => {
      void cancelService();
    },
    { once: true },
  );
  const timer = setTimeout(() => {
    controller.abort(new Error("Local media request deadline exceeded"));
  }, timeoutMs);
  timer.unref?.();
  params.signal?.addEventListener("abort", abort, { once: true });
  if (params.signal?.aborted) abort();
  return {
    requestId,
    signal: controller.signal,
    get headers() {
      return {
        "X-OpenClaw-Request-Id": requestId,
        "X-OpenClaw-Request-Timeout-Ms": String(
          Math.max(1, Math.ceil(deadline - performance.now())),
        ),
      };
    },
    cancel: () => {
      if (!finished) controller.abort(new Error("Local media response discarded"));
      return cancellation ?? Promise.resolve();
    },
    finish: () => {
      finished = true;
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", abort);
    },
  };
}
