import { describe, expect, it } from "vitest";
import { buildDabCatalog, isValidDabCatalog } from "./dab-catalog.js";

describe("DAB station catalog", () => {
  it("keeps observed order and marks duplicate short names non-selectable", () => {
    const catalog = buildDabCatalog("192.168.1.57", ["ENERGY B", "pure fm", "Jazz", "pure fm"], 4, 0, true, 1234);
    expect(catalog.stations).toEqual([
      { id: "dab_001", name: "ENERGY B", occurrences: 1, selectable: true },
      { id: "dab_002", name: "pure fm", occurrences: 2, selectable: false },
      { id: "dab_003", name: "Jazz", occurrences: 1, selectable: true },
    ]);
    expect(isValidDabCatalog(catalog, "192.168.1.57")).toBe(true);
    expect(isValidDabCatalog(catalog, "192.168.1.58")).toBe(false);
  });

  it("rejects a damaged persisted cache", () => {
    const catalog = buildDabCatalog("192.168.1.57", ["ENERGY B"], 1, 0, false, 1234);
    expect(isValidDabCatalog({ ...catalog, stations: [{ ...catalog.stations[0], id: "../secret" }] }, "192.168.1.57")).toBe(false);
    expect(isValidDabCatalog({ ...catalog, observedSteps: 9999 }, "192.168.1.57")).toBe(false);
  });

  it("does not offer uncertain station names for direct selection", () => {
    const catalog = buildDabCatalog("192.168.1.57", ["ByteFM", "Dlf Kult"], 3, 1, true, 1234, new Set(["ByteFM"]));
    expect(catalog.stations[0]?.selectable).toBe(false);
    expect(catalog.stations[1]?.selectable).toBe(true);
  });
});
