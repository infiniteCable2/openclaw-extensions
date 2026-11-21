import { fileURLToPath } from "node:url";
import inventoryPlugin from "@infinitecable2/openclaw-device-management";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const gateway = vi.hoisted(() => ({ call: vi.fn(), routing: vi.fn(() => true) }));
const inventoryViews = vi.hoisted(
  () => new WeakMap<object, (view: (plugin: string, tool: string) => boolean) => void>(),
);
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  callGatewayTool: gateway.call,
  hasGatewayToolRoutingContext: gateway.routing,
}));
vi.mock("openclaw/plugin-sdk/tool-plugin", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  bindCallablePluginToolView(
    tool: object,
    update: (view: (plugin: string, tool: string) => boolean) => void,
  ) {
    inventoryViews.set(tool, update);
    return tool;
  },
}));

const chargerId = "garage_test";
const profileId = "private_fixture";
const nodeId = "a".repeat(64);
const command = "network.device.read";
const managerConfig = {
  providers: { goe: fileURLToPath(new URL("../", import.meta.url)) },
  devices: [
    {
      id: chargerId,
      name: "Garage charger",
      kind: "ev_charger",
      siteId: "test_site",
      room: "Garage",
      provider: "goe",
      grants: { fixture_agent: ["read"] },
    },
  ],
};

type ToolFactory = {
  contextVersion: 2;
  create: (context: OpenClawPluginToolContext<2>) => AnyAgentTool | undefined;
};

function fixture() {
  const goEConfig = { devices: [{ id: chargerId, nodeId, profileId, commands: [command] }] };
  const config = {
    plugins: {
      entries: {
        goe: { config: goEConfig },
        "device-management": { config: managerConfig },
      },
    },
  };
  const list = vi.fn(async () => ({
    nodes: [{ nodeId, connected: true, invocableCommands: [command] }],
  }));
  const assertInvocationCurrent = vi.fn();
  const context = {
    agentId: "fixture_agent",
    sessionKey: "agent:fixture_agent:matrix:test",
    runId: "fixture_run",
    assertInvocationCurrent,
    isPrivateRequesterProfile: (profile: string) => profile === profileId,
  } as OpenClawPluginToolContext<2>;
  const registerTool = vi.fn<(factory: unknown) => void>();
  const api = {
    registrationMode: "full",
    pluginConfig: goEConfig,
    registerTool,
    runtime: { config: { current: () => config }, nodes: { list } },
  };
  plugin.register!(api as unknown as OpenClawPluginApi);
  const factory = registerTool.mock.calls[0]![0] as ToolFactory;

  const registerInventory = vi.fn<(factory: unknown) => void>();
  const inventoryApi = { ...api, registerTool: registerInventory, pluginConfig: managerConfig };
  inventoryPlugin.register!(inventoryApi as unknown as OpenClawPluginApi);
  const inventoryFactory = registerInventory.mock.calls[0]![0] as ToolFactory;
  return { config, context, factory, inventoryFactory, list };
}

beforeEach(() => {
  gateway.call.mockReset();
  gateway.routing.mockReset().mockReturnValue(true);
});

