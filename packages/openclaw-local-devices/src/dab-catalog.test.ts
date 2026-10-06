import { describe, expect, it } from "vitest";
import { buildDabCatalog, enableLegacyDabNameSelection, hasRepeatedDabPrefix, isValidDabCatalog } from "./dab-catalog.js";

describe("DAB station catalog", () => {
  it("keeps duplicate names in scan order with copy-style labels and explicit relative selection", () => {
    const catalog = buildDabCatalog("192.168.1.57", ["ENERGY B", "pure fm", "Jazz", "pure fm"], 4, 0, true, 1234);
    expect(catalog.stations).toEqual([
      { id: "dab_001", name: "ENERGY B", label: "ENERGY B", selectionMode: "name_confirmed", occurrences: 1, selectable: true },
      { id: "dab_002", name: "pure fm", label: "pure fm", selectionMode: "relative_unverified", occurrences: 2, selectable: true },
      { id: "dab_003", name: "Jazz", label: "Jazz", selectionMode: "name_confirmed", occurrences: 1, selectable: true },
      { id: "dab_004", name: "pure fm", label: "pure fm_2", selectionMode: "relative_unverified", occurrences: 2, selectable: true },
    ]);
    expect(isValidDabCatalog(catalog, "192.168.1.57")).toBe(true);
    expect(isValidDabCatalog(catalog, "192.168.1.58")).toBe(false);
  });

  it("rejects a damaged persisted cache", () => {
    const catalog = buildDabCatalog("192.168.1.57", ["ENERGY B"], 1, 0, false, 1234);
    expect(isValidDabCatalog({ ...catalog, stations: [{ ...catalog.stations[0], id: "../secret" }] }, "192.168.1.57")).toBe(false);
    expect(isValidDabCatalog({ ...catalog, observedSteps: 9999 }, "192.168.1.57")).toBe(false);
  });

  it("makes old collapsed duplicates selectable by name without inventing a second row", () => {
    const old = buildDabCatalog("192.168.1.57", ["A", "pure fm", "B", "pure fm"], 4, 1, false, 1234);
    const collapsed = { ...old, stations: [
      { id: "dab_001", name: "A", occurrences: 1, selectable: true },
      { id: "dab_002", name: "pure fm", occurrences: 2, selectable: false },
      { id: "dab_003", name: "B", occurrences: 1, selectable: true },
    ] };
    expect(isValidDabCatalog(collapsed, "192.168.1.57")).toBe(true);
    const compatible = enableLegacyDabNameSelection(collapsed);
    expect(compatible.stations).toHaveLength(3);
    expect(compatible.stations[1]).toMatchObject({ name: "pure fm", occurrences: 2, selectable: true, selectionMode: "relative_unverified" });
    expect(collapsed.stations[1]?.selectable).toBe(false);
  });

  it("leaves uncertain unique names unselectable but permits relative duplicate selection", () => {
    const catalog = buildDabCatalog("192.168.1.57", ["ByteFM", "Dlf Kult"], 3, 1, true, 1234, new Set(["ByteFM"]));
    expect(catalog.stations[0]?.selectionMode).toBe("relative_unverified");
    expect(catalog.stations[0]?.selectable).toBe(false);
    expect(catalog.stations[1]?.selectable).toBe(true);
    const noAnchor = buildDabCatalog("192.168.1.57", ["ByteFM", "ByteFM"], 3, 1, true, 1234);
    expect(noAnchor.stations.every((station) => station.selectable)).toBe(true);
  });

  it("does not mistake an equal short name for a completed cycle", () => {
    expect(hasRepeatedDabPrefix(["A", "B", "C", "A"])).toBe(false);
    expect(hasRepeatedDabPrefix(["A", "B", "C", "A", "B"])).toBe(false);
    expect(hasRepeatedDabPrefix(["A", "B", "C", "D", "A", "B", "C"])).toBe(true);
  });
});
