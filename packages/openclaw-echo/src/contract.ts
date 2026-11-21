import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";

const device = Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,63}$" });
const label = Type.Optional(Type.String({ maxLength: 80 }));
const date = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
const time = Type.String({ pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" });
const id = Type.String({ pattern: "^(?![aA][lL][lL]$)[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" });
const singleId = { id };
const bluetoothOutputId = Type.String({ pattern: "^[a-f0-9]{24}$" });

function operation<const C extends string, const P extends "read" | "control" | "observe">(
  command: C,
  permission: P,
  args: Record<string, TSchema> = {},
) {
  return { command, permission, args };
}

export const operations = {
  status: { command: "echo.status.v1", permission: "read", args: {} },
  inventory: operation("echo.inventory.v1", "read"),
  privacy_status: operation("echo.privacy.status.v1", "read"),
  alarm_list: { command: "echo.alarm.list.v1", permission: "read", args: {} },
  timer_list: { command: "echo.timer.list.v1", permission: "read", args: {} },
  alarm_set: {
    command: "echo.alarm.set.v1",
    permission: "control",
    args: {
      time,
      date,
      label,
    },
  },
  alarm_delete: { command: "echo.alarm.delete.v1", permission: "control", args: singleId },
  alarm_repeat: operation("echo.alarm.repeat.v1", "control", {
    time,
    days: Type.String({
      pattern:
        "^(daily|weekdays|weekends|(?:mon|tue|wed|thu|fri|sat|sun)(?:,(?:mon|tue|wed|thu|fri|sat|sun)){0,6})$",
    }),
    label,
  }),
  alarm_enabled_set: operation("echo.alarm.enabled.set.v1", "control", {
    id,
    enabled: Type.Boolean(),
  }),
  alarm_stop: operation("echo.alarm.stop.v1", "control"),
  alarm_snooze: operation("echo.alarm.snooze.v1", "control", {
    minutes: Type.Integer({ minimum: 1, maximum: 60 }),
  }),
  reminder_list: operation("echo.reminder.list.v1", "read"),
  reminder_set: operation("echo.reminder.set.v1", "control", {
    time,
    date,
    label: Type.String({ minLength: 1, maxLength: 80 }),
  }),
  reminder_delete: operation("echo.reminder.delete.v1", "control", singleId),
  timer_start: {
    command: "echo.timer.start.v1",
    permission: "control",
    args: { durationSeconds: Type.Integer({ minimum: 1, maximum: 86400 }), label },
  },
  timer_pause: { command: "echo.timer.pause.v1", permission: "control", args: singleId },
  timer_resume: { command: "echo.timer.resume.v1", permission: "control", args: singleId },
  timer_cancel: { command: "echo.timer.cancel.v1", permission: "control", args: singleId },
  timer_stop: operation("echo.timer.stop.v1", "control"),
  timer_adjust: {
    command: "echo.timer.adjust.v1",
    permission: "control",
    args: {
      id,
      deltaSeconds: Type.Union([
        Type.Integer({ minimum: -86400, maximum: -1 }),
        Type.Integer({ minimum: 1, maximum: 86400 }),
      ]),
    },
  },
  audio_status: operation("echo.audio.status.v1", "read"),
  audio_volume_set: operation("echo.audio.volume.set.v1", "control", {
    step: Type.Integer({ minimum: 0, maximum: 30 }),
  }),
  audio_pause: operation("echo.audio.pause.v1", "control"),
  audio_resume: operation("echo.audio.resume.v1", "control"),
  audio_stop: operation("echo.audio.stop.v1", "control"),
  audio_next: operation("echo.audio.next.v1", "control"),
  audio_previous: operation("echo.audio.previous.v1", "control"),
  bluetooth_status: operation("echo.bluetooth.status.v1", "read"),
  bluetooth_phone_pair: operation("echo.bluetooth.phone.pair.v1", "control"),
  bluetooth_phone_reconnect: operation("echo.bluetooth.phone.reconnect.v1", "control"),
  bluetooth_phone_disconnect: operation("echo.bluetooth.phone.disconnect.v1", "control"),
  bluetooth_output_scan: operation("echo.bluetooth.output.scan.v1", "control"),
  bluetooth_output_scan_stop: operation("echo.bluetooth.output.scan.stop.v1", "control"),
  bluetooth_output_reconnect: operation("echo.bluetooth.output.reconnect.v1", "control"),
  bluetooth_output_disconnect: operation("echo.bluetooth.output.disconnect.v1", "control"),
  bluetooth_output_choose: operation("echo.bluetooth.output.choose.v1", "control", {
    id: bluetoothOutputId,
  }),
  radio_status: operation("echo.radio.status.v1", "read"),
  radio_play: operation("echo.radio.play.v1", "control", {
    station: Type.String({ minLength: 1, maxLength: 512 }),
  }),
  radio_stop: operation("echo.radio.stop.v1", "control"),
  weather_status: operation("echo.weather.status.v1", "read"),
  display_weather: operation("echo.display.weather.v1", "control"),
  display_radar: operation("echo.display.radar.v1", "control"),
  display_calendar: operation("echo.display.calendar.v1", "control", {
    date: Type.Optional(date),
    agenda: Type.Optional(Type.Boolean()),
  }),
  display_notify: operation("echo.display.notify.v1", "control", {
    title: Type.Optional(Type.String({ maxLength: 40 })),
    text: Type.String({ minLength: 1, maxLength: 240 }),
    seconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 3600 })),
  }),
  display_notify_status: operation("echo.display.notify.status.v1", "read"),
  display_notify_dismiss: operation("echo.display.notify.dismiss.v1", "control", singleId),
  capture_photo: operation("echo.capture.photo.v1", "observe"),
  capture_audio: operation("echo.capture.audio.v1", "observe", {
    durationSeconds: Type.Integer({ minimum: 1, maximum: 10 }),
  }),
} as const;

