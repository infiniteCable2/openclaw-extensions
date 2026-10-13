import type { SpeechProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";

type CapabilityContext = Parameters<
  NonNullable<SpeechProviderPlugin["prepareExpressionCapabilities"]>
>[0];
type Capabilities = NonNullable<
  ReturnType<NonNullable<SpeechProviderPlugin["getExpressionCapabilities"]>>
>;
type SegmentationProfile = NonNullable<
  ReturnType<NonNullable<SpeechProviderPlugin["getSegmentationProfile"]>>
>;
type Admission = NonNullable<CapabilityContext["localServiceAdmission"]>;
type AdmissionEntry = {
  baseUrl: string;
  model: string;
  preparation: Promise<void>;
  capabilities?: Capabilities;
  segmentation?: SegmentationProfile;
};
const MAX_CAPABILITIES_BYTES = 16 * 1024;
export const KITTEN_TTS2_MODEL_ID = "kitten-tts-2";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function vocabulary(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    value.some((item) => typeof item !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(item)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("Local media TTS returned invalid expression vocabulary");
  }
  return Object.freeze(value);
}

function segmentationProfile(value: unknown): SegmentationProfile | undefined {
  if (value === undefined) return undefined;
  const segmentation = object(value);
  const profile = object(segmentation?.profile);
  const pauses = object(profile?.pauses);
  const integer = (number: unknown, min: number, max: number): number => {
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < min || number > max)
      throw new Error("Local media TTS returned invalid segmentation capabilities");
    return number;
  };
  if (
    !segmentation ||
    !profile ||
    !pauses ||
    segmentation.schema_version !== 1 ||
    segmentation.prepared_segments !== true ||
    Object.keys(segmentation).some(
      (key) => !["schema_version", "profile", "prepared_segments"].includes(key),
    ) ||
    Object.keys(profile).some(
      (key) => !["minChars", "targetWords", "maxWords", "maxChars", "pauses"].includes(key),
    ) ||
    Object.keys(pauses).some(
      (key) => !["paragraph", "sentence", "clause", "fragment"].includes(key),
    )
  )
    throw new Error("Local media TTS returned invalid segmentation capabilities");
  const maxChars = integer(profile.maxChars, 64, 2_000);
  const maxWords = integer(profile.maxWords, 1, 200);
  return Object.freeze({
    minChars: integer(profile.minChars, 0, maxChars),
    targetWords: integer(profile.targetWords, 1, maxWords),
    maxWords,
    maxChars,
    pauses: Object.freeze({
      paragraph: integer(pauses.paragraph, 0, 2_000),
      sentence: integer(pauses.sentence, 0, 2_000),
      clause: integer(pauses.clause, 0, 2_000),
      fragment: integer(pauses.fragment, 0, 2_000),
    }),
  });
}

