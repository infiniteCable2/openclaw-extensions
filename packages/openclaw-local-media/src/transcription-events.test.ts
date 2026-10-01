import { expect, it } from "vitest";
import { readTranscriptionEvents } from "./transcription-events.js";

it("accepts optional STT recognition observations without exposing them as transcript text", async () => {
  const event = {
    type: "transcript.done",
    text: "Hallo",
    model: "test",
    recognition: {
      audioDurationMs: 1000,
      speechDurationMs: 500,
      segmentCount: 1,
      signals: [{ name: "backend.score", mean: 0.5, samples: 1 }],
    },
  };
  const response = new Response(`data: ${JSON.stringify(event)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
  expect(await readTranscriptionEvents(response, new AbortController().signal, () => {})).toBe("Hallo");
});
