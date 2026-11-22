import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

const maxReportBytes = 2 * 1024 * 1024;
export const maxHistoryPageSize = 20;
export const historyFields = new Set(["limit", "offset", "from", "to"]);

type HistoryWindow = { from?: number; to?: number };
type HistoryQuery = HistoryWindow & { limit: number; offset?: number };

function parseHistoryBound(value: unknown) {
  if (typeof value !== "string") return;
  const match =
    /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (!match) return;
  const date = Date.parse(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== match[1]) return;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : undefined;
}

export function parseHistoryQuery(input: Record<string, unknown>): HistoryQuery | undefined {
  const limit = input.limit === undefined ? 3 : input.limit;
  const offset = input.offset;
  const from = parseHistoryBound(input.from);
  const to = parseHistoryBound(input.to);
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > maxHistoryPageSize ||
    (offset !== undefined &&
      (typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > Number.MAX_SAFE_INTEGER - maxHistoryPageSize)) ||
    (input.from !== undefined && from === undefined) ||
    (input.to !== undefined && to === undefined) ||
    (from !== undefined && to !== undefined && from >= to)
  )
    return;
  return {
    limit,
    ...(offset !== undefined && { offset }),
    ...(from !== undefined && { from }),
    ...(to !== undefined && { to }),
  };
}

type Session = {
  startMs: number;
  endMs: number;
  energyKwh: number;
  activeChargingSeconds?: number;
};

function latestSessions(
  items: Iterable<Session>,
  limit: number,
  { from = -Infinity, to = Infinity, offset = 0 }: HistoryWindow & { offset?: number } = {},
) {
  return [...items]
    .filter(({ startMs }) => startMs >= from && startMs < to)
    .sort((a, b) => b.endMs - a.endMs || b.startMs - a.startMs)
    .slice(offset, offset + limit)
    .map(({ startMs, endMs, energyKwh, activeChargingSeconds }) => ({
      startedAt: new Date(startMs).toISOString(),
      endedAt: new Date(endMs).toISOString(),
      energyKwh,
      ...(activeChargingSeconds !== undefined && { activeChargingSeconds }),
    }));
}

export function structuredSessions(rows: unknown, limit: number, window?: HistoryWindow) {
  if (!Array.isArray(rows)) return;
  const result: Session[] = [];
  for (const item of rows as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const { startUnix, endUnix, still_running, energy, seconds_charged } = row;
    if (
      still_running !== false ||
      typeof startUnix !== "number" ||
      typeof endUnix !== "number" ||
      !Number.isSafeInteger(startUnix) ||
      !Number.isSafeInteger(endUnix) ||
      startUnix < 1e12 ||
      endUnix > 8.64e15 ||
      startUnix >= endUnix ||
      typeof energy !== "number" ||
      !Number.isFinite(energy) ||
      energy < 0
    )
      continue;
    const match =
      typeof seconds_charged === "string" &&
      /^(\d{1,4}):([0-5]\d):([0-5]\d)$/.exec(seconds_charged);
    const seconds = match
      ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
      : undefined;
    const activeChargingSeconds =
      seconds !== undefined && seconds <= (endUnix - startUnix) / 1000 ? seconds : undefined;
    result.push({ startMs: startUnix, endMs: endUnix, energyKwh: energy, activeChargingSeconds });
  }
  return latestSessions(result, limit, window);
}

export function historyPage<T>(rows: T[], query: HistoryQuery, hasMore: boolean) {
  const nextOffset = (query.offset ?? 0) + query.limit;
  return {
    sessions: rows.slice(0, query.limit),
    ...(hasMore &&
      rows.length >= query.limit &&
      nextOffset <= Number.MAX_SAFE_INTEGER - maxHistoryPageSize && { nextOffset }),
  };
}

export function configuredReport(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= 512 &&
    !value.includes("\0") &&
    isAbsolute(value)
    ? value
    : undefined;
}

function rows(text: string, separator: string): string[][] | undefined {
  const result: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = false;
        closed = true;
      }
    } else if (char === separator || char === "\n" || char === "\r") {
      row.push(field);
      field = "";
      closed = false;
      if (char !== separator) {
        if (char === "\r" && text[i + 1] === "\n") i++;
        if (row.some(Boolean)) result.push(row);
        row = [];
      }
    } else if (char === '"' && !field && !closed) quoted = true;
    else if (closed || char === '"') return;
    else field += char;
  }
  if (quoted) return;
  if (row.length || field || closed) result.push([...row, field]);
  return result;
}

const columns = {
  serial: ["charger serial number", "serial number", "seriennummer des ladegeräts", "seriennummer"],
  start: ["session start time", "start time", "startzeit der sitzung", "startzeit"],
  end: [
    "session stop time",
    "session end time",
    "stop time",
    "end time",
    "endzeit der sitzung",
    "endzeit",
  ],
  kwh: [
    "total energy consumed (kwh)",
    "energy (kwh)",
    "gesamtenergieverbrauch (kwh)",
    "energie (kwh)",
  ],
  activeSeconds: [
    "total active charging time (s)",
    "active charging time (s)",
    "gesamtaktive ladezeit (s)",
    "aktive ladezeit (s)",
  ],
} as const;

function timestamp(value: string | undefined): number | undefined {
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?\s?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
  )
    return;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function decimal(value: string | undefined): number | undefined {
  if (!value || !/^\d+(?:[.,]\d+)?$/.test(value)) return;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) && parsed <= Number.MAX_SAFE_INTEGER ? parsed : undefined;
}

