import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createLiveSpeechProcessor } from "./live-speech-processor.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function mockChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

describe("live speech processor", () => {
  it("waits for readiness and preserves ordered 20 ms frames", async () => {
    const child = mockChild();
    const frames: Array<{ audio: Buffer; speechProbability: number; gainDb: number }> = [];
    const onError = vi.fn();
    const processor = createLiveSpeechProcessor({
      python: "/opt/stt/bin/python",
      onFrame: (frame) => frames.push(frame),
      onError,
    });
    const connected = processor.connect();
    expect(spawn).toHaveBeenCalledWith(
      "/opt/stt/bin/python",
      ["-m", "openclaw_local_stt.speech_stream"],
      expect.objectContaining({ windowsHide: true }),
    );
    child.stdout.write(Buffer.from("AP"));
    child.stdout.write(Buffer.from("M2"));
    await connected;
    const frame = Buffer.alloc(640, 17);
    child.stdin.on("data", (input: Buffer) => {
      const metadata = Buffer.alloc(8);
      metadata.writeFloatLE(0.8, 0);
      metadata.writeFloatLE(6, 4);
      for (let offset = 0; offset < input.byteLength; offset += 640) {
        child.stdout.write(input.subarray(offset, offset + 640));
        child.stdout.write(metadata);
      }
    });
    processor.send(Buffer.concat([frame, frame]));
    expect(frames).toHaveLength(2);
    expect(frames.map(({ audio, gainDb }) => ({ audio, gainDb }))).toEqual([
      { audio: frame, gainDb: 6 },
      { audio: frame, gainDb: 6 },
    ]);
    expect(frames[0]?.speechProbability).toBeCloseTo(0.8);
    expect(frames[1]?.speechProbability).toBeCloseTo(0.8);
    expect(onError).not.toHaveBeenCalled();
    processor.close();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("fails closed when the native worker falls behind", async () => {
    const child = mockChild();
    const onError = vi.fn();
    const processor = createLiveSpeechProcessor({
      python: "/opt/stt/bin/python",
      onFrame: vi.fn(),
      onError,
    });
    const connected = processor.connect();
    child.stdout.write(Buffer.from("APM2"));
    await connected;
    processor.send(Buffer.alloc(640 * 101));
    expect(onError).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("fails closed on invalid speech evidence instead of falling back to RMS", async () => {
    const child = mockChild();
    const onError = vi.fn();
    const onFrame = vi.fn();
    const processor = createLiveSpeechProcessor({
      python: "/opt/stt/bin/python",
      onFrame,
      onError,
    });
    const connected = processor.connect();
    child.stdout.write(Buffer.from("APM2"));
    await connected;
    processor.send(Buffer.alloc(640));
    const response = Buffer.alloc(648);
    response.writeFloatLE(Number.NaN, 640);
    response.writeFloatLE(0, 644);
    child.stdout.write(response);
    expect(onFrame).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
