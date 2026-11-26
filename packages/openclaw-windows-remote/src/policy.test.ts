import { describe, expect, it } from "vitest";
import { inputPlan, privateIpv4 } from "./index.js";
import { pairingCode } from "./transport.js";

describe("assigned Windows access", () => {
  it("admits RFC1918 IPv4 endpoints only", () => {
    for (const host of ["10.25.10.1", "172.16.22.9", "172.31.4.5", "192.168.50.20"]) {
      expect(privateIpv4(host)).toBe(true);
    }
    for (const host of ["127.0.0.1", "::1", "169.254.169.254", "172.32.8.9", "192.168.1.256", "example.test"]) {
      expect(privateIpv4(host)).toBe(false);
    }
  });

  it("maps one bounded desktop action and rejects free-form commands", () => {
    expect(inputPlan({ action: "shortcut", shortcut: "explorer" })).toEqual({
      name: "Shortcut", arguments: { shortcut: "win+e" },
    });
    expect(inputPlan({ action: "click", x: 100, y: -200, clicks: 2 })).toEqual({
      name: "Click", arguments: { loc: [100, -200], button: "left", clicks: 2 },
    });
    expect(inputPlan({ action: "click", element: 42 })).toEqual({
      name: "Click", arguments: { label: 42, button: "left", clicks: 1 },
    });
    for (const request of [
      { action: "shortcut", shortcut: "win+r" }, { action: "shortcut", shortcut: "toString" },
      { action: "click", x: 0, y: 0, clicks: 3 }, { action: "scroll", x: 0, y: 0, direction: "down", steps: 10 },
      { action: "Type", text: "text" },
    ]) expect(() => inputPlan(request)).toThrow();
  });

  it("keeps leading zeroes when normalizing the spoken code", () => {
    expect(pairingCode("012 345 678")).toBe("012345678");
    expect(() => pairingCode("01234567")).toThrow();
    expect(() => pairingCode(123456789)).toThrow();
  });

  it("types through the selected field without submitting and sends explicit keystrokes separately", () => {
    expect(inputPlan({ action: "type", element: 37, text: "Grüße (A+B)", clear: true })).toEqual({
      name: "Type",
      arguments: { label: 37, text: "Grüße (A+B)", clear: true, caret_position: "idle", press_enter: false },
    });
    expect(inputPlan({ action: "type", x: 120, y: 50, text: "", clear: true }).arguments).toMatchObject({
      loc: [120, 50], clear: true, press_enter: false,
    });
    expect(inputPlan({ action: "key", key: "enter" })).toEqual({ name: "Shortcut", arguments: { shortcut: "enter" } });
    expect(inputPlan({ action: "shortcut", shortcut: "address_bar" })).toEqual({ name: "Shortcut", arguments: { shortcut: "ctrl+l" } });
    for (const request of [
      { action: "type", text: "text" },
      { action: "type", element: 37, x: 120, y: 50, text: "text" },
      { action: "type", element: 37, text: "text\n" },
      { action: "type", element: 37, text: "a".repeat(1025) },
      { action: "key", key: "ctrl+shift+escape" },
    ]) expect(() => inputPlan(request)).toThrow();
  });
});