describe("managed go-e charger", () => {
  it("resolves an inventory ID to exactly one authorized fixed read and projects only charger data", async () => {
    const f = fixture();
    const statusTool = f.factory.create(f.context)!;
    const inventoryTool = f.inventoryFactory.create(f.context)!;
    inventoryViews.get(inventoryTool)!(
      (plugin, tool) => plugin === "goe" && tool === statusTool.name,
    );
    const inventory = await inventoryTool.execute("inventory", { device: chargerId });
    expect(inventory.details).toMatchObject({
      ok: true,
      devices: [
        {
          id: chargerId,
          name: "Garage charger",
          kind: "ev_charger",
          capabilities: ["charging_status"],
          commands: [command],
          permissions: ["read"],
          tools: { status: "goe_status" },
        },
      ],
    });

    gateway.call.mockImplementation(async (_method, _options, _params, extra) => {
      extra.dispatchAuthority.assertCurrent();
      return {
        payload: {
          chargingState: "idle",
          chargingAllowed: false,
          allowedCurrentAmps: 0,
          address: "internal",
          serial: "fixture",
        },
      };
    });
    const result = await statusTool.execute("status", { device: chargerId });
    expect(result.details).toEqual({
      ok: true,
      device: chargerId,
      chargingState: "idle",
      chargingAllowed: false,
      allowedCurrentAmps: 0,
    });
    expect(gateway.call).toHaveBeenCalledTimes(1);
    expect(gateway.call).toHaveBeenCalledWith(
      "node.invoke",
      expect.anything(),
      expect.objectContaining({
        nodeId,
        command,
        params: {},
        sessionKey: f.context.sessionKey,
      }),
      expect.objectContaining({ requireAgentRuntimeIdentity: true }),
    );
  });

  it("keeps the assigned name visible and hides functions when the Node, turn or tool does not qualify", async () => {
    const f = fixture();
    const inventory = f.inventoryFactory.create(f.context)!;
    const read = (tool: AnyAgentTool) => tool.execute("inventory", { device: chargerId });
    const noFunctions = {
      ok: true,
      devices: [{ name: "Garage charger", capabilities: [], tools: {}, permissions: [] }],
    };
    expect((await read(inventory)).details).toMatchObject(noFunctions);
    inventoryViews.get(inventory)!((provider, tool) => provider === "goe" && tool === "goe_status");
    f.list.mockResolvedValueOnce({
      nodes: [{ nodeId, connected: false, invocableCommands: [command] }],
    });
    expect((await read(inventory)).details).toMatchObject(noFunctions);
    f.list.mockResolvedValueOnce({ nodes: [{ nodeId, connected: true, invocableCommands: [] }] });
    expect((await read(inventory)).details).toMatchObject(noFunctions);

    const otherProfile = f.inventoryFactory.create({
      ...f.context,
      isPrivateRequesterProfile: () => false,
    })!;
    inventoryViews.get(otherProfile)!(() => true);
    expect((await read(otherProfile)).details).toMatchObject(noFunctions);
    expect(f.inventoryFactory.create({ ...f.context, agentId: "other_agent" })).toBeUndefined();

    f.config.plugins.entries.goe.config.devices[0]!.commands = ["other.command"];
    expect((await read(inventory)).details).toMatchObject(noFunctions);
    expect(f.factory.create(f.context)).toBeUndefined();
    expect(gateway.call).not.toHaveBeenCalled();
  });

  it("rejects other personas, extra arguments, offline nodes and revoked authority before dispatch", async () => {
    const f = fixture();
    expect(f.factory.create({ ...f.context, agentId: "other_agent" })).toBeUndefined();
    expect(
      f.factory.create({ ...f.context, isPrivateRequesterProfile: () => false }),
    ).toBeUndefined();
    const tool = f.factory.create(f.context)!;
    const read = (params: unknown) => tool.execute("status", params);
    expect((await read({ device: chargerId, nodeId: "alternate" })).details).toMatchObject({
      error: { code: "invalid_request" },
    });
    f.list.mockResolvedValueOnce({ nodes: [] });
    expect((await read({ device: chargerId })).details).toMatchObject({
      error: { code: "device_offline" },
    });
    f.list.mockResolvedValueOnce({ nodes: [{ nodeId, connected: true, invocableCommands: [] }] });
    expect((await read({ device: chargerId })).details).toMatchObject({
      error: { code: "device_read_unavailable" },
    });
    expect(gateway.call).not.toHaveBeenCalled();

    let dispatched = false;
    gateway.call.mockImplementationOnce(async (_method, _options, _params, extra) => {
      f.config.plugins.entries.goe.config.devices[0]!.nodeId = "b".repeat(64);
      extra.dispatchAuthority.assertCurrent();
      dispatched = true;
    });
    expect((await read({ device: chargerId })).details).toMatchObject({
      error: { code: "device_denied" },
    });
    expect(dispatched).toBe(false);
  });
});
