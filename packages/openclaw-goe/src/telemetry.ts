export const statusSections = ["charging", "grid", "device", "history"] as const;
export type StatusSection = (typeof statusSections)[number];

export function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function number(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;
}

function scaled(value: unknown, max: number, divisor: number): number | undefined {
  const reading = number(value, 0, max);
  return reading === undefined ? undefined : reading / divisor;
}

function enumValue<T>(value: unknown, entries: readonly T[]): T | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? entries[value]
    : undefined;
}

function boundedName(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9 ._+\-]{0,63}$/.test(value)
    ? value
    : undefined;
}

function phases(values: unknown[], start: number, min: number, max: number) {
  const readings = ["L1", "L2", "L3"].flatMap((phase, i) => {
    const value = number(values[start + i], min, max);
    return value === undefined ? [] : [[phase, value] as const];
  });
  return readings.length > 0 ? Object.fromEntries(readings) : undefined;
}

function populated(fields: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

const reportedStates = new Set([
  "unknown",
  "idle",
  "charging",
  "waitingForCar",
  "complete",
  "error",
]);
const lockStates = [
  "unknown",
  "unlocked",
  "unlockFailed",
  "locked",
  "lockFailed",
  "unlockPowerLoss",
];

export function projectStatus(
  payload: Record<string, unknown>,
  section: Exclude<StatusSection, "history">,
) {
  const data = object(payload.telemetry) ?? {};
  const nrg: unknown[] = Array.isArray(data.nrg) ? data.nrg : [];
  const currents = phases(nrg, 4, 0, 100);
  const errorCode = number(data.err, 0, 255);
  if (section === "charging") {
    if (typeof payload.chargingState !== "string" || !reportedStates.has(payload.chargingState))
      return;
    const duration = object(data.cdi);
    return populated({
      chargingState: payload.chargingState,
      chargingAllowed:
        typeof payload.chargingAllowed === "boolean" ? payload.chargingAllowed : undefined,
      allowedCurrentAmps: Number.isInteger(payload.allowedCurrentAmps)
        ? number(payload.allowedCurrentAmps, 0, 32)
        : undefined,
      chargingReasonCode: number(data.modelStatus, 0, 255),
      powerKw: scaled(nrg[11], 100_000, 1000),
      currentAmpsByPhase: currents,
      phasesDrawingCurrent:
        currents && Object.keys(currents).length === 3
          ? Object.entries(currents)
              .filter(([, value]) => value > 0)
              .map(([phase]) => phase)
          : undefined,
      phaseMode: enumValue(data.psm, ["automatic", "singlePhase", "threePhase"]),
      singlePhaseRequested: typeof data.fsp === "boolean" ? data.fsp : undefined,
      cableLockState: enumValue(data.cus, lockStates),
      energySincePluggedInKwh: scaled(data.wh, Number.MAX_SAFE_INTEGER, 1000),
      chargingDurationSeconds:
        duration?.type === 1 ? scaled(duration.value, Number.MAX_SAFE_INTEGER, 1000) : undefined,
      requestedCurrentAmps: number(data.amp, 0, 32),
      cableLimitAmps: number(data.cbl, 0, 63),
      energyLimitKwh: scaled(data.dwo, Number.MAX_SAFE_INTEGER, 1000),
      energyBySourceKwh: optionalGroup({
        grid: scaled(data.whg, Number.MAX_SAFE_INTEGER, 1000),
        solar: scaled(data.whs, Number.MAX_SAFE_INTEGER, 1000),
        battery: scaled(data.whb, Number.MAX_SAFE_INTEGER, 1000),
        other: scaled(data.who, Number.MAX_SAFE_INTEGER, 1000),
      }),
    });
  }
  if (section === "grid") {
    return optionalGroup({
      voltageVByPhase: phases(nrg, 0, 0, 500),
      powerWByPhase: phases(nrg, 7, 0, 50_000),
      powerFactorPercentByPhase: phases(nrg, 12, 0, 100),
      frequencyHz: number(data.fhz, 1, 100),
      averageFrequencyHz: number(data.avgfhz, 1, 100),
      lastGridFailure: number(data.gsa, 0, Number.MAX_SAFE_INTEGER),
      errorCode,
      chargingReasonCode: number(data.modelStatus, 0, 255),
    });
  }
  return populated({
    reachable: true,
    model: boundedName(data.typ),
    firmwareVersion: boundedName(data.fwv),
    errorCode,
    temperatureSensorsC: Array.isArray(data.tma)
      ? data.tma.slice(0, 8).map((reading: unknown) => number(reading, -80, 180) ?? null)
      : undefined,
    adapter16A: typeof data.adi === "boolean" ? data.adi : undefined,
    cableLockSetting: enumValue(data.lck, ["normal", "autoUnlock", "alwaysLock", "forceUnlock"]),
    cableLockFeedback: enumValue(data.ffb, ["none", "lockProblem", "unlockProblem"]),
    lifetimeEnergyKwh: scaled(data.eto, Number.MAX_SAFE_INTEGER, 1000),
  });
}

function optionalGroup(fields: Record<string, unknown>) {
  const values = populated(fields);
  return Object.keys(values).length > 0 ? values : undefined;
}
