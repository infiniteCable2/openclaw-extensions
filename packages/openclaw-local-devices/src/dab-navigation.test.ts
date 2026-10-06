import { describe, expect, it, vi } from "vitest";
import { mayStepToSameName, moveDabWithRecovery, navigateDabByName, nearestDabDirection } from "./dab-navigation.js";
import { LocalDeviceError } from "./types.js";

const unconfirmed = () => new LocalDeviceError("receiver_unconfirmed", "no new station metadata");

describe("DAB cached direction hint", () => {
  const names = ["A", "pure fm", "B", "C", "pure fm", "D"];
  it("chooses the shorter circular route to a name", () => {
    expect(nearestDabDirection(names, "A", "B")).toBe("UP");
    expect(nearestDabDirection(names, "D", "C")).toBe("DOWN");
    expect(nearestDabDirection(names, "B", "A")).toBe("DOWN");
  });
  it("excludes the current same-name occurrence and routes toward another", () => {
    expect(nearestDabDirection(names, "pure fm", "pure fm")).toBe("UP");
    expect(nearestDabDirection(["A", "A", "B"], "A", "A")).toBe("UP");
  });
  it("recognizes only cache-plausible adjacent equal-name steps", () => {
    expect(mayStepToSameName(["A", "A", "B"], "A", "UP")).toBe(true);
    expect(mayStepToSameName(["A", "B", "A"], "A", "DOWN")).toBe(true);
    expect(mayStepToSameName(names, "pure fm", "UP")).toBe(false);
  });
});

describe("DAB next-name navigation", () => {
  it("passes through another name before returning to the next duplicate", async () => {
    const sent: string[] = [];
    const next = ["B", "pure fm"];
    const result = await navigateDabByName(["A", "pure fm", "B", "pure fm"], "pure fm", "pure fm", {
      send: async (direction) => { sent.push(direction); },
      changed: async () => next.shift() ?? "unexpected",
      current: async () => "pure fm",
    });
    expect(result).toEqual({ direction: "UP", steps: 2, confirmed: true });
    expect(sent).toEqual(["UP", "UP"]);
  });

  it("counts an adjacent same-name step only as unverified", async () => {
    const sent: string[] = [];
    const result = await navigateDabByName(["A", "A", "B"], "A", "A", {
      send: async (direction) => { sent.push(direction); },
      changed: async () => { throw unconfirmed(); },
      current: async () => "A",
    });
    expect(result).toEqual({ direction: "UP", steps: 1, confirmed: false });
    expect(sent).toEqual(["UP"]);
  });

  it("uses the closer previous direction for a unique name", async () => {
    const sent: string[] = [];
    const result = await navigateDabByName(["A", "B", "C", "D"], "D", "C", {
      send: async (direction) => { sent.push(direction); },
      changed: async () => "C",
      current: async () => "C",
    });
    expect(result).toEqual({ direction: "DOWN", steps: 1, confirmed: true });
    expect(sent).toEqual(["DOWN"]);
  });

  it("does not treat an unconfirmed unrelated step as a duplicate", async () => {
    await expect(navigateDabByName(["A", "B", "C"], "A", "C", {
      send: async () => {},
      changed: async () => { throw unconfirmed(); },
      current: async () => "A",
    })).rejects.toMatchObject({ code: "receiver_unconfirmed" });
  });
});

describe("DAB step recovery", () => {
  it("does not bounce when the next station is confirmed", async () => {
    const send = vi.fn(async (_direction: "UP" | "DOWN") => {});
    const changed = vi.fn(async () => "B");
    const result = await moveDabWithRecovery("UP", "A", {
      send, changed, current: async () => "A", pause: async () => {},
    });
    expect(result).toEqual({ station: "B", recovered: false });
    expect(send.mock.calls.map(([direction]) => direction)).toEqual(["UP"]);
    expect(changed).toHaveBeenCalledWith("A", 6_000);
  });

  it("reverses before a slower retry and marks the outcome uncertain", async () => {
    const sent: string[] = [];
    const waits: number[] = [];
    let changeCalls = 0;
    const result = await moveDabWithRecovery("UP", "A", {
      send: async (direction) => { sent.push(direction); },
      changed: async (_previous, waitMs) => {
        waits.push(waitMs);
        if (++changeCalls === 1) throw unconfirmed();
        return "B";
      },
      current: async () => "A",
      pause: async () => {},
    });
    expect(result).toEqual({ station: "B", recovered: true });
    expect(sent).toEqual(["UP", "DOWN", "UP"]);
    expect(waits).toEqual([6_000, 9_000]);
  });

  it("restores a known baseline if reverse reached the preceding station", async () => {
    const sent: string[] = [];
    const waits: number[] = [];
    let changeCalls = 0;
    const result = await moveDabWithRecovery("UP", "A", {
      send: async (direction) => { sent.push(direction); },
      changed: async (_previous, waitMs) => {
        waits.push(waitMs);
        switch (++changeCalls) {
          case 1: throw unconfirmed();
          case 2: return "A";
          default: return "B";
        }
      },
      current: async () => "C",
      pause: async () => {},
    });
    expect(result).toEqual({ station: "B", recovered: true });
    expect(sent).toEqual(["UP", "DOWN", "UP", "UP"]);
    expect(waits).toEqual([6_000, 6_000, 9_000]);
  });

  it("stops after three bounded attempts rather than stepping indefinitely", async () => {
    const sent: string[] = [];
    const waits: number[] = [];
    await expect(moveDabWithRecovery("UP", "A", {
      send: async (direction) => { sent.push(direction); },
      changed: async (_previous, waitMs) => { waits.push(waitMs); throw unconfirmed(); },
      current: async () => "A",
      pause: async () => {},
    })).rejects.toMatchObject({ code: "receiver_unconfirmed" });
    expect(sent).toEqual(["UP", "DOWN", "UP", "DOWN", "UP"]);
    expect(waits).toEqual([6_000, 9_000, 12_000]);
  });

  it("does not retry forward when the reverse probe cannot restore the baseline", async () => {
    const sent: string[] = [];
    await expect(moveDabWithRecovery("UP", "A", {
      send: async (direction) => { sent.push(direction); },
      changed: async () => { throw unconfirmed(); },
      current: async () => "C",
      pause: async () => {},
    })).rejects.toMatchObject({ code: "receiver_unconfirmed" });
    expect(sent).toEqual(["UP", "DOWN", "UP"]);
  });
});
