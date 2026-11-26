import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { request } from "node:https";
import { checkServerIdentity } from "node:tls";
import { fileURLToPath } from "node:url";

const maxResponse = 12 * 1024 * 1024;
const maxLeaseMs = 15 * 60_000;
const supportedVersions = new Set(["2025-06-18", "2025-11-25"]);

export class RemoteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export type Endpoint = { host: string; port: number };
export type Lease = Endpoint & { certificate: string; token: string; expiresAt: number };
type Json = Record<string, unknown>;
export const leaseRequired = () => new RemoteError("pairing_required", "Ask the user for the fresh nine-digit access code displayed by Windows-MCP on this computer. Enter it in windows_remote_status in this private conversation.");
const unavailable = () => new RemoteError("device_unavailable", "The assigned Windows-MCP connection could not be reached or verified.");

export function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

export function pairingCode(value: unknown): string {
  const code = typeof value === "string" && value.length <= 20 ? value.replace(/[ -]/g, "") : "";
  if (!/^[0-9]{9}$/.test(code)) throw new RemoteError("invalid_pairing_code", "A Windows-MCP access code has nine digits.");
  return code;
}

export async function pair(
  endpoint: Endpoint, code: string, signal: AbortSignal, authorize: () => void,
): Promise<Lease> {
  signal.throwIfAborted();
  authorize();
  const helper = fileURLToPath(new URL("../pair.py", import.meta.url));
  const crypto = fileURLToPath(new URL("../libcrypto.so", import.meta.url));
  return new Promise((resolve, reject) => {
    const failed = () => new RemoteError("pairing_failed", "The code was expired, incorrect, or the assigned PC was unavailable. Ask for a fresh code when it is ready.");
    const child = spawn("/usr/bin/python3", [
      "-I", "-B", helper, "--host", endpoint.host, "--port", String(endpoint.port), "--crypto-library", crypto,
    ], { signal, env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let length = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 8192) {
        child.kill();
        reject(failed());
      } else {
        chunks.push(chunk);
      }
    });
    child.stdin.on("error", () => reject(failed()));
    child.on("error", () => reject(failed()));
    child.on("close", (status) => {
      if (status !== 0) {
        reject(failed());
        return;
      }
      try {
        authorize();
        signal.throwIfAborted();
        const { certificate, token } = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (typeof certificate !== "string" || certificate.length > 4096 ||
            typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) throw failed();
        const cert = new X509Certificate(certificate);
        if (cert.checkIP(endpoint.host) !== endpoint.host) throw failed();
        resolve({ ...endpoint, certificate: cert.toString(), token, expiresAt: Date.now() + maxLeaseMs });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(code + "\n");
  });
}

type Reply = { session?: string; result?: Json };

function parseReply(payload: string, id: number): Json | undefined {
  let data: Json;
  try {
    data = object(JSON.parse(payload));
  } catch {
    throw unavailable();
  }
  if (data.id !== id) return undefined;
  if (data.error || data.jsonrpc !== "2.0" || !data.result || typeof data.result !== "object") {
    throw unavailable();
  }
  return object(data.result);
}

export class WindowsConnection {
  private sequence = 0;
  private version?: string;
  private session?: string;
  private readonly fingerprint: string;

  constructor(private readonly lease: Lease) {
    this.fingerprint = new X509Certificate(lease.certificate).fingerprint256;
  }

  async start(signal: AbortSignal, authorize: () => void): Promise<void> {
    const initialize = await this.send("POST", "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "OpenClaw Windows Remote", version: "0.1.0" },
    }, signal, authorize);
    const version = initialize.result?.protocolVersion;
    if (typeof version !== "string" || !supportedVersions.has(version) || !initialize.session ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(initialize.session)) throw unavailable();
    this.session = initialize.session;
    this.version = version;
    await this.send("POST", "notifications/initialized", {}, signal, authorize);
  }

  async call(name: string, args: Json, signal: AbortSignal, authorize: () => void): Promise<Json> {
    if (!this.session) throw unavailable();
    const response = await this.send("POST", "tools/call", { name, arguments: args }, signal, authorize);
    if (!response.result) throw unavailable();
    return response.result;
  }

  async close(): Promise<void> {
    if (!this.session) return;
    try {
      await this.send("DELETE", undefined, {}, AbortSignal.timeout(2500), () => {});
    } finally {
      this.session = undefined;
    }
  }

  private send(
    method: "POST" | "DELETE",
    rpc: string | undefined,
    params: Json,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<Reply> {
    const id = rpc && !rpc.startsWith("notifications/") ? ++this.sequence : undefined;
    const payload = rpc ? JSON.stringify({ jsonrpc: "2.0", ...(id && {id}), method: rpc, params }) : undefined;
    const withAuthority = AsyncLocalStorage.snapshot();
    return new Promise((resolve, reject) => {
      try {
        signal.throwIfAborted();
        authorize();
        if (method !== "DELETE" && Date.now() >= this.lease.expiresAt) throw leaseRequired();
      } catch (error) {
        reject(error);
        return;
      }
      const req = request({
        method, hostname: this.lease.host, port: this.lease.port, path: "/mcp",
        ca: this.lease.certificate, rejectUnauthorized: true, minVersion: "TLSv1.2", agent: false,
        checkServerIdentity: (host, cert) => checkServerIdentity(host, cert) ||
          (cert.fingerprint256 === this.fingerprint ? undefined : new Error("certificate mismatch")),
        signal,
        headers: {
          Authorization: `Bearer ${this.lease.token}`,
          Accept: "application/json, text/event-stream",
          ...(payload && { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }),
          ...(this.session && { "Mcp-Session-Id": this.session }),
          ...(this.version && { "MCP-Protocol-Version": this.version }),
        },
      }, (res) => {
        const code = res.statusCode ?? 0;
        if (code < 200 || code >= 300) {
          res.destroy();
          reject([401, 403, 404].includes(code) ? leaseRequired() : unavailable());
          return;
        }
        if (id === undefined) {
          res.destroy();
          resolve({});
          return;
        }
        let size = 0;
        let pending = "";
        const streamed = res.headers["content-type"]?.startsWith("text/event-stream") ?? false;
        const responseId = res.headers["mcp-session-id"];
        const session = typeof responseId === "string" ? responseId : undefined;
        function deliver(data: string): boolean {
          const result = parseReply(data, id!);
          if (!result) return false;
          resolve({ session, result });
          return true;
        }
        res.on("error", () => reject(unavailable()));
        res.on("data", (fragment: string) => {
          try {
            size += Buffer.byteLength(fragment);
            if (size > maxResponse) throw unavailable();
            pending += fragment;
            if (!streamed) return;
            let boundary = /\r?\n\r?\n/.exec(pending);
            while (boundary) {
              const event = pending.slice(0, boundary.index);
              pending = pending.slice(boundary.index + boundary[0].length);
              const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trimStart()).join("\n");
              if (data && deliver(data)) {
                res.destroy();
                return;
              }
              boundary = /\r?\n\r?\n/.exec(pending);
            }
          } catch (error) {
            res.destroy();
            reject(error);
          }
        });
        res.setEncoding("utf8");
        res.on("end", () => {
          try {
            if (streamed || !deliver(pending)) reject(unavailable());
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on("error", () => reject(unavailable()));
      // Recheck again after the TLS handshake and before the request body can be sent.
      req.on("socket", (socket) => {
        socket.prependOnceListener("secureConnect", () => withAuthority(() => {
          try {
            authorize();
            signal.throwIfAborted();
            if (method !== "DELETE" && Date.now() >= this.lease.expiresAt) throw leaseRequired();
          } catch (error) {
            reject(error);
            req.destroy();
          }
        }));
      });
      req.end(payload);
    });
  }
}