export type EchoAction = keyof typeof operations;
export type EchoOperation = (typeof operations)[EchoAction];
export type EchoCommand = EchoOperation["command"];
export type EchoPermission = EchoOperation["permission"];

const actions = Object.keys(operations) as EchoAction[];
export const echoCommands = actions.map((action) => operations[action].command);
export const captureCommands = actions
  .filter((action) => operations[action].permission === "observe")
  .map((action) => operations[action].command);
const commandSet: ReadonlySet<string> = new Set(echoCommands);

export type EchoBinding = {
  id: string;
  nodeId: string;
  profileId: string;
  sessionKey?: string;
  channels?: string[];
  commands: EchoCommand[];
};

const bindingsSchema = Type.Object(
  {
    devices: Type.Array(
      Type.Object(
        {
          id: device,
          nodeId: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          profileId: device,
          sessionKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
          channels: Type.Optional(
            Type.Array(device, { minItems: 1, maxItems: 16, uniqueItems: true }),
          ),
          commands: Type.Array(Type.String(), {
            minItems: 1,
            maxItems: echoCommands.length,
            uniqueItems: true,
          }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 128 },
    ),
  },
  { additionalProperties: false },
);

export function readEchoBindings(config: unknown): Map<string, EchoBinding> {
  if (!Value.Check(bindingsSchema, config)) {
    throw new Error("Invalid Echo device bindings");
  }
  const result = new Map<string, EchoBinding>();
  const nodeIds = new Set<string>();
  for (const binding of config.devices) {
    if (
      result.has(binding.id) ||
      nodeIds.has(binding.nodeId) ||
      binding.commands.some((command) => !commandSet.has(command))
    ) {
      throw new Error("Invalid or duplicate Echo device binding");
    }
    nodeIds.add(binding.nodeId);
    result.set(binding.id, { ...binding, commands: binding.commands as EchoCommand[] });
  }
  return result;
}

function schemaForAction(action: EchoAction) {
  return Type.Object(
    { device, action: Type.Literal(action), ...operations[action].args },
    { additionalProperties: false },
  );
}

export function echoToolParameters(allowed: readonly EchoAction[]) {
  const properties = new Map<string, Set<TSchema>>();
  for (const action of allowed) {
    for (const [key, schema] of Object.entries(operations[action].args)) {
      const schemas = properties.get(key) ?? new Set<TSchema>();
      schemas.add(schema);
      properties.set(key, schemas);
    }
  }
  return Type.Object(
    {
      device,
      action: Type.Union(allowed.map((action) => Type.Literal(action))),
      ...Object.fromEntries(
        [...properties].map(([key, schemas]) => {
          const variants = [...schemas];
          return [key, Type.Optional(variants.length === 1 ? variants[0] : Type.Union(variants))];
        }),
      ),
    },
    { additionalProperties: false },
  );
}

export function parseEchoAction(raw: unknown) {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("action" in raw) ||
    typeof raw.action !== "string" ||
    !Object.hasOwn(operations, raw.action)
  ) {
    return undefined;
  }
  const action = raw.action as EchoAction;
  if (!Value.Check(schemaForAction(action), raw)) {
    return undefined;
  }
  const {
    device,
    action: _action,
    ...args
  }: { device: string; action: EchoAction } & Record<string, unknown> = raw;
  if (typeof args.date === "string") {
    const parsed = new Date(`${args.date}T00:00:00.000Z`);
    if (
      args.agenda === true ||
      !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== args.date
    ) {
      return undefined;
    }
  }
  if (
    (typeof args.label === "string" &&
      (Buffer.byteLength(args.label) > 160 ||
        /\p{Cc}/u.test(args.label) ||
        (action === "reminder_set" && !args.label.trim()))) ||
    (typeof args.title === "string" && Buffer.byteLength(args.title) > 40) ||
    (typeof args.text === "string" && (Buffer.byteLength(args.text) > 240 || !args.text.trim()))
  ) {
    return undefined;
  }
  return { device, action, args };
}
