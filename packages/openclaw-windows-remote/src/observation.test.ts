import { fileURLToPath } from "node:url";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import windowsRemote from "./index.js";
import { elementsIn, focusedWindow, imagePoint, matchesCapturedDisplay, matchesObservedElement, readFrame, screenPoint, visibleDisplays } from "./observation.js";

const transport = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("./transport.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transport.js")>()),
  pair: async () => ({ expiresAt: Date.now() + 60_000 }),
  WindowsConnection: class {
    start = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
    call = transport.call;
  },
}));

function pngHeader(width: number, height: number): string {
  const header = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, 4, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header.toString("base64");
}

describe("Windows screenshot observations", () => {
  it("projects screenshot pixels into the physical desktop with independent scale and a negative origin", () => {
    const frame = readFrame(
      "Screenshot Original Size: (2560,1441)\nScreenshot Coordinate Scale: 2 — then add (-2560,-400), the screen coordinate\nScreenshot Region: (-2560,-400,0,1041)\nActive Desktop:\nDesktop",
      pngHeader(1280, 720),
    );
    expect(frame).toBeDefined();
    expect(screenPoint(frame!, { x: 639, y: 359 })).toEqual({ x: -1281, y: 319 });
    expect(imagePoint(frame!, { x: -1281, y: 319 })).toEqual({ x: 639, y: 359 });
    expect(screenPoint(frame!, { x: 1280, y: 0 })).toBeUndefined();
  });

  it("requires matching capture dimensions and separates tool metadata from desktop text", () => {
    const png = pngHeader(640, 480);
    expect(readFrame("Screenshot Size: (640,480)\nScreenshot Region: (3,4,643,485)", png)).toBeUndefined();
    expect(readFrame("Active Desktop:\nScreenshot Size: (640,480)", png)).toBeUndefined();
    expect(readFrame("Screenshot Size: (640,480)", png)?.origin).toEqual({ x: 0, y: 0 });
  });

  it("captures the element's point and the owning foreground window", () => {
    const snapshot = "Focused Window:\nName   Width   Handle\nMap    1024    42\n\nOpened Windows:\nMap\n\nUI Tree:\ndesktop\n    │   └── [#7] (-12,230) button \"Search\"  [action: click]";
    expect(elementsIn(snapshot).get(7)).toEqual({ x: -12, y: 230, description: 'button "Search"  [action: click]' });
    expect(focusedWindow(snapshot)).toBe("Name   Width   Handle\nMap    1024    42");
    const element = elementsIn(snapshot).get(7)!;
    const window = focusedWindow(snapshot);
    expect(matchesObservedElement(snapshot, window, 7, element)).toBe(true);
    expect(matchesObservedElement(snapshot.replace("-12,230", "-12,234"), window, 7, element)).toBe(false);
    expect(matchesObservedElement(snapshot.replace("1024    42", "1024    41"), window, 7, element)).toBe(false);
    expect(matchesObservedElement(snapshot.replace('"Search"', '"Cancel"'), window, 7, element)).toBe(false);
    expect(focusedWindow("Focused Window:\nNo active window found\nOpened Windows:\nMap")).toBeUndefined();
  });

  it("reports display indexes from the native metadata and ignores desktop text", () => {
    const listing = "Visible Displays: 0:DISPLAY1 (0,0,1920,1080) primary; 1:DISPLAY2 (-2560,-400,0,1040)";
    expect(visibleDisplays(listing)).toEqual([{ index: 0, primary: true }, { index: 1, primary: false }]);
    expect(visibleDisplays(`Active Desktop:\n${listing}`)).toEqual([]);
  });

  it("requires the reported selection and region to agree with the requested monitor", () => {
    const metadata = "Visible Displays: 0:DISPLAY1 (0,0,1920,1080) primary; 1:DISPLAY2 (-2560,-400,0,1040)\nSelected Displays: 1\nScreenshot Region: (-2560,-400,0,1040)";
    expect(matchesCapturedDisplay(metadata, 1)).toBe(true);
    expect(matchesCapturedDisplay(metadata, 0)).toBe(false);
    expect(matchesCapturedDisplay(metadata.replace("Region: (-2560,-400,0,1040)", "Region: (0,0,1920,1080)"), 1)).toBe(false);
    expect(matchesCapturedDisplay(`Active Desktop:\n${metadata}`, 1)).toBe(false);
  });

  it("reads only native element rows from the UI tree, even if window text contains similar rows", () => {
    const lines = [
      "Opened Windows:",
      '└── [#8] (1,2) button "Window data"',
      "UI Tree:",
      "desktop",
      '└── [#7] (-12,230) button "Search"  [action: click]',
      "",
      '└── [#9] (3,4) button "Extra data"',
    ];
    expect([...elementsIn(lines.join("\r\n")).keys()]).toEqual([7]);
    expect(elementsIn(lines[1]).size).toBe(0);
  });
});

