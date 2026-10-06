import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTvConfig } from "./config.js";
import { createTools } from "./tools.js";

const mocks = vi.hoisted(() => ({
  callBridge: vi.fn(),
  optimizeImageToJpeg: vi.fn(),
}));
vi.mock("./bridge.js", () => ({ callBridge: mocks.callBridge }));
vi.mock("openclaw/plugin-sdk/web-media", () => ({ optimizeImageToJpeg: mocks.optimizeImageToJpeg }));

const directories: string[] = [];
afterEach(async () => {
  mocks.callBridge.mockReset();
  mocks.optimizeImageToJpeg.mockReset();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "google-tv-test-"));
  directories.push(directory);
  const path = join(directory, "tv-shot-test.png");
  const png = Buffer.from("89504e470d0a1a0a010203", "hex");
  await writeFile(path, png);
  const config = parseTvConfig({
    allowedAgentIds: ["example_owner"], pythonPath: "/usr/bin/python3", screenshotDirectory: directory,
    devices: [{ id: "tv", name: "TV", host: "192.168.1.106", remoteCertPath: "/cert", remoteKeyPath: "/key" }],
  });
  const tool = createTools(config).find((candidate) => candidate.name === "google_tv_observe") as AnyAgentTool;
  mocks.callBridge.mockResolvedValue({ ok: true, path, bytes: png.length });
  return { tool, path, png };
}

describe("Google TV screenshot delivery", () => {
  it("returns only a temporary original-file path by default", async () => {
    const { tool, path, png } = await setup();
    const response = await tool.execute("observe-1", { device: "tv", mode: "screenshot" });
    expect(response.details).toMatchObject({ ok: true, delivery: "file", path, bytes: png.length });
    expect(response.content.some((item) => item.type === "image")).toBe(false);
    expect(await readFile(path)).toEqual(png);
    expect(mocks.optimizeImageToJpeg).not.toHaveBeenCalled();
  });

  it("returns a bounded preview and original path in both mode", async () => {
    const { tool, path } = await setup();
    const preview = Buffer.from("small-jpeg");
    mocks.optimizeImageToJpeg.mockResolvedValue({ buffer: preview, optimizedSize: preview.length });
    const response = await tool.execute("observe-2", { device: "tv", mode: "screenshot", delivery: "both" });
    const first = response.content[0];
    expect(first?.type).toBe("text");
    expect(JSON.parse((first as { text: string }).text)).toMatchObject({ delivery: "both", path, nextTool: "view_image" });
    expect(response.content[1]).toEqual({ type: "image", data: preview.toString("base64"), mimeType: "image/jpeg" });
    expect(mocks.optimizeImageToJpeg).toHaveBeenCalledWith(expect.any(Buffer), 350_000);
  });

  it("rejects a bridge screenshot path outside the private directory", async () => {
    const { tool } = await setup();
    mocks.callBridge.mockResolvedValue({ ok: true, path: "/tmp/other.png", bytes: 10 });
    const response = await tool.execute("observe-3", { device: "tv", mode: "screenshot" });
    expect(response.details).toMatchObject({ ok: false, error: { code: "invalid_bridge_result" } });
  });
});
