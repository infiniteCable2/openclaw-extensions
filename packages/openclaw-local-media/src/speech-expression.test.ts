import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalSpeechExpressionAdmission } from "./speech-expression.js";

afterEach(() => vi.unstubAllGlobals());
const baseUrl = "http://127.0.0.1:8020/v1";
const model = "kitten-tts-2";
const expression = { emotions: ["joyful"], vocalEvents: ["laugh"], emphasis: true, whisper: false };
function response(extra: Record<string, unknown> = {}) {
  return Response.json(
    { schema_version: 1, model, generation: "worker1", expression, ...extra },
    { headers: { "X-OpenClaw-Service-Generation": "worker1" } },
  );
}
function fixture() {
  const worker = new AbortController();
  const localServiceAdmission = { generation: "worker1", signal: worker.signal };
  const context = { providerConfig: {}, timeoutMs: 1_000, localServiceAdmission };
  return { worker, context, localServiceAdmission, owner: createLocalSpeechExpressionAdmission() };
}

describe("service-backed speech expression admission", () => {
  it("keeps an already-cancelled first caller cold and lets a later live caller discover", async () => {
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);
    const { owner, context, localServiceAdmission, worker } = fixture();
    const caller = new AbortController();
    caller.abort(new Error("caller already closed"));

    await expect(
      owner.prepare({ ...context, signal: caller.signal }, baseUrl, model),
    ).rejects.toThrow("caller already closed");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(owner.get(localServiceAdmission, baseUrl, model)).toBeUndefined();
    expect(worker.signal.aborted).toBe(false);

    await owner.prepare(context, baseUrl, model);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(owner.get(localServiceAdmission, baseUrl, model)).toEqual(expression);
  });

  it("shares one bounded fetch across concurrent preparations and synchronous reads", async () => {
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);
    const { owner, context, localServiceAdmission, worker } = fixture();
    expect(owner.get(localServiceAdmission, baseUrl, model)).toBeUndefined();
    await Promise.all([
      owner.prepare(context, baseUrl, model),
      owner.prepare(context, baseUrl, model),
    ]);
    await owner.prepare(context, baseUrl, model);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(owner.get(localServiceAdmission, baseUrl, model)).toEqual(expression);
    expect(owner.get(localServiceAdmission, baseUrl, "chatterbox")).toBeUndefined();
    worker.abort(new Error("worker replaced"));
    expect(owner.get(localServiceAdmission, baseUrl, model)).toBeUndefined();
    await expect(owner.prepare(context, baseUrl, model)).rejects.toThrow("worker replaced");
  });

  it.each([
    { schema_version: 2 },
    { model: "other-model" },
    { generation: "worker2" },
    { expression: { ...expression, whisper: true } },
    { expression: { ...expression, emotions: ["joyful", "joyful"] } },
    { expression: { ...expression, emphasis: 1 } },
    { expression: { ...expression, reference: "private" } },
  ])("never publishes a mismatched or invalid service response: %j", async (extra) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(extra)),
    );
    const { owner, context, localServiceAdmission } = fixture();
    await expect(owner.prepare(context, baseUrl, model)).rejects.toThrow();
    expect(owner.get(localServiceAdmission, baseUrl, model)).toBeUndefined();
  });

  it("rejects streaming overflow without trusting the declared size", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 + 1));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            headers: { "content-type": "application/json", "content-length": "1" },
          }),
      ),
    );
    const { owner, context } = fixture();
    await expect(owner.prepare(context, baseUrl, model)).rejects.toThrow("size limit");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cannot publish after generation retirement during the capabilities await", async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const { owner, context, localServiceAdmission, worker } = fixture();
    const preparing = owner.prepare(context, baseUrl, model);
    worker.abort(new Error("worker retired"));
    finish(response());
    await expect(preparing).rejects.toThrow("worker retired");
    expect(owner.get(localServiceAdmission, baseUrl, model)).toBeUndefined();
  });

  it("cancels one waiter without cancelling another admitted caller's shared discovery", async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const { owner, context, localServiceAdmission } = fixture();
    const caller = new AbortController();
    const cancelled = owner.prepare({ ...context, signal: caller.signal }, baseUrl, model);
    const retained = owner.prepare(context, baseUrl, model);
    caller.abort(new Error("caller closed"));
    await expect(cancelled).rejects.toThrow("caller closed");
    finish(response());
    await retained;
    expect(owner.get(localServiceAdmission, baseUrl, model)).toEqual(expression);
  });

  it("shares failed discovery and permits a later retry on the same live worker", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetchMock);
    const { owner, context, localServiceAdmission } = fixture();
    const failed = await Promise.allSettled([
      owner.prepare(context, baseUrl, model),
      owner.prepare(context, baseUrl, model),
    ]);
    expect(failed.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(owner.get(localServiceAdmission, baseUrl, model)).toBeUndefined();
    await owner.prepare(context, baseUrl, model);
    await owner.prepare(context, baseUrl, model);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(owner.get(localServiceAdmission, baseUrl, model)).toEqual(expression);
  });

  it("retains an admitted unsupported-expression result without rediscovery", async () => {
    const fetchMock = vi.fn(async () => response({ expression: null }));
    vi.stubGlobal("fetch", fetchMock);
    const { owner, context, localServiceAdmission } = fixture();
    await owner.prepare(context, baseUrl, model);
    await owner.prepare(context, baseUrl, model);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(owner.get(localServiceAdmission, baseUrl, model)).toBeUndefined();
  });

  it("keeps inventory cold and publishes no generation-free expressive readiness", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { owner, context } = fixture();
    expect(owner.get(undefined, baseUrl, model)).toBeUndefined();
    await owner.prepare(context, baseUrl, "chatterbox");
    await owner.prepare({ ...context, localServiceAdmission: undefined }, baseUrl, model);
    expect(owner.get(undefined, baseUrl, model)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