function durationSeconds(value: string | undefined): number | undefined {
  const parts = value?.match(/^(?:(\d{1,4})h\s*)?(?:(\d{1,2})min\s*)?(?:(\d{1,2})s)?$/i);
  if (!value || !parts) return;
  const [, hours, minutes, seconds] = parts;
  if (Number(minutes ?? 0) >= 60 || Number(seconds ?? 0) >= 60) return;
  return Number(hours ?? 0) * 3600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
}

function localClock(value: string | undefined): number | undefined {
  const match = value?.match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}:\d{2}:\d{2})$/);
  if (!match) return;
  const iso = `${match[3]}-${match[2]}-${match[1]}T${match[4]}.000Z`;
  const valueMs = Date.parse(iso);
  return Number.isFinite(valueMs) && new Date(valueMs).toISOString() === iso ? valueMs : undefined;
}

function goEInterval(id: string, start: string, end: string, duration: string) {
  // The German charger export uses Unix seconds as the session ID. Validate the
  // anchor and elapsed time against both displayed local clocks, including DST.
  if (!/^\d{10}$/.test(id)) return;
  const localStart = localClock(start);
  const localEnd = localClock(end);
  const seconds = durationSeconds(duration);
  if (localStart === undefined || localEnd === undefined || !seconds) return;
  const startMs = Number(id) * 1000;
  const endMs = startMs + seconds * 1000;
  const startOffset = localStart - startMs;
  const endOffset = localEnd - endMs;
  const hour = 3_600_000;
  const validOffset = (offset: number) =>
    offset % (hour / 4) === 0 && offset >= -12 * hour && offset <= 14 * hour;
  if (
    !validOffset(startOffset) ||
    !validOffset(endOffset) ||
    Math.abs(startOffset - endOffset) > 2 * hour
  )
    return;
  return { startMs, endMs };
}

export function reportSessions(
  text: string,
  key: string,
  limit: number,
  filter?: HistoryWindow & { offset?: number },
) {
  for (const separator of [";", ",", "\t"]) {
    const report = rows(text.replace(/^\uFEFF/, ""), separator);
    if (!report?.length) continue;
    const header = report[0]!.map((cell) => cell.trim().toLowerCase());
    const column = (aliases: readonly string[]) => {
      const indices = header.flatMap((name, index) => (aliases.includes(name) ? [index] : []));
      return indices.length === 1 ? indices[0]! : -1;
    };
    const sessionIndex = column(["session id"]);
    const elapsedIndex = column(["gesamtzeit"]);
    const goEExport = sessionIndex >= 0 && elapsedIndex >= 0 && column(["charger-sn"]) >= 0;
    const serialIndex = column(goEExport ? ["charger-sn"] : columns.serial);
    const startIndex = column(goEExport ? ["start"] : columns.start);
    const endIndex = column(goEExport ? ["ende"] : columns.end);
    const energyIndex = column(goEExport ? ["energie"] : columns.kwh);
    const durationIndex = column(goEExport ? ["ladezeit"] : columns.activeSeconds);
    if (Math.min(serialIndex, startIndex, endIndex, energyIndex) < 0) continue;

    const sessions = new Map<string, Session>();
    let matchedCharger = false;
    for (const row of report.slice(1)) {
      if (row.length !== header.length) return;
      const serial = row[serialIndex]?.trim();
      if (!serial || !/^\d{1,6}$/.test(serial) || serial.padStart(6, "0") !== key) continue;
      matchedCharger = true;
      const start = row[startIndex]!.trim();
      const end = row[endIndex]!.trim();
      const interval = goEExport
        ? goEInterval(row[sessionIndex]!.trim(), start, end, row[elapsedIndex]!.trim())
        : { startMs: timestamp(start), endMs: timestamp(end) };
      const { startMs, endMs } = interval ?? {};
      const energyKwh = decimal(row[energyIndex]?.trim());
      if (
        startMs === undefined ||
        endMs === undefined ||
        endMs <= startMs ||
        energyKwh === undefined
      )
        continue;
      const active = (goEExport ? durationSeconds : decimal)(row[durationIndex]?.trim());
      const activeChargingSeconds =
        active !== undefined && active <= (endMs - startMs) / 1000 ? active : undefined;
      const id = `${startMs}:${endMs}`;
      const session = { startMs, endMs, energyKwh, activeChargingSeconds };
      const previous = sessions.get(id);
      if (
        previous &&
        (previous.energyKwh !== energyKwh ||
          previous.activeChargingSeconds !== activeChargingSeconds)
      )
        return;
      sessions.set(id, session);
    }
    if (report.length > 1 && !matchedCharger) return;
    return latestSessions(sessions.values(), limit, filter);
  }
}

export async function readHistoryReport(
  path: string,
  key: string,
  query: HistoryQuery,
  signal?: AbortSignal,
) {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxReportBytes) return;
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size || (await handle.stat()).mtimeMs !== stat.mtimeMs) return;
    const sessions = reportSessions(
      new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)),
      key,
      query.limit + 1,
      query,
    );
    return (
      sessions && {
        source: "configuredExport",
        reportModifiedAt: stat.mtime.toISOString(),
        ...historyPage(sessions, query, sessions.length > query.limit),
      }
    );
  } finally {
    await handle.close();
  }
}
