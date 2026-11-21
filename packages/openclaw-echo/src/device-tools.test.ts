import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  OpenClawPluginApi,
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { decodeEchoCapture } from "./capture.js";
import { echoCommands, parseEchoAction } from "./contract.js";
import { registerEchoTools, type EchoToolContext as ToolContext } from "./device-tools.js";

const mocks = vi.hoisted(() => ({ saveMedia: vi.fn() }));
vi.mock("openclaw/plugin-sdk/media-store", () => ({ saveMediaBuffer: mocks.saveMedia }));

vi.mock("openclaw/plugin-sdk/tool-results", () => ({
  jsonResult: (details: unknown) => ({ content: [], details }),
  textResult: (text: string, details: unknown) => ({ content: [{ type: "text", text }], details }),
}));

const pairedId = "a".repeat(64);
const fixtureTool = "instance\u001fresult";
const agentId = "example_agent";
const profileId = "example_profile";
const deviceId = "example_speaker";
const sessionKey = "agent:example_agent:fixture-session";
type ToolFactory = {
  create: (
    context: ToolContext,
  ) => { execute: (id: string, raw: unknown) => Promise<{ details?: unknown }> } | null;
};

function fixture() {
  const allowed: string[] = ["echo.status.v1", "echo.alarm.set.v1", "echo.timer.start.v1"];
  const permissions: string[] = ["read", "control"];
  const config = {
    plugins: {
      entries: {
        echo: {
          config: {
            devices: [
              {
                id: deviceId,
                nodeId: pairedId,
                profileId,
                sessionKey,
                commands: allowed,
                channels: ["matrix"],
              },
            ],
          },
        },
        "device-management": {
          config: {
            providers: { echo: fileURLToPath(new URL("../", import.meta.url)) },
            devices: [
              {
                id: deviceId,
                name: "Example speaker",
                kind: "speaker",
                siteId: "example_site",
                room: "Example room",
                provider: "echo",
                grants: { [agentId]: permissions },
              },
            ],
          },
        },
      },
    },
  };
  const factories = new Map<string, ToolFactory>();
  const nativeInvoke = vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>(async () => ({
    ok: true,
    payload: { id: "fixture-alarm" },
  }));
  const deleteMedia = vi.fn(async () => {});
  const policies: OpenClawPluginNodeInvokePolicy[] = [];
  let family = "echo";
  const rpc = vi.fn(
    async (
      request: Pick<
        OpenClawPluginNodeInvokePolicyContext,
        "nodeId" | "command" | "params" | "idempotencyKey"
      >,
    ) => {
      const policy = policies.find((entry) => entry.commands.includes(request.command));
      const result = await policy!.handle({
        ...request,
        config: {},
        node: { nodeId: request.nodeId, deviceFamily: family },
        invokeNode: nativeInvoke,
      });
      if (!result.ok) throw new Error(result.code);
      return result;
    },
  );
  registerEchoTools({
    runtime: {
      config: { current: () => config },
      nodes: { invoke: rpc },
      channel: { media: { deleteMediaBuffer: deleteMedia } },
    },
    registerNodeInvokePolicy: (entry: OpenClawPluginNodeInvokePolicy) => {
      policies.push(entry);
    },
    registerTool: (factory: ToolFactory, options: { name: string }) => {
      factories.set(options.name, factory);
    },
  } as unknown as OpenClawPluginApi);
  const context: ToolContext = {
    agentId,
    runId: "fixture-run",
    sessionKey,
    messageChannel: "matrix",
    assertInvocationCurrent: vi.fn(),
    isPrivateRequesterProfile: (id) => id === profileId,
  };
  return {
    context,
    allowed,
    permissions,
    nativeInvoke,
    deleteMedia,
    rpc,
    policies,
    policy: policies[0],
    changeFamily: (next: string) => {
      family = next;
    },
    tool: (name: string, overrides: Partial<ToolContext> = {}) =>
      factories.get(name)!.create({ ...context, ...overrides }),
  };
}

