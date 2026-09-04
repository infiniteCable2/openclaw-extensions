import { isIP } from "node:net";

function isLoopbackIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) {
    return false;
  }
  const firstOctet = Number.parseInt(hostname.split(".", 1)[0] ?? "", 10);
  return firstOctet === 127;
}

export function resolveLoopbackBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === "[::1]" || isLoopbackIpv4(hostname);
    if (
      !loopback ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return undefined;
    }
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url.toString().replace(/\/$/u, "");
  } catch {
    return undefined;
  }
}

export function requireLoopbackBaseUrl(value: unknown, surface: string): string {
  const baseUrl = resolveLoopbackBaseUrl(value);
  if (!baseUrl) {
    throw new Error(`${surface} requires an explicit loopback HTTP(S) baseUrl`);
  }
  return baseUrl;
}
