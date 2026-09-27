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
    const frames: Buffer[] = [];
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
    child.stdout.write(Buffer.from("M1"));
    await connected;
    const frame = Buffer.alloc(640, 17);
    child.stdin.on("data", (input) => child.stdout.write(input));
    processor.send(Buffer.concat([frame, frame]));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(frame);
    expect(frames[1]).toEqual(frame);
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
    child.stdout.write(Buffer.from("APM1"));
    await connected;
    processor.send(Buffer.alloc(640 * 101));
    expect(onError).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
