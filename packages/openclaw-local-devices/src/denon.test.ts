import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFmFrequency, DenonCeolBackend, encodeFmFrequency, telnetBand } from "./denon.js";

describe("Denon CEOL receiver", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the receiver's MHz-times-100 FM wire scale", () => {
    expect(decodeFmFrequency("TFAN009140")).toBe(91.4);
    expect(decodeFmFrequency("TFAN010340")).toBe(103.4);
    expect(decodeFmFrequency("TFAN103400")).toBeUndefined();
    expect(encodeFmFrequency(91.4)).toBe("009140");
    expect(encodeFmFrequency(103.4)).toBe("010340");
    expect(() => encodeFmFrequency(10.34)).toThrow(/FM frequency/);
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
      dabStations: [],
    }, 100);
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
      dabStations: [],
    }, 100);
    const status = await backend.status();
    expect(status.power).toBe("unknown");
    expect(status.receiver?.band).toBe("dab");
  });
});
