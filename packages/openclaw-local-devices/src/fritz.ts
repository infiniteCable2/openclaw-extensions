import { createHash, pbkdf2 } from "node:crypto";
import { promisify } from "node:util";
import type { DeviceAction, DeviceBackend, DeviceStatus, FritzDeviceConfig } from "./types.js";
import { LocalDeviceError } from "./types.js";

const ZERO_SID = "0000000000000000";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PBKDF2_ITERATIONS = 1_000_000;
const pbkdf2Async = promisify(pbkdf2);

type FetchImplementation = typeof fetch;

function xmlValue(xml: string, tag: string): string | undefined {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, "i"));
  return match?.[1];
}

function decodeSalt(value: string): Buffer {
  if (!/^(?:[A-Fa-f0-9]{2}){8,64}$/.test(value)) {
    throw new LocalDeviceError("fritz_challenge", "FRITZ!Box returned an invalid PBKDF2 salt");
  }
  return Buffer.from(value, "hex");
}

export async function buildFritzChallengeResponse(challenge: string, password: string): Promise<string> {
  const parts = challenge.split("$");
  if (parts[0] === "2" && parts.length === 5) {
    const iteration1 = Number(parts[1]);
    const salt1 = decodeSalt(parts[2] ?? "");
    const iteration2 = Number(parts[3]);
    const salt2Hex = parts[4] ?? "";
    const salt2 = decodeSalt(salt2Hex);
    if (
      !Number.isSafeInteger(iteration1) ||
      !Number.isSafeInteger(iteration2) ||
      iteration1 < 1 ||
      iteration2 < 1 ||
      iteration1 > MAX_PBKDF2_ITERATIONS ||
      iteration2 > MAX_PBKDF2_ITERATIONS
    ) {
      throw new LocalDeviceError("fritz_challenge", "FRITZ!Box returned an invalid PBKDF2 challenge");
    }
    const first = await pbkdf2Async(Buffer.from(password, "utf8"), salt1, iteration1, 32, "sha256");
    const second = await pbkdf2Async(first, salt2, iteration2, 32, "sha256");
    return `${salt2Hex}$${second.toString("hex")}`;
  }
  if (!/^[A-Fa-f0-9]{8,64}$/.test(challenge)) {
    throw new LocalDeviceError("fritz_challenge", "FRITZ!Box returned an invalid legacy challenge");
  }
  const digest = createHash("md5")
    .update(Buffer.from(`${challenge}-${password}`, "utf16le"))
    .digest("hex");
  return `${challenge}-${digest}`;
}

async function readBounded(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new LocalDeviceError("fritz_response", "FRITZ!Box response exceeded its size limit");
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new LocalDeviceError("fritz_response", "FRITZ!Box response exceeded its size limit");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LocalDeviceError("fritz_response", "FRITZ!Box returned invalid UTF-8");
  }
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

type FritzUnit = {
  isConnected?: unknown;
  interfaces?: {
    onOffInterface?: {
      active?: unknown;
      outletState?: unknown;
      isLockedDeviceLocal?: unknown;
      isLockedDeviceApi?: unknown;
    };
    multimeterInterface?: {
      power?: unknown;
    };
  };
};

function parseUnitStatus(device: FritzDeviceConfig, value: unknown): DeviceStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalDeviceError("fritz_response", "FRITZ!Box returned an invalid unit");
  }
  const unit = value as FritzUnit;
  const onOff = unit.interfaces?.onOffInterface;
  if (!onOff || typeof onOff.active !== "boolean") {
    throw new LocalDeviceError("fritz_capability", "Configured FRITZ! device has no switch interface");
  }
  const rawPower = unit.interfaces?.multimeterInterface?.power;
  const powerWatts =
    typeof rawPower === "number" && Number.isFinite(rawPower) && rawPower >= 0
      ? rawPower / 1000
      : undefined;
  return {
    id: device.id,
    name: device.name,
    provider: "fritz",
    available: unit.isConnected === true,
    power: onOff.active ? "on" : "off",
    ...(powerWatts === undefined ? {} : { powerWatts }),
  };
}

export class FritzSmartHomeBackend implements DeviceBackend {
  readonly provider = "fritz" as const;
  private sid: string | undefined;
  private loginInFlight: Promise<string> | undefined;

  constructor(
    private readonly device: FritzDeviceConfig,
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string,
    private readonly timeoutMs: number,
    private readonly fetchImpl: FetchImplementation = fetch,
  ) {}