it("rechecks an attended frame before issuing input to Windows", async () => {
  const device = "example_computer";
  const binding = {
    id: device, host: "192.168.50.20", port: 8000, profileId: "example_owner",
    channels: undefined as string[] | undefined,
  };
  const config = {
    plugins: {
      entries: {
        "device-management": {
          config: {
            providers: { "windows-remote": fileURLToPath(new URL("..", import.meta.url)) },
            devices: [{
              id: device, name: "Example computer", kind: "computer", siteId: "example_site",
              room: "Office", provider: "windows-remote", grants: { example_agent: ["read", "observe", "control"] },
            }],
          },
        },
        "windows-remote": {
          config: {
            devices: [binding],
          },
        },
      },
    },
  };
  const registered = new Map<string, AnyAgentTool>();
  const registerTool: OpenClawPluginApi["registerTool"] = (entry, options) => {
    if (typeof entry !== "function" || typeof options?.name !== "string") {
      throw new Error("Expected a named tool factory");
    }
    const context = {
      agentId: "example_agent", sessionKey: "example-session", messageChannel: "webchat",
      isPrivateRequesterProfile: (profile: string) => profile === "example_owner",
      assertInvocationCurrent: () => {},
    };
    expect(entry({ ...context, messageChannel: "matrix" })).toBeDefined();
    expect(entry({ ...context, messageChannel: undefined })).toBeUndefined();
    expect(entry({ ...context, isPrivateRequesterProfile: () => false })).toBeUndefined();
    binding.channels = ["matrix"];
    try {
      expect(entry(context)).toBeUndefined();
      expect(entry({ ...context, messageChannel: "matrix" })).toBeDefined();
    } finally {
      binding.channels = undefined;
    }
    const tool = entry(context);
    if (!tool || Array.isArray(tool)) throw new Error("Expected one authorized tool");
    registered.set(options.name, tool);
  };
  windowsRemote.register({
    config, registerTool, runtime: { config: { current: () => config } },
  } as unknown as OpenClawPluginApi);
  const status = registered.get("windows_remote_status")!;
  const observe = registered.get("windows_remote_observe")!;
  const control = registered.get("windows_remote_control")!;
  const snapshot = [
    "Screenshot Original Size: (2560,1440)",
    "Screenshot Coordinate Scale: 2 — then add (-2560,-400), the screen coordinate",
    "Screenshot Region: (-2560,-400,0,1040)",
    "Visible Displays: 0:DISPLAY1 (0,0,1920,1080) primary; 1:DISPLAY2 (-2560,-400,0,1040)",
    "Selected Displays: 1",
    "Active Desktop:",
    "Focused Window:",
    "Name   Width   Handle",
    "Map    1024    42",
    "",
    "Opened Windows:",
    "Map",
    "",
    "UI Tree:",
    "desktop",
    '    │   └── [#7] (-1280,320) button "Search"  [action: click]',
  ].join("\n");
  const png = pngHeader(1280, 720);
  const reply = (text: string, image = png) => ({
    content: [{ type: "text", text }, { type: "image", mimeType: "image/png", data: image }],
  });
  const capture = async () => {
    transport.call.mockResolvedValueOnce(reply(snapshot));
    const { content } = await observe.execute("observe", { device, mode: "frame", display: 1 });
    if (content[0]?.type !== "text") throw new Error("Expected frame metadata");
    return JSON.parse(content[0].text);
  };

  transport.call.mockResolvedValueOnce({ content: [{ type: "text", text: '{"state":"ai","enabled":true}' }] });
  await expect(status.execute("pair", { device, code: "123456789" })).resolves.toMatchObject({
    details: { ok: true, connected: true },
  });
  try {
    const first = await capture();
    expect(first.locations).toEqual([{ element: 7, pixel: { x: 640, y: 360 } }]);
    expect(first.display).toBe(1);
    expect(first.displays).toEqual([{ index: 0, primary: true }, { index: 1, primary: false }]);
    transport.call.mockResolvedValueOnce(reply(snapshot.replace("Map    1024    42", "Map    1024    41")));
    await expect(control.execute("stale-element", {
      device, action: "click", observationId: first.observationId, element: 7,
    })).resolves.toMatchObject({ details: { error: { code: "device_observation_stale" } } });
    expect(transport.call.mock.calls.map(([name]) => name)).toEqual(["ControlStatus", "Snapshot", "Snapshot"]);

    const second = await capture();
    const changedPng = Buffer.from(png, "base64");
    changedPng[25] ^= 1;
    transport.call.mockResolvedValueOnce(reply(snapshot, changedPng.toString("base64")));
    await expect(control.execute("stale-image", {
      device, action: "click", observationId: second.observationId, x: 640, y: 360,
    })).resolves.toMatchObject({ details: { error: { code: "device_observation_stale" } } });
    expect(transport.call.mock.calls.every(([name]) => name !== "Click")).toBe(true);

    const third = await capture();
    transport.call.mockResolvedValueOnce(reply(snapshot.replace("Map    1024    42", "Map    1024    41")));
    await expect(control.execute("image-with-stale-focus", {
      device, action: "click", observationId: third.observationId, x: 640, y: 360,
    })).resolves.toMatchObject({ details: { error: { code: "device_observation_stale" } } });
    expect(transport.call.mock.calls.every(([name]) => name !== "Click")).toBe(true);

    const wrongDisplay = await capture();
    transport.call.mockResolvedValueOnce(reply(snapshot.replace("Selected Displays: 1", "Selected Displays: 0")));
    await expect(control.execute("stale-display", {
      device, action: "click", observationId: wrongDisplay.observationId, element: 7,
    })).resolves.toMatchObject({ details: { error: { code: "device_observation_stale" } } });
    expect(transport.call.mock.calls.every(([name]) => name !== "Click")).toBe(true);

    const unchanged = await capture();
    transport.call.mockResolvedValueOnce(reply(snapshot));
    transport.call.mockResolvedValueOnce({ content: [{ type: "text", text: "Clicked" }] });
    await expect(control.execute("click", {
      device, action: "click", observationId: unchanged.observationId, x: 640, y: 360,
    })).resolves.toMatchObject({ details: { ok: true, action: "click" } });
    expect(transport.call).toHaveBeenLastCalledWith(
      "Click", { loc: [-1279, 321], button: "left", clicks: 1 }, expect.any(AbortSignal), expect.any(Function),
    );

    const elementFrame = await capture();
    transport.call.mockResolvedValueOnce(reply(snapshot));
    transport.call.mockResolvedValueOnce({ content: [{ type: "text", text: "Clicked" }] });
    await expect(control.execute("click-element", {
      device, action: "click", observationId: elementFrame.observationId, element: 7,
    })).resolves.toMatchObject({ details: { ok: true, action: "click" } });
    expect(transport.call).toHaveBeenLastCalledWith(
      "Click", { loc: [-1280, 320], button: "left", clicks: 1 }, expect.any(AbortSignal), expect.any(Function),
    );
    for (const [name, params] of transport.call.mock.calls) {
      if (name === "Snapshot") expect(params).toMatchObject({ display: [1] });
    }
    transport.call.mockResolvedValueOnce({ content: [{
      type: "text", text: "Error capturing desktop state: display 7 is inactive. Please try again.",
    }] });
    await expect(observe.execute("inactive-display", { device, display: 7 })).resolves.toMatchObject({
      details: { error: { code: "device_accessibility_unavailable" } },
    });
  } finally {
    await control.execute("disconnect", { device, action: "disconnect" });
  }
});
