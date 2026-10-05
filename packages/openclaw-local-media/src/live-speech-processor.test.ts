import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveSpeechProcessor } from "./live-speech-processor.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => vi.useRealTimers());

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

function metadata(): Buffer {
  const data = Buffer.alloc(32);
  data.writeFloatLE(2, 20); // Two low-probability analysis frames.
  data.writeFloatLE(2, 28); // Two muted analysis frames.
  return data;
}

function responseFrame(): Buffer {
  return Buffer.concat([Buffer.alloc(640), metadata()]);
}

describe("live speech processor", () => {
  it("drops an abandoned partial raw frame instead of splicing it into later audio", async () => {
    vi.useFakeTimers();
    const child = mockChild();
    const onFrame = vi.fn();
    const processor = createLiveSpeechProcessor({
      python: "/opt/stt/bin/python",
      onFrame,
      onError: vi.fn(),
    });
    const connected = processor.connect();
    child.stdout.write(Buffer.from("APM4"));
    await connected;
    processor.send(Buffer.alloc(37, 0xff));
    await vi.advanceTimersByTimeAsync(2_000);
    processor.send(Buffer.alloc(640));
    const response = responseFrame();
    child.stdout.write(response);
    expect(onFrame).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ originalRms: 0, originalPeak: 0 }),
    );
    processor.close();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("aligns original levels across fragmented input and delayed processed frames", async () => {
    const child = mockChild();
    const onFrame = vi.fn();
    const processor = createLiveSpeechProcessor({
      python: "/opt/stt/bin/python",
      onFrame,
      onError: vi.fn(),
    });
    const connected = processor.connect();
    child.stdout.write(Buffer.from("APM4"));
    await connected;
    const original = Buffer.alloc(1280);
    for (let i = 0; i < original.length; i += 2) original.writeInt16LE(i < 640 ? 8192 : -16384, i);
    processor.send(original.subarray(0, 117));
    processor.send(original.subarray(117, 643));
    processor.send(original.subarray(643));
    const processed = Buffer.concat([responseFrame(), responseFrame()]);
    for (const offset of [0, 672]) {
      processed.writeFloatLE(0.9, offset + 640);
      processed.writeFloatLE(offset === 0 ? 12 : -6, offset + 644);
      processed.writeFloatLE(offset === 0 ? 0.125 : 0.25, offset + 648);
    }
    child.stdout.write(processed.subarray(0, 649));
    child.stdout.write(processed.subarray(649));
    expect(onFrame.mock.calls.map(([frame]) => [frame.originalRms, frame.originalPeak])).toEqual([
      [0.25, 0.25],
      [0.5, 0.5],
    ]);
    expect(onFrame.mock.calls.map(([frame]) => frame.gainDb)).toEqual([12, -6]);
    expect(onFrame.mock.calls.map(([frame]) => frame.control.cleanRms)).toEqual([0.125, 0.25]);
    processor.close();
  });

  it("rejects an old worker handshake rather than misframing its audio", async () => {
    const child = mockChild();
    const processor = createLiveSpeechProcessor({
      python: "/opt/stt/bin/python",
      onFrame: vi.fn(),
      onError: vi.fn(),
    });
    const connected = processor.connect();
    const rejection = expect(connected).rejects.toThrow("invalid handshake");
    child.stdout.write(Buffer.from("APM3"));
    await rejection;
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it.each([Number.NaN, -1, 3, 0.5])("rejects invalid numeric control counts %s", async (count) => {
    const child = mockChild();
    const onError = vi.fn();
    const onFrame = vi.fn();
    const processor = createLiveSpeechProcessor({
      python: "/opt/stt/bin/python",
      onFrame,
      onError,
    });
    const connected = processor.connect();
    child.stdout.write(Buffer.from("APM4"));
    await connected;
    processor.send(Buffer.alloc(640));
    const response = responseFrame();
    response.writeFloatLE(count, 660);
    child.stdout.write(response);
    expect(onFrame).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("times out a stalled native worker even if no further input arrives", async () => {
    vi.useFakeTimers();
    const child = mockChild();
    const onError = vi.fn();
    const processor = createLiveSpeechProcessor({
      python: "/opt/stt/bin/python",
      onFrame: vi.fn(),
      onError,
    });
    const connected = processor.connect();
    child.stdout.write(Buffer.from("APM4"));
    await connected;
    processor.send(Buffer.alloc(640));
    await vi.advanceTimersByTimeAsync(1999);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Live speech processor response timed out" }),
    );
    expect(child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

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
    child.stdout.write(Buffer.from("M4"));
    await connected;
    const frame = Buffer.alloc(640, 17);
    child.stdin.on("data", (input: Buffer) => {
      const fields = metadata();
      fields.writeFloatLE(0.8, 0);
      fields.writeFloatLE(6, 4);
      for (let offset = 0; offset < input.byteLength; offset += 640) {
        child.stdout.write(input.subarray(offset, offset + 640));
        child.stdout.write(fields);
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
    child.stdout.write(Buffer.from("APM4"));
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
    child.stdout.write(Buffer.from("APM4"));
    await connected;
    processor.send(Buffer.alloc(640));
    const response = responseFrame();
    response.writeFloatLE(Number.NaN, 640);
    response.writeFloatLE(0, 644);
    child.stdout.write(response);
    expect(onFrame).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
