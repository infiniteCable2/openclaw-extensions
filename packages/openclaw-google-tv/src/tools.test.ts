import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTvConfig } from "./config.js";
import { createTools } from "./tools.js";
import { parseDeviceRegistry } from "@infinitecable2/openclaw-device-management/policy";

const mocks = vi.hoisted(() => ({
  callBridge: vi.fn(),
  optimizeImageToJpeg: vi.fn(),
}));
vi.mock("./bridge.js", () => ({ callBridge: mocks.callBridge }));
vi.mock("openclaw/plugin-sdk/web-media", () => ({ optimizeImageToJpeg: mocks.optimizeImageToJpeg }));

const directories: string[] = [];
const providers = { "google-tv": fileURLToPath(new URL("../", import.meta.url)) };
afterEach(async () => {
  mocks.callBridge.mockReset();
  mocks.optimizeImageToJpeg.mockReset();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "google-tv-test-"));
  directories.push(directory);
  const scopedDirectory = join(directory, "agents", "steffen", "tv");
  await mkdir(scopedDirectory, { recursive: true });
  const path = join(scopedDirectory, "tv-shot-test.png");
  const png = Buffer.from("89504e470d0a1a0a010203", "hex");
  await writeFile(path, png);
  const config = parseTvConfig({
    pythonPath: "/usr/bin/python3", screenshotDirectory: directory,
    devices: [{ id: "tv", host: "192.168.1.106", remoteCertPath: "/cert", remoteKeyPath: "/key" }],
  });
  const registry = parseDeviceRegistry({ providers, devices: [{ id: "tv", name: "TV", kind: "television", siteId: "astrid", room: "Wohnzimmer", provider: "google-tv", grants: { steffen: ["read", "control", "observe", "guide"], astrid: ["read", "control", "observe", "guide"] } }] });
  const tool = createTools(config, registry, "steffen").find((candidate) => candidate.name === "google_tv_observe") as AnyAgentTool;
  mocks.callBridge.mockResolvedValue({ ok: true, path, bytes: png.length });
  return { tool, path, png, config, registry };
}

describe("Google TV screenshot delivery", () => {
  it("blocks direct control after a central grant is revoked", async () => {
    const { tool } = await setup();
    const config = parseTvConfig({ pythonPath: "/usr/bin/python3", devices: [{ id: "tv", host: "192.168.1.106", remoteCertPath: "/cert", remoteKeyPath: "/key" }] });
    const initial = parseDeviceRegistry({ providers, devices: [{ id: "tv", name: "TV", kind: "television", siteId: "astrid", room: "Wohnzimmer", provider: "google-tv", grants: { steffen: ["read", "control"] } }] });
    const revoked = parseDeviceRegistry({ providers, devices: [{ id: "tv", name: "TV", kind: "television", siteId: "astrid", room: "Wohnzimmer", provider: "google-tv", grants: { astrid: ["read", "control"] } }] });
    const control = createTools(config, initial, "steffen", () => revoked).find((candidate) => candidate.name === "google_tv_control")!;
    const response = await control.execute("revoked", { device: "tv", action: "power_on" });
    expect(response.details).toMatchObject({ ok: false, error: { code: "device_denied" } });
    expect(mocks.callBridge).not.toHaveBeenCalled();
    expect(tool.name).toBe("google_tv_observe");
  });
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

  it("keeps captures per requesting agent while retaining the same device pairing", async () => {
    const { tool, path, config, registry, png } = await setup();
    const astrid = createTools(config, registry, "astrid").find((candidate) => candidate.name === "google_tv_observe")!;
    const rejected = await astrid.execute("wrong-owner", { device: "tv", mode: "screenshot" });
    expect(rejected.details).toMatchObject({ ok: false, error: { code: "invalid_bridge_result" } });
    mocks.callBridge.mockImplementation(async (scopedConfig) => {
      await mkdir(scopedConfig.screenshotDirectory, { recursive: true });
      const capture = join(scopedConfig.screenshotDirectory, "tv-shot-own.png");
      await writeFile(capture, png);
      return { ok: true, path: capture, bytes: png.length };
    });
    const own = await astrid.execute("astrid", { device: "tv", mode: "screenshot" });
    const steffen = await tool.execute("steffen", { device: "tv", mode: "screenshot" });
    expect(own.details).toMatchObject({ path: join(config.screenshotDirectory, "agents", "astrid", "tv", "tv-shot-own.png") });
    expect(steffen.details).toMatchObject({ path: join(config.screenshotDirectory, "agents", "steffen", "tv", "tv-shot-own.png") });
    expect(await readFile(path)).toEqual(png);
    for (const [, device] of mocks.callBridge.mock.calls) {
      expect(device).toMatchObject({ id: "tv", remoteCertPath: "/cert", remoteKeyPath: "/key" });
    }
  });

  it("serializes two agents on the same TV and does not execute an aborted queued command", async () => {
    const { config, registry } = await setup();
    const steffen = createTools(config, registry, "steffen").find((candidate) => candidate.name === "google_tv_control")!;
    const astrid = createTools(config, registry, "astrid").find((candidate) => candidate.name === "google_tv_control")!;
    let release!: (value: Record<string, unknown>) => void;
    mocks.callBridge.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = steffen.execute("first", { device: "tv", action: "key", key: "home" });
    await vi.waitFor(() => expect(mocks.callBridge).toHaveBeenCalledTimes(1));
    const abort = new AbortController();
    const second = astrid.execute("second", { device: "tv", action: "key", key: "back" }, abort.signal);
    await Promise.resolve();
    expect(mocks.callBridge).toHaveBeenCalledTimes(1);
    abort.abort();
    release({ ok: true });
    await first;
    expect((await second).details).toMatchObject({ result: { ok: false, code: "cancelled" } });
    expect(mocks.callBridge).toHaveBeenCalledTimes(1);
  });
});