async function readCapabilities(
  baseUrl: string,
  model: string,
  admission: Admission,
  timeoutMs: number,
): Promise<{ capabilities?: Capabilities; segmentation?: SegmentationProfile }> {
  const signal = AbortSignal.any([admission.signal, AbortSignal.timeout(timeoutMs)]);
  signal.throwIfAborted();
  const response = await fetch(`${baseUrl}/capabilities`, {
    method: "GET",
    redirect: "error",
    signal,
  });
  try {
    if (!response.ok)
      throw new Error(`Local media TTS capabilities failed with HTTP ${response.status}`);
    if (
      response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json" ||
      Number(response.headers.get("content-length")) > MAX_CAPABILITIES_BYTES ||
      !response.body
    ) {
      throw new Error("Local media TTS returned invalid capabilities");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        signal.throwIfAborted();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > MAX_CAPABILITIES_BYTES)
          throw new Error("Local media TTS capabilities exceed their size limit");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const body = object(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
    if (
      !body ||
      body.schema_version !== 1 ||
      body.model !== model ||
      body.generation !== admission.generation ||
      response.headers.get("x-openclaw-service-generation") !== admission.generation ||
      Object.keys(body).some(
        (key) =>
          !["schema_version", "model", "generation", "expression", "segmentation"].includes(key),
      )
    ) {
      const error = new Error(
        "Local media TTS capabilities do not match the admitted worker/model",
      );
      error.name = "LocalServiceAdmissionError";
      throw error;
    }
    const segmentation = segmentationProfile(body.segmentation);
    if (body.expression === null) return { segmentation };
    const expression = object(body.expression);
    if (
      !expression ||
      typeof expression.emphasis !== "boolean" ||
      expression.whisper !== false ||
      Object.keys(expression).some(
        (key) => !["emotions", "vocalEvents", "emphasis", "whisper"].includes(key),
      )
    ) {
      throw new Error("Local media TTS returned invalid expression capabilities");
    }
    admission.signal.throwIfAborted();
    return {
      segmentation,
      capabilities: Object.freeze({
        emotions: vocabulary(expression.emotions),
        vocalEvents: vocabulary(expression.vocalEvents),
        emphasis: expression.emphasis,
        whisper: false,
      }),
    };
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

function waitForPreparation<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Both projections share this provider's admitted worker/model lifetime and bounded discovery. */
export function createLocalSpeechCapabilitiesAdmission() {
  const admitted = new WeakMap<Admission, AdmissionEntry>();
  return {
    async prepare(
      context: CapabilityContext,
      baseUrl: string,
      model: string,
      requireSegmentation = false,
    ): Promise<void> {
      const admission = context.localServiceAdmission;
      // Plain synthesis remains compatible with legacy status-only services.
      // Expressive synthesis still requires the admitted projection below.
      if (!admission) {
        if (requireSegmentation)
          throw new Error("Local media speech segmentation requires a worker admission");
        return;
      }
      context.signal?.throwIfAborted();
      admission.signal.throwIfAborted();
      let entry = admitted.get(admission);
      if (entry && (entry.baseUrl !== baseUrl || entry.model !== model)) {
        throw new Error("Local media speech selection changed within one worker admission");
      }
      if (!entry) {
        if (!Number.isFinite(context.timeoutMs) || context.timeoutMs <= 0) {
          throw new Error("Local media speech capability admission deadline expired");
        }
        const installed: AdmissionEntry = { baseUrl, model, preparation: Promise.resolve() };
        admitted.set(admission, installed);
        const retire = () => {
          if (admitted.get(admission) === installed) admitted.delete(admission);
        };
        admission.signal.addEventListener("abort", retire, { once: true });
        installed.preparation = readCapabilities(
          baseUrl,
          model,
          admission,
          Math.min(300_000, Math.ceil(context.timeoutMs)),
        )
          .then((metadata) => {
            admission.signal.throwIfAborted();
            installed.capabilities = metadata.capabilities;
            installed.segmentation = metadata.segmentation;
          })
          .catch((error: unknown) => {
            // Failed discovery is not an admitted fact. Allow a later request
            // to retry without retiring this otherwise-live service worker.
            admission.signal.removeEventListener("abort", retire);
            retire();
            throw error;
          });
        entry = installed;
      }
      await waitForPreparation(entry.preparation, context.signal);
      context.signal?.throwIfAborted();
      admission.signal.throwIfAborted();
      if (requireSegmentation && !entry.segmentation)
        throw new Error("Local media speech worker does not support prepared segmentation");
    },
    get(
      admission: Admission | undefined,
      baseUrl: string,
      model: string,
    ): Capabilities | undefined {
      if (!admission || admission.signal.aborted) return undefined;
      const entry = admitted.get(admission);
      return entry?.baseUrl === baseUrl && entry.model === model ? entry.capabilities : undefined;
    },
    getSegmentation(
      admission: Admission | undefined,
      baseUrl: string,
      model: string,
    ): SegmentationProfile | undefined {
      if (!admission || admission.signal.aborted) return undefined;
      const entry = admitted.get(admission);
      return entry?.baseUrl === baseUrl && entry.model === model ? entry.segmentation : undefined;
    },
  };
}
