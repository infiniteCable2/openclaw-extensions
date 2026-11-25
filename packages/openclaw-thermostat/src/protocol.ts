export const deviceIdPattern = "^[a-z0-9][a-z0-9_-]{0,63}$";
export const ieeePattern = "^0x[a-f0-9]{16}$";
export const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export const modeValues = ["off", "heat", "auto"] as const;
export const temporaryModes = ["disabled", "timer", "boost"] as const;
export const historyTypes = ["day", "month", "half_year"] as const;

export class ThermostatError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new ThermostatError("invalid_request", "Expected an object.");
}

export function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) return value;
  throw new ThermostatError("invalid_request", `${label} must be an integer from ${min} to ${max}.`);
}

export function temperature(value: unknown): number {
  if (typeof value === "number" && value >= 5 && value <= 30 && Number.isInteger(value * 2)) return value;
  throw new ThermostatError("invalid_request", "Temperature must be 5–30 °C in half-degree steps.");
}

function scheduleDay(input: unknown): string {
  if (!Array.isArray(input) || input.length < 1 || input.length > 12) {
    throw new ThermostatError("invalid_request", "Each schedule day needs 1–12 transitions.");
  }
  let previous = "";
  return input.map((transition, i) => {
    const { time, temperatureC } = record(transition);
    if (typeof time !== "string" || !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(time) ||
        (i === 0 && time !== "00:00") || time <= previous) {
      throw new ThermostatError("invalid_request", "Schedule times must start at 00:00 and increase within the day.");
    }
    previous = time;
    return `${time}/${temperature(temperatureC)}`;
  }).join(" ");
}

function localTimestamp(value: unknown): string {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value))) {
    const date = value.slice(0, 10);
    if (new Date(`${date}T00:00:00Z`).toISOString().startsWith(date)) return value;
  }
  throw new ThermostatError("invalid_request", "Use an ISO timestamp with a time zone.");
}

export const readFields = {
  status: ["local_temperature", "occupied_heating_setpoint", "system_mode", "running_state", "battery", "fault_status"],
  settings: ["local_temperature_calibration", "screen_direction", "child_lock", "open_window", "frost_protection_temperature",
    "temperature_sensor_select", "external_temperature_input", "heating_valve_position", "idle_valve_position", "temperature_accuracy",
    "smart_temperature_control", "temporary_mode_mode", "temporary_mode_duration", "temporary_mode_target_temperature",
    "low_battery_valve_state", "schedule_active_group", "remote_temperature_linkage", "remote_setpoint_temperature"],
  diagnostics: ["fault_status", "open_window_detected", "heat_percentage_hour", "motor_travel_calibration_status",
    "idle_steps", "closing_steps", "valve_opening_limit_voltage", "valve_closing_limit_voltage", "valve_motor_running_voltage"],
} as const;

export type Payload = Record<string, unknown>;
export type Condition = (state: Payload) => boolean;
export const get = (fields: readonly string[]): Payload => Object.fromEntries(fields.map((field) => [field, ""]));
export const hasFields = (fields: readonly string[]): Condition => (state) => fields.every((field) => Object.hasOwn(state, field));

export function readPlan(input: Payload): ReadPlan & { partial?: boolean } {
  const section = input.section ?? "status";
  if (section === "schedule") return scheduleRead(String(integer(input.group, 1, 3, "Group")));
  if (section === "history") {
    const start = localTimestamp(input.from);
    const end = localTimestamp(input.to);
    const range = Date.parse(end) - Date.parse(start);
    const limits = { day: 48, month: 24 * 32, half_year: 24 * 184 } as const;
    const type = input.historyType;
    if (typeof type !== "string" || !Object.hasOwn(limits, type) || range <= 0 || range > limits[type as keyof typeof limits] * 3_600_000) {
      throw new ThermostatError("invalid_request", "Specify a history resolution and a corresponding forward time range.");
    }
    const fields = ["temperature_control_history"];
    return {
      topic: "set", payload: { read_temperature_control_history: { type, time_range: { start, end } } }, fields,
      ready: (state) => {
        const history = state.temperature_control_history as { type?: string; time_range?: { start?: string; end?: string } } | undefined;
        return history?.type === type && history.time_range?.start === start && history.time_range?.end === end;
      },
    };
  }
  if (typeof section !== "string" || !Object.hasOwn(readFields, section)) {
    throw new ThermostatError("invalid_request", "Unknown thermostat status section.");
  }
  const fields = readFields[section as keyof typeof readFields];
  return { topic: "get", payload: get(fields), fields, ready: hasFields(fields), partial: true };
}

