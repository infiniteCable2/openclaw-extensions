import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

const maxReportBytes = 2 * 1024 * 1024;

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

export function reportSessions(text: string, key: string, limit: number) {
  for (const separator of [";", ",", "\t"]) {
    const report = rows(text.replace(/^\uFEFF/, ""), separator);
    if (!report?.length) continue;
    const header = report[0]!.map((cell) => cell.trim().toLowerCase());
    const column = (aliases: readonly string[]) => {
      const indices = header.flatMap((name, index) => (aliases.includes(name) ? [index] : []));
      return indices.length === 1 ? indices[0]! : -1;
    };
    const serialIndex = column(columns.serial);
    const startIndex = column(columns.start);
    const endIndex = column(columns.end);
    const energyIndex = column(columns.kwh);
    const durationIndex = column(columns.activeSeconds);
    if (Math.min(serialIndex, startIndex, endIndex, energyIndex) < 0) continue;

    const sessions = new Map<
      string,
      { startMs: number; endMs: number; energyKwh: number; activeChargingSeconds?: number }
    >();
    let matchedCharger = false;
    for (const row of report.slice(1)) {
      if (row.length !== header.length) return;
      const serial = row[serialIndex]?.trim();
      if (!serial || !/^\d{1,6}$/.test(serial) || serial.padStart(6, "0") !== key) continue;
      matchedCharger = true;
      const startMs = timestamp(row[startIndex]?.trim());
      const endMs = timestamp(row[endIndex]?.trim());
      const energyKwh = decimal(row[energyIndex]?.trim());
      if (
        startMs === undefined ||
        endMs === undefined ||
        endMs <= startMs ||
        energyKwh === undefined
      )
        continue;
      const active = decimal(row[durationIndex]?.trim());
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
    return [...sessions.values()]
      .sort((a, b) => b.endMs - a.endMs || b.startMs - a.startMs)
      .slice(0, limit)
      .map(({ startMs, endMs, energyKwh, activeChargingSeconds }) => ({
        startedAt: new Date(startMs).toISOString(),
        endedAt: new Date(endMs).toISOString(),
        energyKwh,
        ...(activeChargingSeconds !== undefined && { activeChargingSeconds }),
      }));
  }
}

export async function readHistoryReport(
  path: string,
  key: string,
  limit: number,
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
      limit,
    );
    return (
      sessions && {
        source: "configuredExport",
        reportModifiedAt: stat.mtime.toISOString(),
        sessions,
      }
    );
  } finally {
    await handle.close();
  }
}
