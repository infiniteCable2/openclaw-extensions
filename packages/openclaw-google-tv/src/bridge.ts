import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TvConfig, TvDevice } from "./config.js";

export type BridgeRequest = {
  operation: "status" | "key" | "power" | "app" | "text" | "screenshot" | "ui";
  key?: string;
  power?: "on" | "off";
  app?: { via: "remote" | "adb"; locator: string };
  text?: string;
};

const helperPath = fileURLToPath(new URL("../runtime/tv_bridge.py", import.meta.url));

export function callBridge(config: TvConfig, device: TvDevice, request: BridgeRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const child = spawn(config.pythonPath, [helperPath], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let output = "";
    let exceeded = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, config.requestTimeoutMs);
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (part: string) => {
      output += part;
      if (output.length > 5_000_000) { exceeded = true; child.kill(); }
    });
    child.on("error", () => { /* reported by close */ });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return resolve({ ok: false, code: "cancelled" });
      if (timedOut) return resolve({ ok: false, code: "timeout" });
      if (exceeded) return resolve({ ok: false, code: "output_limit" });
      if (code !== 0) return resolve({ ok: false, code: "bridge_unavailable" });
      try {
        const parsed: unknown = JSON.parse(output);
        return resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { ok: false, code: "invalid_bridge_result" });
      } catch {
        return resolve({ ok: false, code: "invalid_bridge_result" });
      }
    });
    child.stdin.on("error", () => { /* child exit is handled above */ });
    child.stdin.end(JSON.stringify({ ...request, device, timeoutMs: config.requestTimeoutMs }));
  });
}
