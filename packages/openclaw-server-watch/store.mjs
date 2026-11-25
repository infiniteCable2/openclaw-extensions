import { DatabaseSync } from "node:sqlite";
import { isAbsolute } from "node:path";

export const MAX_HOURS = 168;
export const minute = 60_000;
export const hour = 60 * minute;
export const days = 24 * hour;

export function openStore(path, readOnly = false) {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 512) throw new Error("invalid_database");
  const db = new DatabaseSync(path, { readOnly });
  db.exec("PRAGMA busy_timeout=800");
  if (!readOnly) db.exec(`
    CREATE TABLE IF NOT EXISTS samples (at INTEGER PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  return db;
}

export function snapshot(db, id) {
  const row = db.prepare("SELECT at,data FROM snapshots WHERE id=?").get(id);
  return row ? { at: row.at, data: JSON.parse(row.data) } : undefined;
}

export function putSnapshot(db, id, at, data) {
  db.prepare("INSERT OR REPLACE INTO snapshots VALUES (?,?,?)").run(id, at, JSON.stringify(data));
}

export function putSample(db, at, data, prev) {
  db.exec("BEGIN IMMEDIATE");
  try {
    // Repeated timer invocations during one minute don't replace a completed interval.
    const inserted = db.prepare("INSERT OR IGNORE INTO samples VALUES (?,?)").run(at, JSON.stringify(data)).changes;
    if (inserted) putSnapshot(db, "lastCounters", at, prev);
    db.prepare("DELETE FROM samples WHERE at < ?").run(at - (MAX_HOURS + 1) * hour);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function sampleRange(db, from, to) {
  return db.prepare("SELECT at,data FROM samples WHERE at>=? AND at<=? ORDER BY at LIMIT 10200")
    .iterate(from, to);
}
