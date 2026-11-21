import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canInspectDevicePermissions, projectInventoryDevice } from "./inventory.js";
import { parseDeviceRegistry } from "./policy.js";

const agentId = "example_owner";
const profileId = "example_profile";
const sessionKey = "agent:example_owner:example-talk";
const timers = ["echo.timer.list.v1", "echo.timer.start.v1"];
const device = parseDeviceRegistry({
  providers: { echo: fileURLToPath(new URL("../../openclaw-echo/", import.meta.url)) },
  devices: [
    {
      id: "example_show",
      name: "Example Show",
      kind: "speaker",
      siteId: "site",
      room: "Room",
      provider: "echo",
      grants: { [agentId]: ["read", "control"] },
    },
  ],
}).get("example_show")!;
const context = {
  agentId,
  sessionKey,
  messageChannel: "webchat",
  isPrivateRequesterProfile: (profile: string) => profile === profileId,
};
const params = {
  device,
  context,
  diagnostic: false,
  providerConfig: {
    devices: [
      {
        id: device.id,
        profileId,
        sessionKey,
        channels: ["webchat"],
        nodeId: "node",
        commands: timers,
      },
    ],
  },
  isToolCallable: (_provider: string, tool: string) =>
    tool === "echo_status" || tool === "echo_control",
  nodes: new Map([["node", { nodeId: "node", connected: true, invocableCommands: timers }]]),
};

describe("effective device inventory", () => {
  it("intersects the callable tools, private binding and native command grant", () => {
    expect(projectInventoryDevice(params)).toMatchObject({
      capabilities: ["timers"],
      commands: timers,
      tools: { status: "echo_status", control: "echo_control" },
    });
    const readOnly = {
      ...params,
      isToolCallable: (_owner: string, name: string) => name === "echo_status",
    };
    expect(projectInventoryDevice(readOnly)).toMatchObject({
      commands: [timers[0]],
      permissions: ["read"],
    });
    const foreign = { ...params, context: { ...context, messageChannel: "matrix" } };
    expect(projectInventoryDevice(foreign)).toMatchObject({ capabilities: [], tools: {} });
    const revoked = {
      ...params,
      nodes: new Map([["node", { nodeId: "node", connected: true, invocableCommands: [] }]]),
    };
    expect(projectInventoryDevice(revoked)).toMatchObject({ capabilities: [], tools: {} });
  });

  it("requires both a diagnostic grant and the private persona, without exposing forbidden commands as usable", () => {
    const config = { diagnosticViewers: [{ agentId, profileId }] };
    expect(canInspectDevicePermissions(config, context)).toBe(true);
    expect(canInspectDevicePermissions(config, { ...context, agentId: "another_agent" })).toBe(
      false,
    );
    expect(
      canInspectDevicePermissions(config, {
        ...context,
        backgroundRun: { sourceSessionKey: sessionKey },
      }),
    ).toBe(false);
    expect(
      canInspectDevicePermissions(config, { ...context, isPrivateRequesterProfile: () => false }),
    ).toBe(false);
    expect(
      projectInventoryDevice({ ...params, diagnostic: true }).capabilityDiagnostics,
    ).toContainEqual(
      expect.objectContaining({
        id: "capture",
        available: false,
        supportedCommands: ["echo.capture.photo.v1", "echo.capture.audio.v1"],
      }),
    );
    expect(projectInventoryDevice(params)).not.toHaveProperty("capabilityDiagnostics");
  });
});