  private async request(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<{ response: Response; body: string }> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        redirect: "error",
        signal: combinedSignal(signal, this.timeoutMs),
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new LocalDeviceError("cancelled", "FRITZ! request was cancelled");
      }
      throw new LocalDeviceError("fritz_transport", "FRITZ!Box request failed");
    }
    return { response, body: await readBounded(response) };
  }

  private async login(signal?: AbortSignal): Promise<string> {
    if (this.sid) {
      return this.sid;
    }
    if (this.loginInFlight) {
      return await this.loginInFlight;
    }
    this.loginInFlight = this.performLogin(signal).finally(() => {
      this.loginInFlight = undefined;
    });
    return await this.loginInFlight;
  }

  private async performLogin(signal?: AbortSignal): Promise<string> {
    const first = await this.request("/login_sid.lua?version=2", { method: "GET" }, signal);
    if (!first.response.ok) {
      throw new LocalDeviceError("fritz_login", "FRITZ!Box login challenge failed");
    }
    const existingSid = xmlValue(first.body, "SID");
    if (existingSid && existingSid !== ZERO_SID) {
      this.sid = existingSid;
      return existingSid;
    }
    const blockTime = Number(xmlValue(first.body, "BlockTime") ?? "0");
    if (Number.isFinite(blockTime) && blockTime > 0) {
      throw new LocalDeviceError("fritz_login_blocked", "FRITZ!Box temporarily blocks another login attempt");
    }
    const challenge = xmlValue(first.body, "Challenge");
    if (!challenge) {
      throw new LocalDeviceError("fritz_challenge", "FRITZ!Box did not return a login challenge");
    }
    const form = new URLSearchParams({
      username: this.username,
      response: await buildFritzChallengeResponse(challenge, this.password),
    });
    const second = await this.request(
      "/login_sid.lua?version=2",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
      },
      signal,
    );
    if (!second.response.ok) {
      throw new LocalDeviceError("fritz_login", "FRITZ!Box login failed");
    }
    const sid = xmlValue(second.body, "SID");
    if (!sid || sid === ZERO_SID || !/^[A-Fa-f0-9]{16}$/.test(sid)) {
      throw new LocalDeviceError("fritz_login", "FRITZ!Box rejected its configured credentials");
    }
    this.sid = sid;
    return sid;
  }

  private async apiRequest(
    method: "GET" | "PUT",
    body: Record<string, unknown> | undefined,
    signal?: AbortSignal,
    allowRelogin = true,
  ): Promise<unknown> {
    const sid = await this.login(signal);
    const path = `/api/v0/smarthome/overview/units/${encodeURIComponent(this.device.uid)}`;
    const result = await this.request(
      path,
      {
        method,
        headers: {
          Authorization: sid,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      signal,
    );
    let decoded: unknown;
    if (result.body.trim()) {
      try {
        decoded = JSON.parse(result.body);
      } catch {
        throw new LocalDeviceError("fritz_response", "FRITZ!Box returned invalid JSON");
      }
    }
    const permissionDenied =
      result.response.status === 401 ||
      result.response.status === 403 ||
      (decoded !== null &&
        typeof decoded === "object" &&
        !Array.isArray(decoded) &&
        Array.isArray((decoded as { errors?: unknown }).errors) &&
        (decoded as { errors: Array<{ code?: unknown }> }).errors.some((error) => error?.code === 3001));
    if (permissionDenied && allowRelogin) {
      this.sid = undefined;
      return await this.apiRequest(method, body, signal, false);
    }
    if (!result.response.ok || permissionDenied) {
      throw new LocalDeviceError("fritz_api", "FRITZ! Smart Home request was rejected");
    }
    return decoded;
  }

  async status(signal?: AbortSignal): Promise<DeviceStatus> {
    return parseUnitStatus(this.device, await this.apiRequest("GET", undefined, signal));
  }

  async control(action: DeviceAction, signal?: AbortSignal): Promise<DeviceStatus> {
    if (action.type !== "turn_on" && action.type !== "turn_off") {
      throw new LocalDeviceError("unsupported_action", "FRITZ! socket supports only turn_on and turn_off");
    }
    const before = await this.apiRequest("GET", undefined, signal);
    if (!before || typeof before !== "object" || Array.isArray(before)) {
      throw new LocalDeviceError("fritz_response", "FRITZ!Box returned an invalid unit");
    }
    const onOff = (before as FritzUnit).interfaces?.onOffInterface;
    if (!onOff || typeof onOff.active !== "boolean") {
      throw new LocalDeviceError("fritz_capability", "Configured FRITZ! device has no switch interface");
    }
    if ((before as FritzUnit).isConnected !== true) {
      throw new LocalDeviceError("device_unavailable", "Configured FRITZ! device is not connected");
    }
    if (onOff?.isLockedDeviceApi === true || onOff?.isLockedDeviceLocal === true) {
      throw new LocalDeviceError("device_locked", "Configured FRITZ! device is locked against switching");
    }
    await this.apiRequest(
      "PUT",
      { interfaces: { onOffInterface: { active: action.type === "turn_on" } } },
      signal,
    );
    return await this.status(signal);
  }
}
