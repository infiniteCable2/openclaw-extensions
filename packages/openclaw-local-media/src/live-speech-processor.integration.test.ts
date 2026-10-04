import { describe, expect, it } from "vitest";
import { createLiveSpeechProcessor, type LiveSpeechFrame } from "./live-speech-processor.js";

const python = process.env.OPENCLAW_STT_REPLAY_PYTHON;

// Opt-in because CI need not have the pinned native WebRTC/Python environment.
describe.skipIf(!python)("native live speech worker contract", () => {
  it("returns one ordered, finite evidence frame per 20-ms input without STT", async () => {
    const received: LiveSpeechFrame[] = [];
    const errors: Error[] = [];
    const processor = createLiveSpeechProcessor({
      python: python!,
      onFrame: (frame) => received.push(frame),
      onError: (error) => errors.push(error),
    });
    try {
      await processor.connect();
      const input = Buffer.alloc(640 * 40);
      for (let offset = 640 * 20; offset < 640 * 21; offset += 2) {
        input.writeInt16LE(offset % 4 === 0 ? 1_000 : -1_000, offset);
      }
      processor.send(input.subarray(0, 640 * 13 + 19));
      processor.send(input.subarray(640 * 13 + 19));
      const deadline = Date.now() + 5_000;
      while (received.length < 40 && errors.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(errors).toEqual([]);
      expect(received).toHaveLength(40);
      for (const frame of received) {
        expect(frame.audio.byteLength).toBe(640);
        expect(frame.speechProbability).toBeGreaterThanOrEqual(0);
        expect(frame.speechProbability).toBeLessThanOrEqual(1);
        expect(Number.isFinite(frame.gainDb)).toBe(true);
        expect(frame.control).toBeDefined();
        expect(
          frame.control!.speechFrames +
            frame.control!.uncertainFrames +
            frame.control!.nonspeechFrames,
        ).toBe(2);
        expect(
          frame.control!.holdFrames + frame.control!.attenuateFrames + frame.control!.recoverFrames,
        ).toBe(2);
      }
    } finally {
      processor.close();
    }
  });
});