describe("managed Echo node tools", () => {
  it("keeps the configured command vocabulary in sync with the native policy", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    );
    const commands = manifest.configSchema.properties.devices.items.properties.commands.items.enum;
    expect(commands.toSorted()).toEqual(echoCommands.toSorted());
    const { policies } = fixture();
    expect(policies.flatMap((entry) => entry.commands).toSorted()).toEqual(echoCommands.toSorted());
    expect(policies[1]).toMatchObject({
      dangerous: true,
      commands: ["echo.capture.photo.v1", "echo.capture.audio.v1"],
    });
    expect(policies[1].defaultPlatforms).toBeUndefined();
  });

  it("uses the known paired node and only the exact private tool arguments", async () => {
    const f = fixture();
    const input = { device: deviceId, action: "alarm_set", date: "2030-06-02", time: "05:00" };
    const tool = f.tool("echo_control")!;
    const result = await tool.execute(fixtureTool, input);
    await tool.execute(fixtureTool, input);
    expect(result.details).toEqual({ ok: true, device: deviceId, result: { id: "fixture-alarm" } });
    expect(f.rpc).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: pairedId, command: "echo.alarm.set.v1" }),
    );
    expect(f.nativeInvoke).toHaveBeenCalledWith({
      params: { date: "2030-06-02", time: "05:00" },
      idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/u),
      timeoutMs: 5000,
    });
    expect(f.rpc.mock.calls[0][0].idempotencyKey).toEqual(f.rpc.mock.calls[1][0].idempotencyKey);
  });

  it("denies the raw node.invoke path even for a connected, declared device", async () => {
    const f = fixture();
    await expect(
      f.policy.handle({
        config: {},
        nodeId: pairedId,
        command: "echo.status.v1",
        params: {},
        node: { nodeId: pairedId, deviceFamily: "echo" },
        invokeNode: f.nativeInvoke,
      }),
    ).resolves.toMatchObject({ ok: false, code: "NOT_AUTHORIZED" });
    expect(f.nativeInvoke).not.toHaveBeenCalled();
  });

  it("requires the configured agent, private requester, channel and conversation", () => {
    const f = fixture();
    expect(f.tool("echo_status", { agentId: "other_agent" })).toBeNull();
    expect(f.tool("echo_status", { messageChannel: "gateway" })).toBeNull();
    expect(f.tool("echo_status", { sessionKey: "agent:example_agent:other-session" })).toBeNull();
    expect(f.tool("echo_status", { sessionKey: undefined })).toBeNull();
    expect(f.tool("echo_status", { isPrivateRequesterProfile: () => false })).toBeNull();
    f.permissions.splice(1);
    expect(f.tool("echo_control")).toBeNull();
  });

  it("requires separate approvals for Bluetooth pairing, output and volume", async () => {
    const f = fixture();
    f.allowed.push("echo.bluetooth.phone.pair.v1", "echo.audio.volume.set.v1");
    const control = f.tool("echo_control")!;
    await expect(
      control.execute("call-1", { device: deviceId, action: "bluetooth_output_scan" }),
    ).resolves.toMatchObject({ details: { ok: false, code: "INVALID_REQUEST" } });
    await expect(
      control.execute("call-2", { device: deviceId, action: "audio_volume_set", step: 31 }),
    ).resolves.toMatchObject({ details: { ok: false, code: "INVALID_REQUEST" } });
    await control.execute("call-3", { device: deviceId, action: "bluetooth_phone_pair" });
    await control.execute("call-4", { device: deviceId, action: "audio_volume_set", step: 0 });
    expect(f.rpc.mock.calls.map(([call]) => [call.command, call.params])).toEqual([
      ["echo.bluetooth.phone.pair.v1", {}],
      ["echo.audio.volume.set.v1", { step: 0 }],
    ]);
  });

  it("matches the Show calendar and notification input limits", () => {
    expect(
      parseEchoAction({ device: deviceId, action: "display_calendar", date: "2030-02-30" }),
    ).toBeUndefined();
    expect(
      parseEchoAction({
        device: deviceId,
        action: "display_calendar",
        date: "2030-02-28",
        agenda: true,
      }),
    ).toBeUndefined();
    expect(
      parseEchoAction({ device: deviceId, action: "display_notify", text: "ä".repeat(121) }),
    ).toBeUndefined();
    expect(
      parseEchoAction({
        device: deviceId,
        action: "display_notify",
        text: "Guten Morgen",
        seconds: 5,
      }),
    ).toMatchObject({ args: { text: "Guten Morgen", seconds: 5 } });
  });

  it("keeps capture separate from read, control and automatic output", async () => {
    const f = fixture();
    f.allowed.push("echo.capture.photo.v1");
    expect(f.tool("echo_capture")).toBeNull();
    f.permissions.push("observe");
    const capture = f.tool("echo_capture")!;
    await expect(
      capture.execute("call-1", { device: deviceId, action: "capture_audio", durationSeconds: 1 }),
    ).resolves.toMatchObject({ details: { ok: false, code: "INVALID_REQUEST" } });
    mocks.saveMedia.mockReset();
    mocks.saveMedia.mockImplementation(
      async (_bytes, _mime, _dir, _limit, _name, _hint, options) => {
        options.assertCommitAllowed();
        return { path: "/private/example.jpg", id: "example.jpg", size: 6 };
      },
    );
    f.nativeInvoke.mockResolvedValue({
      ok: true,
      payload: { mime: "image/jpeg", dataBase64: "/9j/Av/Z" },
    });
    await expect(
      capture.execute("call-2", { device: deviceId, action: "capture_photo" }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "FILE:/private/example.jpg" }],
      details: { ok: true, media: { outbound: false } },
    });
    f.nativeInvoke.mockResolvedValue({
      ok: true,
      payload: { mime: "image/jpeg", dataBase64: "dGVzdA==" },
    });
    await expect(
      capture.execute("call-3", { device: deviceId, action: "capture_photo" }),
    ).resolves.toMatchObject({ details: { ok: false } });
    expect(mocks.saveMedia).toHaveBeenCalledTimes(1);
    expect(f.nativeInvoke.mock.calls[0][0]).toMatchObject({ timeoutMs: 15000 });
  });

  it("deletes a capture that loses its authorization while being saved", async () => {
    const f = fixture();
    f.permissions.push("observe");
    f.allowed.push("echo.capture.photo.v1");
    f.nativeInvoke.mockResolvedValue({
      ok: true,
      payload: { mime: "image/jpeg", dataBase64: "/9j/Av/Z" },
    });
    mocks.saveMedia.mockImplementationOnce(async () => {
      f.allowed.pop();
      return { path: "/private/example.jpg", id: "example.jpg", size: 6 };
    });
    await expect(
      f.tool("echo_capture")!.execute("call", { device: deviceId, action: "capture_photo" }),
    ).resolves.toMatchObject({ details: { ok: false } });
    expect(f.deleteMedia).toHaveBeenCalledWith("example.jpg", "echo-capture");
  });

  it("checks PCM recording headers and the exact authorized duration", () => {
    const bytes = Buffer.alloc(44 + 32_000);
    bytes.write("RIFF", 0);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(16_000, 24);
    bytes.writeUInt32LE(32_000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36);
    bytes.writeUInt32LE(bytes.length - 44, 40);
    const capture = { mime: "audio/wav", dataBase64: bytes.toString("base64") };
    expect(decodeEchoCapture("capture_audio", capture, 1).bytes.equals(bytes)).toBe(true);
    expect(() => decodeEchoCapture("capture_audio", capture, 2)).toThrow(
      "Invalid Echo capture bytes",
    );
    bytes.writeUInt16LE(2, 22);
    expect(() =>
      decodeEchoCapture("capture_audio", { ...capture, dataBase64: bytes.toString("base64") }, 1),
    ).toThrow("Invalid Echo capture bytes");
  });

  it("rejects a revoked command or an unrelated paired device family", async () => {
    const f = fixture();
    const tool = f.tool("echo_control")!;
    f.allowed.splice(2);
    const timer = { device: deviceId, action: "timer_start", durationSeconds: 60 };
    expect((await tool.execute(fixtureTool, timer)).details).toMatchObject({
      ok: false,
      code: "NOT_AUTHORIZED",
    });
    f.changeFamily("phone");
    const alarm = { device: deviceId, action: "alarm_set", date: "2030-06-02", time: "05:00" };
    expect((await tool.execute(fixtureTool, alarm)).details).toMatchObject({ ok: false });
    expect(f.nativeInvoke).not.toHaveBeenCalled();
  });

  it("does not disclose a reply after the private requester grant is revoked", async () => {
    const f = fixture();
    f.nativeInvoke.mockImplementation(async () => {
      f.permissions.shift();
      return { ok: true, payload: { hidden: true } };
    });
    const result = await f
      .tool("echo_status")!
      .execute(fixtureTool, { device: deviceId, action: "status" });
    expect(result.details).toMatchObject({ ok: false, code: "NOT_AUTHORIZED" });
    expect(result.details).not.toHaveProperty("result");
  });

  it("rejects bulk timers, impossible alarm dates, extras and out-of-range values", () => {
    for (const args of [
      { action: "timer_cancel", id: "all" },
      { action: "timer_cancel", id: "ALL" },
      { action: "timer_adjust", id: "local:a", deltaSeconds: 0 },
      { action: "timer_start", durationSeconds: 86401 },
      { action: "alarm_set", date: "2030-02-30", time: "05:00" },
      { action: "status", nodeId: pairedId },
      { action: "alarm_delete", id: "ok", nodeId: pairedId },
    ]) {
      expect(parseEchoAction({ device: deviceId, ...args })).toBeUndefined();
    }
  });
});
