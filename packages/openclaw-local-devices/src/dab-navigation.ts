import { LocalDeviceError } from "./types.js";

export type DabDirection = "UP" | "DOWN";

/** Cache order is a direction hint, not a service identity. Exclude zero distance. */
export function nearestDabDirection(names: readonly string[], current: string, target: string): DabDirection {
  const starts = names.flatMap((name, index) => name === current ? [index] : []);
  const ends = names.flatMap((name, index) => name === target ? [index] : []);
  if (!starts.length || !ends.length || names.length < 2) return "UP";
  let up = Infinity;
  let down = Infinity;
  for (const start of starts) for (const end of ends) {
    const forward = (end - start + names.length) % names.length;
    const backward = (start - end + names.length) % names.length;
    if (forward) up = Math.min(up, forward);
    if (backward) down = Math.min(down, backward);
  }
  return down < up ? "DOWN" : "UP";
}

/** A repeated visible name can hide one relative movement. */
export function mayStepToSameName(names: readonly string[], current: string, direction: DabDirection): boolean {
  return names.some((name, index) => name === current
    && names[(index + (direction === "UP" ? 1 : names.length - 1)) % names.length] === current);
}

export type DabNamedSelectionPorts = {
  send(direction: DabDirection): Promise<void>;
  changed(previous: string): Promise<string>;
  current(): Promise<string | undefined>;
};

/** Move to the next matching *name*. A duplicate ordinal is never claimed as a service ID. */
export async function navigateDabByName(
  names: readonly string[], initial: string, target: string, ports: DabNamedSelectionPorts,
  knownOccurrences: ReadonlyMap<string, number> = new Map(),
): Promise<{ direction: DabDirection; steps: number; confirmed: boolean }> {
  const direction = nearestDabDirection(names, initial, target);
  const uniqueNames = new Set(names);
  const count = (name: string) => Math.max(names.filter((candidate) => candidate === name).length, knownOccurrences.get(name) ?? 0);
  if (initial === target && count(target) === 1) {
    return { direction, steps: 0, confirmed: true };
  }
  let current = initial;
  let unverifiedSteps = 0;
  const maxUnverified = Math.min(4, [...uniqueNames].reduce((total, name) => total + Math.max(0, count(name) - 1), 0));
  const maxSteps = Math.min(128, Math.max(2, [...uniqueNames].reduce((total, name) => total + count(name), 0)));
  for (let step = 1; step <= maxSteps; step++) {
    await ports.send(direction);
    try {
      current = await ports.changed(current);
    } catch (error) {
      if (!(error instanceof LocalDeviceError) || error.code !== "receiver_unconfirmed") throw error;
      const legacyDuplicate = count(current) > names.filter((name) => name === current).length;
      if ((!mayStepToSameName(names, current, direction) && !legacyDuplicate) || ++unverifiedSteps > maxUnverified) {
        throw new LocalDeviceError("receiver_unconfirmed", "DAB step was not confirmed; the receiver may have moved");
      }
      // A same-name step is plausible, but HEOS cannot prove which service is playing.
      const observed = await ports.current();
      if (observed !== current) throw new LocalDeviceError("receiver_unconfirmed", "DAB metadata changed during an unverified step");
      if (current === target) return { direction, steps: step, confirmed: false };
      continue;
    }
    if (current === target) return { direction, steps: step, confirmed: unverifiedSteps === 0 };
  }
  throw new LocalDeviceError("dab_catalog_stale", "DAB target name was not found within the cached station list");
}

export type DabNavigationPorts = {
  send(direction: DabDirection): Promise<void>;
  changed(previous: string, waitMs: number): Promise<string>;
  current(): Promise<string | undefined>;
  pause(waitMs: number): Promise<void>;
};

/** One logical step, never repeating a relative command without a reverse probe. */
export async function moveDabWithRecovery(
  direction: DabDirection,
  previous: string,
  ports: DabNavigationPorts,
): Promise<{ station: string; recovered: boolean }> {
  const opposite = direction === "UP" ? "DOWN" : "UP";
  let recovered = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    await ports.send(direction);
    try {
      return { station: await ports.changed(previous, [6_000, 9_000, 12_000][attempt]), recovered };
    } catch (error) {
      if (!(error instanceof LocalDeviceError) || error.code !== "receiver_unconfirmed" || attempt === 2) throw error;
    }
    await ports.send(opposite);
    await ports.pause([1_000, 1_500][attempt]);
    const back = await ports.current();
    if (!back) throw new LocalDeviceError("receiver_unconfirmed", "DAB reverse step has no station metadata");
    if (back !== previous) {
      // The first step may not have moved; reverse reached the predecessor.
      await ports.send(direction);
      const restored = await ports.changed(back, [6_000, 9_000][attempt]);
      if (restored !== previous) {
        throw new LocalDeviceError("receiver_unconfirmed", "DAB baseline could not be restored after reverse probe");
      }
    } else {
      // Equal names do not prove equal services. Preserve that uncertainty.
      await ports.pause(500);
      if (await ports.current() !== previous) {
        throw new LocalDeviceError("receiver_unconfirmed", "DAB reverse probe could not establish the previous station");
      }
    }
    recovered = true;
  }
  throw new LocalDeviceError("receiver_unconfirmed", "DAB station change was not confirmed");
}