function scheduleFields() {
  return days.map((day) => `weekly_schedule_${day}`);
}

function scheduleRead(group: string, expected?: Payload): ReadPlan {
  const daysToRead = expected ? Object.keys(expected) : scheduleFields();
  const fields = ["schedule_group_to_edit", ...daysToRead];
  return {
    topic: "set",
    payload: { schedule_group_to_edit: group },
    fields,
    acceptReport: (report) => String(report.schedule_group_to_edit) === group,
    ready: (state) => String(state.schedule_group_to_edit) === group && (expected
      ? Object.entries(expected).every(([key, value]) => normalizeSchedule(state[key]) === value)
      : hasFields(daysToRead)(state)),
  };
}

type ReadPlan = { topic: "get" | "set"; payload: Payload; fields: readonly string[]; ready: Condition; acceptReport?: Condition };

function normalizeSchedule(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  return value.trim().split(/\s+/).map((transition) => {
    const [time, target] = transition.split("/");
    return `${time}/${Number(target)}`;
  }).join(" ");
}

export function controlPlan(input: Payload): { write: Payload; verify: ReadPlan } {
  let write: Payload;
  let expected: Payload;
  switch (input.action) {
    case "set_temperature":
      write = { occupied_heating_setpoint: temperature(input.temperatureC) };
      break;
    case "set_mode": {
      const mode = modeValues.find((value) => value === input.mode);
      if (!mode) throw new ThermostatError("invalid_request", "Use off, heat or auto.");
      write = { system_mode: mode };
      break;
    }
    case "select_schedule":
      write = { schedule_active_group: String(integer(input.group, 1, 3, "Group")) };
      break;
    case "set_schedule": {
      const group = String(integer(input.group, 1, 3, "Group"));
      const schedule = record(input.schedule);
      if (!Object.keys(schedule).length || Object.keys(schedule).some((day) => !days.some((valid) => day === valid))) {
        throw new ThermostatError("invalid_request", "Provide transitions for one or more named days.");
      }
      expected = Object.fromEntries(Object.entries(schedule).map(([day, entries]) => [`weekly_schedule_${day}`, scheduleDay(entries)]));
      return {
        write: { schedule_group_to_edit: group, ...expected },
        verify: scheduleRead(group, expected),
      };
    }
    case "set_temporary_mode": {
      const mode = temporaryModes.find((value) => value === input.temporaryMode);
      if (!mode) throw new ThermostatError("invalid_request", "Use disabled, boost or timer.");
      write = { temporary_mode_mode: mode };
      if (mode !== "disabled") {
        write.temporary_mode_duration = integer(input.durationMinutes, 1, mode === "boost" ? 180 : 1440, "Duration");
      }
      if (mode === "timer") write.temporary_mode_target_temperature = temperature(input.temperatureC);
      break;
    }
    case "set_pid":
      if (typeof input.enabled !== "boolean") throw new ThermostatError("invalid_request", "Specify whether PID is enabled.");
      write = { smart_temperature_control: input.enabled ? "ON" : "OFF" };
      break;
    default:
      throw new ThermostatError("invalid_request", "Unknown thermostat action.");
  }
  const fields = Object.keys(write);
  return {
    write,
    verify: {
      topic: "get",
      payload: get(fields),
      fields,
      ready: (state) => fields.every((field) => field === "schedule_active_group"
        ? String(state[field]) === write[field]
        : state[field] === write[field]),
    },
  };
}
