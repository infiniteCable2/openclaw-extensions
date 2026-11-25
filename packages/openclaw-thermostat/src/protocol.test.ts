import { describe, expect, it } from "vitest";
import { controlPlan, readPlan } from "./protocol.js";

describe("SONOFF TRV-ZBT operation mapping", () => {
  it("only accepts the documented temperature and mode values", () => {
    expect(controlPlan({ action: "set_temperature", temperatureC: 23 }).write)
      .toEqual({ occupied_heating_setpoint: 23 });
    expect(controlPlan({ action: "set_mode", mode: "heat" }).write).toEqual({ system_mode: "heat" });
    expect(() => controlPlan({ action: "set_temperature", temperatureC: 23.1 })).toThrow();
    expect(() => controlPlan({ action: "set_mode", mode: "factory_reset" })).toThrow();
    expect(() => controlPlan({ action: "calibrate_valve" })).toThrow();
  });

  it("groups validated schedules and compares their actual reported target values", () => {
    const plan = controlPlan({
      action: "set_schedule", group: 2,
      schedule: { monday: [{ time: "00:00", temperatureC: 17 }, { time: "09:30", temperatureC: 21.5 }] },
    });
    expect(plan.write).toEqual({ schedule_group_to_edit: "2", weekly_schedule_monday: "00:00/17 09:30/21.5" });
    expect(plan.verify.acceptReport?.({ schedule_group_to_edit: "1", weekly_schedule_monday: "00:00/17 09:30/21.5" })).toBe(false);
    expect(plan.verify.ready({ schedule_group_to_edit: "1", weekly_schedule_monday: "00:00/17 09:30/21.5" })).toBe(false);
    expect(plan.verify.ready({ schedule_group_to_edit: 2, weekly_schedule_monday: "00:00/17.0 09:30/21.5" })).toBe(true);
    expect(() => controlPlan({ action: "set_schedule", group: 2, schedule: { friday: [{ time: "09:00", temperatureC: 23 }] } })).toThrow();
  });

  it("limits boost duration separately from timer and requires a boolean for PID", () => {
    expect(() => controlPlan({ action: "set_temporary_mode", temporaryMode: "boost", durationMinutes: 181 })).toThrow();
    expect(controlPlan({ action: "set_temporary_mode", temporaryMode: "timer", durationMinutes: 180, temperatureC: 22 }).write)
      .toEqual({ temporary_mode_mode: "timer", temporary_mode_duration: 180, temporary_mode_target_temperature: 22 });
    expect(controlPlan({ action: "set_pid", enabled: false }).write).toEqual({ smart_temperature_control: "OFF" });
    expect(() => controlPlan({ action: "set_pid", enabled: "false" })).toThrow();
  });

  it("requires explicit time zones and a bounded forward history range", () => {
    const valid = { section: "history", historyType: "day", from: "2026-01-01T00:00:00+01:00", to: "2026-01-02T00:00:00+01:00" };
    const plan = readPlan(valid);
    expect(plan.payload).toEqual({ read_temperature_control_history: {
      type: "day", time_range: { start: valid.from, end: valid.to },
    } });
    expect(plan.ready({ temperature_control_history: { type: "day", time_range: { start: valid.from, end: valid.to } } })).toBe(true);
    expect(plan.ready({ temperature_control_history: { type: "day", time_range: { start: valid.from, end: valid.from } } })).toBe(false);
    expect(() => readPlan({ ...valid, to: "2026-01-02" })).toThrow();
    expect(() => readPlan({ ...valid, from: "2026-02-29T00:00:00Z", to: "2026-03-02T00:00:00Z" })).toThrow();
    expect(() => readPlan({ ...valid, to: "2026-01-05T00:00:00Z" })).toThrow();
    expect(() => readPlan({ ...valid, historyType: "constructor" })).toThrow();
  });
});
