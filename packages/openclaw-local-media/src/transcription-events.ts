const MAX_RESPONSE_BYTES = 256 * 1024;

export type RecognitionSummary = {
  speechDurationMs: number | null;
  segmentCount: number;
};

export type TranscriptionResult = {
  text: string;
  recognition?: RecognitionSummary;
};

function recognitionSummary(value: unknown): RecognitionSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { speechDurationMs, segmentCount } = value as Record<string, unknown>;
  if (
    (speechDurationMs !== null &&
      (typeof speechDurationMs !== "number" ||
        !Number.isSafeInteger(speechDurationMs) ||
        speechDurationMs < 0)) ||
    typeof segmentCount !== "number" ||
    !Number.isInteger(segmentCount) ||
    segmentCount < 0 ||
    segmentCount > 2_147_483_647
  ) {
    return undefined;
  }
  return { speechDurationMs, segmentCount };
}

/** Consume the local STT event stream without retaining unbounded or backend error content. */
export async function readTranscriptionEvents(
  response: Response,
  signal: AbortSignal,
  onSpeechConfirmed: () => void,
): Promise<TranscriptionResult> {
  const invalid = () => new Error("Local media transcription event stream failed");
  if (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "text/event-stream" ||
    !response.body ||
    Number(response.headers.get("content-length") ?? 0) > MAX_RESPONSE_BYTES
  ) {
    void response.body?.cancel().catch(() => {});
    throw invalid();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let pending = "";
  let confirmed = false;
  let terminal: TranscriptionResult | undefined;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });

  const consume = (frame: string) => {
    const data = frame
      .split(/\r\n|\n|\r/u)
      .filter((line) => line === "data" || line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""));
    if (data.length === 0) return;
    const event: unknown = JSON.parse(data.join("\n"));
    if (!event || typeof event !== "object" || !("type" in event) || terminal !== undefined) {
      throw invalid();
    }
    if (event.type === "speech.confirmed") {
      if (confirmed) throw invalid();
      confirmed = true;
      onSpeechConfirmed();
    } else if (
      event.type === "transcript.done" &&
      "text" in event &&
      typeof event.text === "string" &&
      "model" in event &&
      typeof event.model === "string"
    ) {
      const recognition = "recognition" in event
        ? recognitionSummary(event.recognition)
        : undefined;
      terminal = {
        text: event.text.trim(),
        ...(recognition ? { recognition } : {}),
      };
    } else {
      // This includes the backend's error event. Its message is never propagated.
      throw invalid();
    }
  };

  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) {
        pending += decoder.decode();
        if (pending.length !== 0 || terminal === undefined) throw invalid();
        return terminal;
      }
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw invalid();
      pending += decoder.decode(next.value, { stream: true });
      let separator: RegExpExecArray | null;
      while ((separator = /\r\n\r\n|\n\n|\r\r/u.exec(pending))) {
        consume(pending.slice(0, separator.index));
        pending = pending.slice(separator.index + separator[0].length);
        signal.throwIfAborted();
      }
    }
  } catch {
    throw invalid();
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
