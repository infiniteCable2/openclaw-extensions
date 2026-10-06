import { afterEach, describe, expect, it, vi } from "vitest";
import { DenonCeolBackend } from "./denon.js";

describe("Denon CEOL receiver", () => {
  afterEach(() => vi.unstubAllGlobals());

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
