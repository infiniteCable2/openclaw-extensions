const MAX_RESPONSE_BYTES = 256 * 1024;

/** Consume the local STT event stream without retaining unbounded or backend error content. */
export async function readTranscriptionEvents(
  response: Response,
  signal: AbortSignal,
  onSpeechConfirmed: () => void,
): Promise<string> {
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
  let terminal: string | undefined;
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
      terminal = event.text.trim();
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
