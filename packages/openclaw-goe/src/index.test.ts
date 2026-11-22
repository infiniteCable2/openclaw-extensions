import { fileURLToPath } from "node:url";
import { mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import inventoryPlugin from "@infinitecable2/openclaw-device-management";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { reportSessions } from "./history.js";

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
const v2Command = "network.device.read.v2";
const stopCommand = "network.device.stop.v1";
const historyCommand = "network.device.history.v1";
type FixtureBinding = {
  id: string;
  nodeId: string;
  profileId: string;
  commands: string[];
  deviceKey?: string;
  historyReport?: string;
};
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
  const goEConfig: { devices: FixtureBinding[] } = {
    devices: [{ id: chargerId, nodeId, profileId, commands: [command] }],
  };
  const config = {
    plugins: {
      entries: {
        goe: { config: goEConfig },
        "device-management": { config: structuredClone(managerConfig) },
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
  const stopFactory = registerTool.mock.calls[1]![0] as ToolFactory;

  const registerInventory = vi.fn<(factory: unknown) => void>();
  const inventoryApi = { ...api, registerTool: registerInventory, pluginConfig: managerConfig };
  inventoryPlugin.register!(inventoryApi as unknown as OpenClawPluginApi);
  const inventoryFactory = registerInventory.mock.calls[0]![0] as ToolFactory;
  return { config, context, factory, stopFactory, inventoryFactory, list };
}

function sharedNodeFixture() {
  const f = fixture();
  const secondId = "second_charger";
  const firstKey = "012345";
  const secondKey = "678901";
  const devices = f.config.plugins.entries.goe.config.devices;
  devices[0] = { id: chargerId, nodeId, profileId, commands: [v2Command], deviceKey: firstKey };
  devices.push({ id: secondId, nodeId, profileId, commands: [v2Command], deviceKey: secondKey });
  f.config.plugins.entries["device-management"].config.devices.push({
    ...managerConfig.devices[0]!,
    id: secondId,
    name: "Second charger",
  });
  f.list.mockResolvedValue({
    nodes: [{ nodeId, connected: true, invocableCommands: [v2Command] }],
  });
  return { ...f, secondId, firstKey, secondKey, devices };
}

beforeEach(() => {
  gateway.call.mockReset();
  gateway.routing.mockReset().mockReturnValue(true);
});

describe("managed go-e charger", () => {
  it("returns the latest completed sessions from the addressed node as structured data", async () => {
    const f = sharedNodeFixture();
    const firstEnd = Date.UTC(2026, 10, 6, 22);
    const lastEnd = Date.UTC(2026, 10, 13, 21);
    f.list.mockResolvedValue({
      nodes: [{ nodeId, connected: true, invocableCommands: [v2Command, historyCommand] }],
    });
    gateway.call.mockResolvedValue({
      payload: {
        deviceKey: f.firstKey,
        sessions: [
          {
            startUnix: firstEnd - 7200000,
            endUnix: firstEnd,
            energy: 14.1,
            seconds_charged: "01:35:08",
            still_running: false,
          },
          {
            startUnix: lastEnd - 7200000,
            endUnix: lastEnd,
            energy: 17.75,
            seconds_charged: "01:35:08",
            still_running: false,
            link: "fixture-secret",
          },
          {
            startUnix: lastEnd,
            endUnix: lastEnd + 7200000,
            energy: 1,
            seconds_charged: "00:10:00",
            still_running: true,
          },
        ],
      },
    });
    const tool = f.factory.create(f.context)!;
    const result = await tool.execute("history", {
      device: chargerId,
      section: "history",
      limit: 1,
    });
    expect(result.details).toEqual({
      ok: true,
      device: chargerId,
      section: "history",
      source: "go-e",
      sessions: [
        {
          startedAt: new Date(lastEnd - 7200000).toISOString(),
          endedAt: new Date(lastEnd).toISOString(),
          energyKwh: 17.75,
          activeChargingSeconds: 5708,
        },
      ],
    });
    expect(gateway.call.mock.calls[0]?.[2]).toMatchObject({
      command: historyCommand,
      params: { plugin: "go-e", deviceKey: f.firstKey, limit: 1 },
    });
  });

  it("reads the German go-e export without following its private links", () => {
    const start = Date.UTC(2026, 9, 25, 0, 50) / 1000;
    const report = [
      'Session ID,Charger-SN,Charger Name,Name des Chips,Chip ID,Energie,Start,Ende,Gesamtzeit,Ladezeit,Maximale Leistung,Maximaler Strom,"Zähler\ndifferenz",Zählerstart,Zählerende,WLAN-SSID,Link',
      `${start},012345,Example charger,Example card,,5.12,25.10.2026 02:50:00,25.10.2026 02:20:00,30min,24min 36S,10.749,15.700,5.12,120,125.12,Example Wi-Fi,https://example.invalid/fixture`,
    ].join("\r\n");
    expect(reportSessions(report, "012345", 3)).toEqual([
      {
        startedAt: "2026-10-25T00:50:00.000Z",
        endedAt: "2026-10-25T01:20:00.000Z",
        energyKwh: 5.12,
        activeChargingSeconds: 1476,
      },
    ]);
    expect(reportSessions(report, "012346", 3)).toBeUndefined();
    expect(reportSessions(report.replace("02:50:00", "02:57:00"), "012345", 3)).toEqual([]);
  });

  it("groups a verified telemetry snapshot and keeps only the requested fields", async () => {
    const f = sharedNodeFixture();
    const tool = f.factory.create(f.context)!;
    gateway.call.mockResolvedValue({
      payload: {
        deviceKey: f.firstKey,
        chargingState: "charging",
        chargingAllowed: true,
        telemetry: {
          nrg: [230, 232, 234, 0, 16, 0, 13.1, 3680, 0, 3065, 0, 6745, 100, 0, 99],
          psm: 2,
          cus: 3,
          wh: 9012.5,
          cdi: { type: 1, value: 180_000 },
          fhz: 50.02,
          typ: "go-eCharger",
          fwv: "059.4",
          dll: "https://example.org/private-export",
        },
      },
    });
    const supplied = { device: chargerId };
    expect(
      (await tool.execute("charging", { ...supplied, section: "charging" })).details,
    ).toMatchObject({
      section: "charging",
      powerKw: 6.745,
      phasesDrawingCurrent: ["L1", "L3"],
      phaseMode: "threePhase",
      cableLockState: "locked",
      energySincePluggedInKwh: 9.0125,
      chargingDurationSeconds: 180,
    });
    expect((await tool.execute("grid", { ...supplied, section: "grid" })).details).toMatchObject({
      section: "grid",
      voltageVByPhase: { L1: 230, L2: 232, L3: 234 },
      frequencyHz: 50.02,
    });
    const device = (await tool.execute("device", { ...supplied, section: "device" })).details;
    expect(device).toEqual({
      ok: true,
      device: chargerId,
      section: "device",
      reachable: true,
      model: "go-eCharger",
      firmwareVersion: "059.4",
    });
    expect(gateway.call.mock.calls.map((call) => call[2])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          command: v2Command,
          params: { plugin: "go-e", deviceKey: f.firstKey },
        }),
      ]),
    );
  });

  it("reads only completed sessions for the assigned charger from an operator-selected export", async () => {
    const f = sharedNodeFixture();
    const folder = await mkdtemp(join(tmpdir(), "go-e-report-"));
    const path = join(folder, "history.csv");
    try {
      f.devices[0]!.historyReport = path;
      await writeFile(
        path,
        [
          "Charger serial number;Session start time;Session stop time;Total energy consumed (kWh);Total active charging time (s);Private card name",
          '012345;2026-01-01T12:00:00Z;2026-01-01T13:00:00Z;8,52;2520;"a; name"',
          "678901;2026-01-03T12:00:00Z;2026-01-03T13:00:00Z;9;1800;Other charger",
          "012345;2026-01-02T12:00:00Z;2026-01-02T14:00:00Z;10,2;3600;Private card",
          "012345;2026-01-04T12:00:00Z;;0;;Ongoing",
        ].join("\r\n"),
      );
      const result = await f.factory
        .create(f.context)!
        .execute("history", { device: chargerId, section: "history", limit: 1 });
      expect(result.details).toMatchObject({
        ok: true,
        device: chargerId,
        source: "configuredExport",
        sessions: [
          {
            startedAt: "2026-01-02T12:00:00.000Z",
            endedAt: "2026-01-02T14:00:00.000Z",
            energyKwh: 10.2,
            activeChargingSeconds: 3600,
          },
        ],
      });
      expect(JSON.stringify(result.details)).not.toMatch(
        /Private card|Other charger|012345|history\.csv/,
      );
      expect(gateway.call).not.toHaveBeenCalled();
    } finally {
      await rm(path, { force: true });
      await rmdir(folder);
    }
  });

  it("requires a current control grant and a confirmed addressed stop result", async () => {
    const f = sharedNodeFixture();
    expect(f.stopFactory.create(f.context)).toBeUndefined();
    f.config.plugins.entries["device-management"].config.devices[0]!.grants.fixture_agent.push(
      "control",
    );
    const tool = f.stopFactory.create(f.context)!;
    expect((await tool.execute("absent", { device: chargerId })).details).toMatchObject({
      error: { code: "device_stop_unavailable" },
    });
    expect(gateway.call).not.toHaveBeenCalled();
    f.list.mockResolvedValue({
      nodes: [{ nodeId, connected: true, invocableCommands: [v2Command, stopCommand] }],
    });
    gateway.call.mockResolvedValue({ payload: { deviceKey: f.secondKey, stopState: "stopped" } });
    expect((await tool.execute("wrong-key", { device: chargerId })).details).toMatchObject({
      error: { code: "device_stop_unconfirmed" },
    });
    gateway.call.mockResolvedValue({
      payload: { deviceKey: f.firstKey, stopState: "alreadyStopped" },
    });
    expect((await tool.execute("approved", { device: chargerId })).details).toEqual({
      ok: true,
      device: chargerId,
      stopState: "alreadyStopped",
    });
    expect(gateway.call.mock.calls.at(-1)?.[2]).toMatchObject({
      command: stopCommand,
      params: { plugin: "go-e", deviceKey: f.firstKey },
    });
  });
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
      error: { code: "device_command_unavailable" },
    });
    expect(gateway.call).not.toHaveBeenCalled();

    let dispatched = false;
    gateway.call.mockImplementationOnce(async (_method, _options, _params, extra) => {
      f.config.plugins.entries.goe.config.devices[0]!.nodeId = "b".repeat(64);
      extra.dispatchAuthority.assertCurrent();
      dispatched = true;
    });
    expect((await read({ device: chargerId })).details).toMatchObject({
      error: { code: "device_not_assigned" },
    });
    expect(dispatched).toBe(false);
  });

  it("selects one locally assigned charger without revealing another profile's binding", async () => {
    const f = fixture();
    const secondId = "other_charger";
    const secondNode = "b".repeat(64);
    const second = {
      ...managerConfig.devices[0]!,
      id: secondId,
    };
    f.config.plugins.entries["device-management"].config.devices.push(second);
    f.config.plugins.entries.goe.config.devices.push({
      id: secondId,
      nodeId: secondNode,
      profileId: "other_profile",
      commands: [command],
    });
    const tool = f.factory.create(f.context)!;
    expect((await tool.execute("foreign", { device: secondId })).details).toEqual(
      (await tool.execute("unknown", { device: "unknown_charger" })).details,
    );
    expect(gateway.call).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();

    gateway.call.mockResolvedValue({ payload: { chargingState: "idle" } });
    expect((await tool.execute("automatic", {})).details).toEqual({
      ok: true,
      device: chargerId,
      chargingState: "idle",
    });
    expect(gateway.call.mock.calls[0]?.[2]).toMatchObject({ nodeId, command, params: {} });

    f.config.plugins.entries.goe.config.devices[1]!.profileId = profileId;
    expect((await tool.execute("ambiguous", {})).details).toMatchObject({
      error: { code: "device_selection_required" },
    });
    expect(gateway.call).toHaveBeenCalledTimes(1);
    f.list.mockResolvedValueOnce({
      nodes: [{ nodeId: secondNode, connected: true, invocableCommands: [command] }],
    });
    expect((await tool.execute("explicit", { device: secondId })).details).toMatchObject({
      ok: true,
      device: secondId,
    });
    expect(gateway.call.mock.calls[1]?.[2]).toMatchObject({
      nodeId: secondNode,
      command,
      params: {},
    });
  });

  it("requires the current private gateway turn before listing or invoking a node", async () => {
    const f = fixture();
    const tool = f.factory.create(f.context)!;
    gateway.routing.mockReturnValue(false);
    expect((await tool.execute("no_turn", {})).details).toMatchObject({
      error: { code: "device_private_turn_required" },
    });
    expect(f.list).not.toHaveBeenCalled();
    expect(gateway.call).not.toHaveBeenCalled();
  });

  it("addresses two chargers on one Node exclusively through their assigned keys", async () => {
    const f = sharedNodeFixture();
    const status = f.factory.create(f.context)!;
    const inventory = f.inventoryFactory.create(f.context)!;
    inventoryViews.get(inventory)!((provider, tool) => provider === "goe" && tool === status.name);
    const visible = (await inventory.execute("list", {})).details;
    expect(visible).toMatchObject({
      devices: [
        { id: chargerId, commands: [v2Command], tools: { status: "goe_status" } },
        { id: f.secondId, commands: [v2Command], tools: { status: "goe_status" } },
      ],
    });
    expect(JSON.stringify(visible)).not.toContain(f.firstKey);
    expect(JSON.stringify(visible)).not.toContain(f.secondKey);
    expect((await status.execute("no_selection", {})).details).toMatchObject({
      error: { code: "device_selection_required" },
    });
    expect((await status.execute("foreign_id", { device: "not_assigned" })).details).toMatchObject({
      error: { code: "device_not_assigned" },
    });
    expect(
      (await status.execute("override", { device: chargerId, deviceKey: f.secondKey })).details,
    ).toMatchObject({
      error: { code: "invalid_request" },
    });
    expect(gateway.call).not.toHaveBeenCalled();
    gateway.call
      .mockResolvedValueOnce({ payload: { deviceKey: f.firstKey, chargingState: "idle" } })
      .mockResolvedValueOnce({ payload: { deviceKey: f.secondKey, chargingState: "charging" } });
    expect((await status.execute("first", { device: chargerId })).details).toEqual({
      ok: true,
      device: chargerId,
      chargingState: "idle",
    });
    expect((await status.execute("second", { device: f.secondId })).details).toEqual({
      ok: true,
      device: f.secondId,
      chargingState: "charging",
    });
    expect(
      gateway.call.mock.calls.map(([, , request]) => ({
        nodeId: request.nodeId,
        command: request.command,
        params: request.params,
      })),
    ).toEqual([
      { nodeId, command: v2Command, params: { plugin: "go-e", deviceKey: f.firstKey } },
      { nodeId, command: v2Command, params: { plugin: "go-e", deviceKey: f.secondKey } },
    ]);
  });

  it.each(["wrong", "missing"] as const)("rejects a %s returned v2 identity", async (identity) => {
    const f = sharedNodeFixture();
    const tool = f.factory.create(f.context)!;
    gateway.call.mockResolvedValueOnce({
      payload: { chargingState: "idle", ...(identity === "wrong" && { deviceKey: f.secondKey }) },
    });
    const result = await tool.execute("identify", { device: chargerId });
    expect(result.details).toMatchObject({
      ok: false,
      error: { code: "device_android_identity_mismatch" },
    });
    expect(JSON.stringify(result)).not.toContain(f.secondKey);
    expect(JSON.stringify(result)).not.toContain("chargingState");
  });

  it("rejects mixed legacy and v2 routes, absent or duplicate keys, and an unsupported v2 route", async () => {
    const f = sharedNodeFixture();
    const tool = f.factory.create(f.context)!;
    f.devices[1] = { id: f.secondId, nodeId, profileId, commands: [command] };
    expect((await tool.execute("mixed", { device: chargerId })).details).toMatchObject({
      error: { code: "device_assignment_invalid" },
    });
    f.devices[1]!.commands = [v2Command];
    expect((await tool.execute("missing", { device: f.secondId })).details).toMatchObject({
      error: { code: "device_assignment_invalid" },
    });
    f.devices[1]!.deviceKey = f.firstKey;
    expect((await tool.execute("duplicate", { device: chargerId })).details).toMatchObject({
      error: { code: "device_assignment_invalid" },
    });
    expect(f.list).not.toHaveBeenCalled();
    f.devices[1]!.deviceKey = f.secondKey;
    f.list.mockResolvedValueOnce({
      nodes: [{ nodeId, connected: true, invocableCommands: [command] }],
    });
    expect((await tool.execute("old_node", { device: chargerId })).details).toMatchObject({
      error: { code: "device_command_unavailable" },
    });
    expect(gateway.call).not.toHaveBeenCalled();
  });

  it("closes pending dispatch when the charger key changes", async () => {
    const f = sharedNodeFixture();
    const tool = f.factory.create(f.context)!;
    gateway.call.mockImplementationOnce(async (_method, _options, _params, extra) => {
      f.devices[0]!.deviceKey = "098765";
      extra.dispatchAuthority.assertCurrent();
      expect.fail("obsolete route was accepted");
    });
    expect((await tool.execute("changed", { device: chargerId })).details).toMatchObject({
      error: { code: "device_not_assigned" },
    });
  });

  it.each([
    [
      {
        gatewayCode: "FORBIDDEN",
        message: "Matrix node invoke requires a current admitted agent run for this room and node",
      },
      "device_private_turn_required",
    ],
    [
      { details: { code: "ROUTE_CHANGED", nodeCommandDispatched: false } },
      "device_dispatch_failed",
    ],
    [
      { details: { nodeError: { code: "NOT_CONNECTED" }, nodeCommandDispatched: false } },
      "device_offline",
    ],
    [
      { details: { nodeError: { code: "TIMEOUT" }, nodeCommandDispatched: true } },
      "device_read_timeout",
    ],
    [{ code: "CLIENT_TIMEOUT" }, "device_read_timeout"],
    [
      {
        gatewayCode: "UNAVAILABLE",
        details: { nodeError: { code: "UNKNOWN_COMMAND" }, nodeCommandDispatched: true },
      },
      "device_android_read_failed",
    ],
    [
      {
        gatewayCode: "UNAVAILABLE",
        details: { nodeError: { code: "NOT_AUTHORIZED" }, nodeCommandDispatched: true },
      },
      "device_android_permission_required",
    ],
    [
      {
        gatewayCode: "UNAVAILABLE",
        details: { nodeError: { code: "NOT_AVAILABLE" }, nodeCommandDispatched: true },
      },
      "device_android_read_failed",
    ],
    [
      {
        gatewayCode: "UNAVAILABLE",
        details: { nodeError: { code: "UNKNOWN_COMMAND" }, nodeCommandDispatched: false },
      },
      "device_dispatch_failed",
    ],
    [
      {
        gatewayCode: "UNAVAILABLE",
        details: { nodeError: { code: "UNAVAILABLE" }, nodeCommandDispatched: true },
      },
      "device_dispatch_unconfirmed",
    ],
    [
      { details: { nodeError: { code: "NOT_AUTHORIZED" }, nodeCommandDispatched: true } },
      "device_dispatch_failed",
    ],
  ])(
    "classifies structured connector failures without exposing their data (%#)",
    async (error, code) => {
      const f = fixture();
      const tool = f.factory.create(f.context)!;
      const sensitive = "http://fixture.invalid/private-query?token=never-return";
      gateway.call.mockRejectedValueOnce(
        Object.assign(new Error(sensitive), error, { diagnostic: sensitive }),
      );
      const response = await tool.execute("classified_failure", {});
      expect(response.details).toMatchObject({ ok: false, error: { code } });
      expect(JSON.stringify(response)).not.toContain(sensitive);
      expect(JSON.stringify(response)).not.toContain("nodeCommandDispatched");
    },
  );

  it.each([
    ["GO_E_WLAN_APPROVAL_REQUIRED", "device_android_permission_required"],
    ["PERMISSION_REQUIRED", "device_android_permission_required"],
    ["GO_E_DISCOVERY_FAILED", "device_android_discovery_failed"],
    ["GO_E_DISCOVERY_TIMEOUT", "device_android_discovery_timeout"],
    ["GO_E_SERVICE_MISMATCH", "device_android_identity_mismatch"],
    ["GO_E_HTTP_TIMEOUT", "device_android_http_timeout"],
    ["GO_E_HTTP_UNREACHABLE", "device_android_http_unreachable"],
    ["GO_E_HTTP_REJECTED", "device_android_http_rejected"],
    ["GO_E_INVALID_RESPONSE", "device_android_invalid_response"],
    ["GO_E_IDENTITY_MISMATCH", "device_android_identity_mismatch"],
    ["GO_E_DEVICE_NOT_APPROVED", "device_android_not_approved"],
    ["GO_E_TARGET_REQUIRED", "device_android_target_required"],
    ["INVALID_PARAMS", "device_android_invalid_request"],
    ["GO_E_UNRECOGNIZED", "device_dispatch_unconfirmed"],
  ])("maps Android status %s to a stable result", async (nodeCode, code) => {
    const f = fixture();
    const tool = f.factory.create(f.context)!;
    const sensitive = "private-address.invalid";
    gateway.call.mockRejectedValueOnce(
      Object.assign(new Error(sensitive), {
        gatewayCode: "UNAVAILABLE",
        details: {
          nodeCommandDispatched: true,
          nodeError: { code: nodeCode, message: sensitive },
        },
      }),
    );
    const result = await tool.execute("classified_android_failure", {});
    expect(result.details).toMatchObject({ ok: false, error: { code } });
    expect(JSON.stringify(result)).not.toContain(sensitive);
  });

  it.each([
    [
      "GO_E_WIFI_UNAVAILABLE",
      "device_android_wifi_unavailable",
      "Element needs an active Wi-Fi connection outside a VPN to read the charger.",
    ],
    [
      "GO_E_WIFI_NOT_APPROVED",
      "device_android_wifi_not_approved",
      "Approve the current Wi-Fi once in Element's Wallbox settings.",
    ],
    [
      "GO_E_WIFI_CHANGED",
      "device_android_wifi_changed",
      "Element stopped the read after the Wi-Fi changed. Retry on an approved Wi-Fi network.",
    ],
    [
      "GO_E_DISCOVERY_NETWORK_MISMATCH",
      "device_android_discovery_network_mismatch",
      "Element could not confirm the discovered charger service belongs to the approved Wi-Fi network.",
    ],
    [
      "GO_E_DISCOVERY_SERIAL_MISSING",
      "device_android_discovery_serial_missing",
      "Element found a charger service without a usable serial number.",
    ],
    [
      "GO_E_DISCOVERY_SERIAL_MISMATCH",
      "device_android_discovery_serial_mismatch",
      "Element found a charger service with a different serial number.",
    ],
    [
      "GO_E_DISCOVERY_UNRESOLVED",
      "device_android_discovery_unresolved",
      "Element could not resolve the network address of the discovered charger service.",
    ],
  ])("gives precise guidance for %s", async (nodeCode, code, message) => {
    const f = fixture();
    const tool = f.factory.create(f.context)!;
    const privateDetails = "http://fixture.invalid/private-data?serial=000123";
    gateway.call.mockRejectedValueOnce({
      gatewayCode: "UNAVAILABLE",
      message: privateDetails,
      details: {
        nodeCommandDispatched: true,
        nodeError: { code: nodeCode, message: privateDetails },
      },
    });
    const result = await tool.execute("classified_android_diagnostic", {});
    expect(result.details).toEqual({
      ok: false,
      error: {
        code,
        message,
      },
    });
    expect(JSON.stringify(result)).not.toContain(privateDetails);
  });
});
