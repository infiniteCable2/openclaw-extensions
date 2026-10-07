import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDabCatalog } from "./dab-catalog.js";
import { decodeHeosFmFrequency, DenonCeolBackend, encodeFmFrequency, telnetBand } from "./denon.js";
import { LocalDeviceError } from "./types.js";

const emptyStore = { lookup: async () => undefined, register: async () => undefined };

describe("Denon CEOL receiver", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the receiver's MHz-times-100 FM write scale", () => {
    expect(encodeFmFrequency(91.4)).toBe("009140");
    expect(encodeFmFrequency(103.4)).toBe("010340");
    expect(() => encodeFmFrequency(10.34)).toThrow(/FM frequency/);
  });

  it("reads FM frequency from HEOS rather than stale Telnet status", () => {
    expect(decodeHeosFmFrequency("FM 103.40MHz")).toBe(103.4);
    expect(decodeHeosFmFrequency("FM 104,60 MHz")).toBe(104.6);
    expect(decodeHeosFmFrequency("FM 91.45MHz")).toBe(91.45);
    expect(decodeHeosFmFrequency("FM 10.34MHz")).toBeUndefined();
    expect(decodeHeosFmFrequency("BRF 91.4")).toBeUndefined();
    expect(decodeHeosFmFrequency("Denon CEOL - Tuner")).toBeUndefined();
  });

  it("finds FM even if a tuning-mode event follows the band event", () => {
    expect(telnetBand(["TMANFM", "TMANAUTO"])).toBe("fm");
    expect(telnetBand(["TMDA", "TMANMANUAL"])).toBe("dab");
  });

  it("rejects an unsupported source transport before any receiver I/O", async () => {
    const backend = new DenonCeolBackend({
      id: "receiver_living_room",
      name: "Receiver (Wohnzimmer)",
      address: "127.0.0.1",
    }, 100, emptyStore);
    await expect(backend.control({ type: "select_source", source: "optical1", via: "telnet" }))
      .rejects.toMatchObject({ code: "unsupported_method" });
  });

  it("reads the DAB band from UPnP when Denon control is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = String(init.body);
      const payload = body.includes("GetTunerConfig")
        ? "<TunerConfig>&lt;TunerConfig&gt;&lt;bandMode&gt;DAB&lt;/bandMode&gt;&lt;/TunerConfig&gt;</TunerConfig>"
        : "<Response/>";
      return new Response(payload, { status: 200 });
    }));
    const backend = new DenonCeolBackend({
      id: "receiver_living_room",
      name: "Receiver (Wohnzimmer)",
      address: "127.0.0.1",
    }, 100, emptyStore);
    const status = await backend.status();
    expect(status.power).toBe("unknown");
    expect(status.receiver?.band).toBe("dab");
    expect(status.receiver?.dabCatalog.state).toBe("missing");
  });

  it("does not touch the receiver when a DAB list is missing or stale", async () => {
    const device = { id: "receiver", name: "Receiver", address: "127.0.0.1" };
    const missing = new DenonCeolBackend(device, 100, emptyStore);
    await expect(missing.control({ type: "select_dab_station", station: "dab_001" }))
      .rejects.toMatchObject({ code: "dab_catalog_missing" });
    const stale = buildDabCatalog("127.0.0.1", ["ENERGY B"], 1, 0, true, 1234);
    const backend = new DenonCeolBackend(device, 100, {
      lookup: async () => ({ ...stale, stale: true }), register: async () => undefined,
    });
    await expect(backend.control({ type: "select_dab_station", station: "dab_001" }))
      .rejects.toMatchObject({ code: "dab_catalog_stale" });
  });

  it("keeps receiver status readable when the station cache is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<Response/>", { status: 200 })));
    const backend = new DenonCeolBackend(
      { id: "receiver", name: "Receiver", address: "127.0.0.1" },
      100,
      {
        lookup: async () => { throw new LocalDeviceError("dab_cache_unavailable", "unreadable cache"); },
        register: async () => undefined,
      },
    );
    const status = await backend.status();
    expect(status.receiver?.dabCatalog.state).toBe("unavailable");
    expect(status.receiver?.dabCatalog.guidance).toMatch(/administrator/);
  });
});
