import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDabCatalog } from "./dab-catalog.js";
import { DabFileCatalogStore } from "./dab-file-store.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("DAB catalog file cache", () => {
  it("survives a fresh store instance and updates atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-dab-catalog-test-"));
    temporaryRoots.push(root);
    const directory = join(root, "catalog");
    const first = new DabFileCatalogStore(directory);
    const catalog = buildDabCatalog("192.168.1.57", ["ENERGY B", "Jazz"], 2, 0, true, 1234);
    expect(await first.lookup("receiver")).toBeUndefined();
    await first.register("receiver", catalog);
    expect(await new DabFileCatalogStore(directory).lookup("receiver")).toEqual(catalog);
    await first.register("receiver", { ...catalog, stale: true });
    expect((await first.lookup("receiver"))?.stale).toBe(true);
    expect((await stat(join(directory, "receiver.json"))).isFile()).toBe(true);
  });

  it("rejects an invalid cache key before touching the filesystem", async () => {
    const root = await mkdtemp(join(tmpdir(), "openclaw-dab-catalog-test-"));
    temporaryRoots.push(root);
    const store = new DabFileCatalogStore(root);
    await expect(store.lookup("../escape")).rejects.toMatchObject({ code: "invalid_request" });
  });
});
