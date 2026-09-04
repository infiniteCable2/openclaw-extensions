import { describe, expect, it } from "vitest";
import { requireLoopbackBaseUrl, resolveLoopbackBaseUrl } from "./local-url.js";

describe("loopback base URLs", () => {
  it.each([
    ["http://127.0.0.1:8000/v1/", "http://127.0.0.1:8000/v1"],
    ["http://127.0.0.42:8000/v1", "http://127.0.0.42:8000/v1"],
    ["https://[::1]:8443/v1", "https://[::1]:8443/v1"],
  ])("accepts %s", (input, expected) => {
    expect(resolveLoopbackBaseUrl(input)).toBe(expected);
  });

  it.each([
    "http://192.168.1.10:8000/v1",
    "https://example.test/v1",
    "http://localhost:8000/v1",
    "http://user:password@127.0.0.1:8000/v1",
    "file:///tmp/socket",
    "not a URL",
    "",
    undefined,
  ])("rejects non-loopback input %s", (input) => {
    expect(resolveLoopbackBaseUrl(input)).toBeUndefined();
  });

  it("fails closed when a base URL is missing", () => {
    expect(() => requireLoopbackBaseUrl(undefined, "Test provider")).toThrow(
      "Test provider requires an explicit loopback HTTP(S) baseUrl",
    );
  });
});
