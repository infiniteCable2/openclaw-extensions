import { randomUUID } from "node:crypto";
import { mkdir, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DEVICE_ID_PATTERN, LocalDeviceError } from "./types.js";
import type { DabCatalog, DabCatalogStore } from "./dab-catalog.js";

const MAX_CACHE_BYTES = 64 * 1024;

export class DabFileCatalogStore implements DabCatalogStore {
  constructor(private readonly directory: string) {}

  private path(key: string): string {
    if (!DEVICE_ID_PATTERN.test(key)) throw new LocalDeviceError("invalid_request", "Invalid receiver id");
    return join(this.directory, `${key}.json`);
  }

  async lookup(key: string): Promise<DabCatalog | undefined> {
    const path = this.path(key);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CACHE_BYTES) {
        throw new LocalDeviceError("dab_cache_unavailable", "DAB cache entry is not a bounded regular file");
      }
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      return value as DabCatalog;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
      if (error instanceof LocalDeviceError) throw error;
      throw new LocalDeviceError("dab_cache_unavailable", "DAB cache could not be read");
    }
  }

  async register(key: string, value: DabCatalog): Promise<void> {
    const path = this.path(key);
    const payload = JSON.stringify(value);
    if (Buffer.byteLength(payload, "utf8") > MAX_CACHE_BYTES) {
      throw new LocalDeviceError("dab_cache_unavailable", "DAB cache entry exceeded its size limit");
    }
    const temporary = join(this.directory, `.${key}-${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const directoryInfo = await lstat(this.directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
        throw new LocalDeviceError("dab_cache_unavailable", "DAB cache directory is not a regular directory");
      }
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      if (error instanceof LocalDeviceError) throw error;
      throw new LocalDeviceError("dab_cache_unavailable", "DAB cache could not be persisted");
    }
  }
}
