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
  expect(await readTranscriptionEvents(response, new AbortController().signal, () => {})).toEqual({
    text: "Hallo",
    recognition: {
      speechDurationMs: 500, segmentCount: 1,
      signals: [{ name: "backend.score", mean: 0.5, samples: 1 }],
    },
  });
});

it("ignores invalid or duplicate decoder observations without promoting scores to confidence", async () => {
  const event = {
    type: "transcript.done", text: "Hallo", model: "test",
    recognition: {
      speechDurationMs: 500, segmentCount: 1,
      signals: [
        { name: "backend.logProbability", mean: -0.8, samples: 1 },
        { name: "backend.logProbability", mean: -4, samples: 3 },
        { name: "invalid name", mean: 1, samples: 1 },
        { name: "backend.zeroSamples", mean: 1, samples: 0 },
        { name: "backend.notNumeric", mean: "untrusted", samples: 1 },
      ],
    },
  };
  const response = new Response(`data: ${JSON.stringify(event)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
  const result = await readTranscriptionEvents(response, new AbortController().signal, () => {});
  expect(result.recognition?.signals).toEqual([
    { name: "backend.logProbability", mean: -0.8, samples: 1 },
  ]);
  expect(result.text).toBe("Hallo");
});

it("ignores malformed recognition observations without losing a valid transcript", async () => {
  const event = {
    type: "transcript.done", text: "Hallo", model: "test",
    recognition: { speechDurationMs: -1, segmentCount: 1 },
  };
  const response = new Response(`data: ${JSON.stringify(event)}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
  expect(await readTranscriptionEvents(response, new AbortController().signal, () => {})).toEqual({
    text: "Hallo",
  });
});
