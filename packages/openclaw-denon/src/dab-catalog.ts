export const MAX_DAB_STEPS = 128;

export type DabCatalogStation = {
  id: string;
  name: string;
  label?: string;
  selectionMode?: "name_confirmed" | "relative_unverified";
  occurrences: number;
  selectable: boolean;
};

export type DabCatalog = {
  version: 1;
  address: string;
  scannedAt: number;
  complete: boolean;
  stale: boolean;
  observedSteps: number;
  uncertainSteps: number;
  stations: DabCatalogStation[];
};

export type DabCatalogStore = {
  lookup(key: string): Promise<DabCatalog | undefined>;
  register(key: string, value: DabCatalog): Promise<void>;
};

/** Old v1 scans collapsed duplicate rows but retained their occurrence count. */
export function enableLegacyDabNameSelection(catalog: DabCatalog): DabCatalog {
  return { ...catalog, stations: catalog.stations.map((station) => station.occurrences > 1 && station.selectionMode === undefined
    ? { ...station, selectable: true, selectionMode: "relative_unverified" as const }
    : station) };
}

/** A repeated run of names identifies a cycle even if the first metadata was stale. */
export function findRepeatedDabCycle(names: readonly string[]): { start: number; length: number } | undefined {
  const window = 6;
  if (names.length < window * 2) return undefined;
  const suffixStart = names.length - window;
  for (let start = suffixStart - window; start >= 0; start--) {
    const length = suffixStart - start;
    if (length < window) continue;
    if (names.slice(start, start + window).every((name, offset) => name === names[suffixStart + offset])) {
      return { start, length };
    }
  }
  return undefined;
}

export function isValidDabCatalog(value: unknown, address: string): value is DabCatalog {
  if (!value || typeof value !== "object") return false;
  const catalog = value as Partial<DabCatalog>;
  return catalog.version === 1 && catalog.address === address
    && Number.isSafeInteger(catalog.scannedAt) && Number(catalog.scannedAt) > 0
    && typeof catalog.complete === "boolean" && typeof catalog.stale === "boolean"
    && Number.isInteger(catalog.observedSteps) && Number(catalog.observedSteps) >= 0
    && Number(catalog.observedSteps) <= MAX_DAB_STEPS
    && Number.isInteger(catalog.uncertainSteps) && Number(catalog.uncertainSteps) >= 0
    && Number(catalog.uncertainSteps) <= MAX_DAB_STEPS
    && Array.isArray(catalog.stations) && catalog.stations.length <= MAX_DAB_STEPS
    && catalog.stations.every((entry) => entry && typeof entry.id === "string"
      && /^dab_[0-9]{3}$/.test(entry.id) && typeof entry.name === "string"
      && entry.name.length > 0 && entry.name.length <= 80
      && (entry.label === undefined || (typeof entry.label === "string" && entry.label.length <= 84))
      && (entry.selectionMode === undefined || entry.selectionMode === "name_confirmed" || entry.selectionMode === "relative_unverified")
      && Number.isInteger(entry.occurrences) && entry.occurrences >= 1
      && entry.occurrences <= MAX_DAB_STEPS && typeof entry.selectable === "boolean")
    && new Set(catalog.stations.map((entry) => entry.id)).size === catalog.stations.length;
}

export function buildDabCatalog(
  address: string,
  observedNames: readonly string[],
  observedSteps: number,
  uncertainSteps: number,
  complete: boolean,
  scannedAt = Date.now(),
  ambiguousNames: ReadonlySet<string> = new Set(),
): DabCatalog {
  const counts = new Map<string, number>();
  for (const name of observedNames) {
    if (name && name.length <= 80) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const seenNames = new Map<string, number>();
  const stations = observedNames.flatMap<DabCatalogStation>((name, index) => {
    if (!name || name.length > 80) return [];
    const occurrences = counts.get(name) ?? 1;
    const ordinal = (seenNames.get(name) ?? 0) + 1;
    seenNames.set(name, ordinal);
    const nameConfirmed = occurrences === 1 && !ambiguousNames.has(name);
    return [{
      id: `dab_${String(index + 1).padStart(3, "0")}`,
      name,
      label: ordinal === 1 ? name : `${name}_${ordinal}`,
      selectionMode: nameConfirmed ? "name_confirmed" : "relative_unverified",
      occurrences,
      selectable: nameConfirmed || occurrences > 1,
    }];
  });
  return { version: 1, address, scannedAt, complete, stale: false, observedSteps, uncertainSteps, stations };
}
