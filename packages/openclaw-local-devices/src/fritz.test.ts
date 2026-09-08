import { describe, expect, it, vi } from "vitest";
import { buildFritzChallengeResponse, FritzSmartHomeBackend } from "./fritz.js";

const device = { id: "floor_lamp", name: "Floor lamp", uid: "12345 6789012" };

describe("FRITZ! Smart Home REST client", () => {
  it("implements both documented SID challenge variants", async () => {
    await expect(buildFritzChallengeResponse("12345678", "password")).resolves.toBe(
      "12345678-cdea8a0a6d49244782987372d32817ff",
    );
    await expect(
      buildFritzChallengeResponse(
        "2$1000$0011223344556677$1000$8899aabbccddeeff",
        "password",
      ),
    ).resolves.toBe(
      "8899aabbccddeeff$ed15f174e80797fe17a69026daed5fd36b05e0c714605b0ef0eb93cf76d621cf",
    );
  });

  it("rejects malformed or excessive PBKDF2 work factors", async () => {
    await expect(
      buildFritzChallengeResponse(
        "2$1000001$0011223344556677$1000$8899aabbccddeeff",
        "password",
      ),
    ).rejects.toThrow(/invalid PBKDF2 challenge/);
    await expect(
      buildFritzChallengeResponse("2$1000$xyz$1000$8899aabbccddeeff", "password"),
    ).rejects.toThrow(/invalid PBKDF2 salt/);
  });

  it("logs in, reads a configured unit, and keeps identifiers out of the result", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          "<SessionInfo><SID>0000000000000000</SID><Challenge>12345678</Challenge><BlockTime>0</BlockTime></SessionInfo>",
        ),
      )
      .mockResolvedValueOnce(new Response("<SessionInfo><SID>abcdef0123456789</SID></SessionInfo>"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            isConnected: true,
            interfaces: {
              onOffInterface: { active: true, outletState: "valid" },
              multimeterInterface: { power: 1200 },
            },
          }),
        ),
      );
    const backend = new FritzSmartHomeBackend(
      device,
      "http://fritz.box",
      "operator",
      "password",
      5000,
      fetchImpl,
    );

    await expect(backend.status()).resolves.toEqual({
      id: "floor_lamp",
      name: "Floor lamp",
      provider: "fritz",
      available: true,
      power: "on",
      powerWatts: 1.2,
    });
    expect(fetchImpl.mock.calls[2]?.[0]).toBe(
      "http://fritz.box/api/v0/smarthome/overview/units/12345%206789012",
    );
    expect(new Headers(fetchImpl.mock.calls[2]?.[1]?.headers).get("Authorization")).toBe(
      "abcdef0123456789",
    );
  });

  it("rejects non-switch actions before sending a control request", async () => {
    const backend = new FritzSmartHomeBackend(
      device,
      "http://fritz.box",
      "operator",
      "password",
      5000,
      vi.fn<typeof fetch>(),
    );
    await expect(backend.control({ type: "set_brightness", brightness: 50 })).rejects.toThrow(
      /only turn_on and turn_off/,
    );
  });

  it("bounds a streamed response even when content-length is absent", async () => {
    const chunk = new Uint8Array(64 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 17; index += 1) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    const backend = new FritzSmartHomeBackend(
      device,
      "http://fritz.box",
      "operator",
      "password",
      5000,
      vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)),
    );

    await expect(backend.status()).rejects.toThrow(/exceeded its size limit/);
  });
});
