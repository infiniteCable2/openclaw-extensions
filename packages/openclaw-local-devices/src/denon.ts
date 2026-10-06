import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { buildDabCatalog, enableLegacyDabNameSelection, findRepeatedDabCycle, isValidDabCatalog, MAX_DAB_STEPS, type DabCatalog, type DabCatalogStore } from "./dab-catalog.js";
import { moveDabWithRecovery, navigateDabByName } from "./dab-navigation.js";
import type { DenonDeviceConfig, DeviceBackend, DeviceStatus, LocalDeviceAction } from "./types.js";
import { LocalDeviceError } from "./types.js";

const ACT = "urn:schemas-denon-com:service:ACT:1";
const RENDER = "urn:schemas-upnp-org:service:RenderingControl:1";
const INPUTS = {
  cd: "inputs/cd",
  tuner: "inputs/tuner",
  optical1: "inputs/optical_in_1",
  optical2: "inputs/optical_in_2",
  analog: "inputs/analog_in_1",
} as const;
const MAX_RESPONSE_BYTES = 64 * 1024;

type Interface = "telnet" | "heos" | "upnp";
type Response = { heos?: { command?: string; result?: string; message?: string }; payload?: unknown };

function abortSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function xmlValue(xml: string, name: string): string | undefined {
  return xml.match(new RegExp(`<(?:(?:\\w+):)?${name}>([^<]{0,256})</(?:(?:\\w+):)?${name}>`))?.[1];
}

/** One short lived connection per command. A connection failure is the only safe automatic retry boundary. */
async function tcpCommand(
  address: string,
  port: number,
  command: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  complete: (lines: readonly string[]) => boolean,
): Promise<string[]> {
  return await new Promise<string[]>((resolve, reject) => {
    const socket = net.createConnection({ host: address, port });
    const lines: string[] = [];
    let buffer = "";
    let sent = false;
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      error ? reject(error) : resolve(lines);
    };
    const onAbort = () => finish(new LocalDeviceError("cancelled", "Receiver request was cancelled"));
    const timer = setTimeout(() =>
      finish(new LocalDeviceError(sent ? "receiver_unconfirmed" : "receiver_unavailable", "Receiver did not answer in time")), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    socket.on("connect", () => {
      sent = true;
      socket.write(command);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > MAX_RESPONSE_BYTES) {
        finish(new LocalDeviceError("receiver_response", "Receiver response exceeded its size limit"));
        return;
      }
      const parts = buffer.split(/[\r\n]+/);
      buffer = parts.pop() ?? "";
      lines.push(...parts.filter(Boolean));
      if (complete(lines)) finish();
    });
    socket.on("error", () => finish(new LocalDeviceError(sent ? "receiver_unconfirmed" : "receiver_unavailable", "Receiver connection failed")));
    socket.on("close", () => {
      if (!finished) finish(new LocalDeviceError(sent ? "receiver_unconfirmed" : "receiver_unavailable", "Receiver closed the connection"));
    });
  });
}

async function telnet(
  device: DenonDeviceConfig,
  command: string,
  expected: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const lines = await tcpCommand(device.address, 23, `${command}\r`, timeoutMs, signal,
      (lines) => lines.some((line) => line.startsWith(expected)));
    return lines.findLast((line) => line.startsWith(expected)) ?? "";
  } catch (error) {
    // A written absolute or relative command may take effect without an immediate event.
    // The caller must inspect the resulting device state rather than resend it.
    if (!command.endsWith("?") && error instanceof LocalDeviceError && error.code === "receiver_unconfirmed") return "";
    throw error;
  }
}

async function telnetSnapshot(device: DenonDeviceConfig, timeoutMs: number, signal?: AbortSignal): Promise<string[]> {
  return await tcpCommand(device.address, 23, "TM?\rTFDA?\rPW?\rMV?\rMU?\rSI?\r", timeoutMs, signal,
    (lines) => {
      if (!["PW", "MV", "MU", "SI"].every((prefix) => lines.some((line) => line.startsWith(prefix)))) return false;
      if (!lines.some((line) => line === "SITUNER")) return true;
      const band = telnetBand(lines);
      return band === "fm" ? true : band === "dab" ? lines.some((line) => line.startsWith("TFDA")) : false;
    });
}

export function telnetBand(lines: readonly string[]): "dab" | "fm" | undefined {
  return lines.some((line) => line === "TMDA") ? "dab"
    : lines.some((line) => line === "TMANFM") ? "fm" : undefined;
}

export function decodeHeosFmFrequency(station: string | undefined): number | undefined {
  const match = station?.match(/^FM\s+(\d{2,3})[.,](\d{1,2})\s*MHz$/i);
  if (!match) return undefined;
  const frequency = Number(`${match[1]}.${match[2].padEnd(2, "0")}`);
  return frequency >= 87.5 && frequency <= 108 ? frequency : undefined;
}

export function encodeFmFrequency(frequencyMHz: number): string {
  if (!Number.isFinite(frequencyMHz) || frequencyMHz < 87.5 || frequencyMHz > 108
      || Math.abs(frequencyMHz * 10 - Math.round(frequencyMHz * 10)) > 1e-6) {
    throw new LocalDeviceError("invalid_request", "FM frequency must be 87.5 to 108 in 0.1 MHz steps");
  }
  return String(Math.round(frequencyMHz * 100)).padStart(6, "0");
}

async function heos(
  device: DenonDeviceConfig,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const path = command.slice("heos://".length).split("?")[0];
  const lines = await tcpCommand(device.address, 1255, `${command}\r\n`, timeoutMs, signal,
    (lines) => lines.some((line) => {
      try {
        const response = JSON.parse(line) as Response;
        return response.heos?.command?.trim() === path && !response.heos.message?.startsWith("command under process");
      } catch { return false; }
    }));
  for (const line of lines.toReversed()) {
    try {
      const response = JSON.parse(line) as Response;
      if (response.heos?.command?.trim() !== path || response.heos.message?.startsWith("command under process")) continue;
      if (response.heos.result !== "success") throw new LocalDeviceError("receiver_rejected", "Receiver rejected the HEOS command");
      return response;
    } catch (error) {
      if (error instanceof LocalDeviceError) throw error;
    }
  }
  throw new LocalDeviceError("receiver_response", "Receiver returned no matching HEOS response");
}

async function soap(
  device: DenonDeviceConfig,
  service: "act" | "render",
  action: string,
  argumentsXml: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const namespace = service === "act" ? ACT : RENDER;
  const path = service === "act" ? "/ACT/control" : "/upnp/control/renderer_dvc/RenderingControl";
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action} xmlns:u="${namespace}">${argumentsXml}</u:${action}></s:Body></s:Envelope>`;
  let response: globalThis.Response;
  try {
    response = await fetch(`http://${device.address}:60006${path}`, {
      method: "POST",
      headers: { "Content-Type": "text/xml", SOAPAction: `"${namespace}#${action}"` },
      body,
      signal: abortSignal(signal, timeoutMs),
    });
  } catch {
    throw new LocalDeviceError("receiver_unavailable", "Receiver UPnP service is unavailable");
  }
  if (!response.ok) throw new LocalDeviceError("receiver_rejected", "Receiver rejected the UPnP action");
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_RESPONSE_BYTES) throw new LocalDeviceError("receiver_response", "Receiver UPnP response is too large");
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new LocalDeviceError("receiver_response", "Receiver UPnP response is too large");
  return text;
}

const renderArgs = "<InstanceID>0</InstanceID><Channel>Master</Channel>";

async function heosPlayerId(device: DenonDeviceConfig, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const players = await heos(device, "heos://player/get_players", timeoutMs, signal);
  const player = Array.isArray(players.payload)
    ? players.payload.map(record).find((item) => item.ip === device.address)
    : undefined;
  const id = player?.pid;
  if ((typeof id !== "number" && typeof id !== "string") || !/^-?\d+$/.test(String(id))) {
    throw new LocalDeviceError("receiver_response", "Configured receiver was absent from HEOS players");
  }
  return String(id);
}

async function currentStation(device: DenonDeviceConfig, timeoutMs: number, signal?: AbortSignal): Promise<string | undefined> {
  const id = await heosPlayerId(device, timeoutMs, signal);
  const response = await heos(device, `heos://player/get_now_playing_media?pid=${id}`, timeoutMs, signal);
  const media = record(response.payload);
  return typeof media.station === "string" && media.station.length <= 80 && !media.station.startsWith("Denon CEOL - ")
    ? media.station : undefined;
}

async function playbackState(device: DenonDeviceConfig, timeoutMs: number, signal?: AbortSignal): Promise<"play" | "pause" | "stop" | undefined> {
  const id = await heosPlayerId(device, timeoutMs, signal);
  const response = await heos(device, `heos://player/get_play_state?pid=${id}`, timeoutMs, signal);
  const state = response.heos?.message?.match(/(?:^|&)state=(play|pause|stop)(?:&|$)/)?.[1];
  return state === "play" || state === "pause" || state === "stop" ? state : undefined;
}

const alternatives: NonNullable<DeviceStatus["receiver"]>["alternatives"] = {
  volume: ["telnet", "upnp"],
  mute: ["telnet", "upnp", "heos"],
  source: ["heos", "telnet (CD/Tuner)"],
  radioBand: ["telnet", "upnp"],
  dabStation: ["telnet; HEOS confirms station"],
  tone: ["upnp"],
  playback: ["heos"],
};

export class DenonCeolBackend implements DeviceBackend {
  readonly provider = "denon" as const;
  private scanningDab = false;
  private activeControls = 0;

  constructor(
    readonly configuredDevice: DenonDeviceConfig,
    private readonly timeoutMs: number,
    private readonly catalogStore: DabCatalogStore,
  ) {}

  private async cachedCatalog(): Promise<DabCatalog | undefined> {
    const value = await this.catalogStore.lookup(this.configuredDevice.id);
    if (!isValidDabCatalog(value, this.configuredDevice.address)) return undefined;
    return enableLegacyDabNameSelection(value);
  }

  async stationCatalog(): Promise<{
    device: string;
    state: NonNullable<DeviceStatus["receiver"]>["dabCatalog"]["state"];
    scannedAt?: number;
    complete: boolean;
    uncertainSteps: number;
    stations: DabCatalog["stations"];
    guidance?: string;
  }> {
    let catalog: DabCatalog | undefined;
    let cacheUnavailable = false;
    try {
      catalog = await this.cachedCatalog();
    } catch (error) {
      if (!(error instanceof LocalDeviceError) || error.code !== "dab_cache_unavailable") throw error;
      cacheUnavailable = true;
    }
    const state = this.scanningDab ? "scanning" : !catalog ? "missing"
      : catalog.stale ? "stale" : catalog.complete && catalog.uncertainSteps === 0 ? "ready" : "partial";
    const resolvedState = cacheUnavailable ? "unavailable" : state;
    const guidance = resolvedState === "unavailable"
      ? "The DAB cache could not be read. Other receiver controls remain available; ask an administrator to inspect the cache before refreshing."
      : resolvedState === "missing" || resolvedState === "stale"
      ? "Ask the user before refreshing the DAB list. Refresh audibly cycles stations, usually for about two minutes and up to four minutes."
      : resolvedState === "partial" ? "The list contains uncertain steps; do not claim it is complete. Duplicate labels select the next station with that name, not a proven individual service. Offer a refresh if a station is missing."
        : undefined;
    return {
      device: this.configuredDevice.id,
      state: resolvedState,
      ...(catalog ? { scannedAt: catalog.scannedAt } : {}),
      complete: catalog?.complete ?? false,
      uncertainSteps: catalog?.uncertainSteps ?? 0,
      stations: catalog?.stations ?? [],
      ...(guidance ? { guidance } : {}),
    };
  }

  private async markCatalogStale(): Promise<void> {
    const catalog = await this.cachedCatalog();
    if (catalog && !catalog.stale) await this.catalogStore.register(this.configuredDevice.id, { ...catalog, stale: true });
  }

  async status(signal?: AbortSignal): Promise<DeviceStatus> {
    const device = this.configuredDevice;
    const queries = await Promise.allSettled([
      telnetSnapshot(device, this.timeoutMs, signal),
      currentStation(device, this.timeoutMs, signal),
      soap(device, "render", "X_GetBass", renderArgs, this.timeoutMs, signal),
      soap(device, "render", "X_GetTreble", renderArgs, this.timeoutMs, signal),
      soap(device, "render", "X_GetBalance", renderArgs, this.timeoutMs, signal),
      soap(device, "render", "GetVolume", renderArgs, this.timeoutMs, signal),
      soap(device, "render", "GetMute", renderArgs, this.timeoutMs, signal),
      playbackState(device, this.timeoutMs, signal),
      soap(device, "act", "GetTunerConfig", "", this.timeoutMs, signal),
    ]);
    const result = <T>(index: number): T | undefined => queries[index]?.status === "fulfilled"
      ? (queries[index].value as T) : undefined;
    const telnetLines = result<string[]>(0) ?? [];
    const line = (prefix: string) => telnetLines.findLast((value) => value.startsWith(prefix));
    const power = line("PW");
    const volume = Number(line("MV")?.slice(2) ?? xmlValue(result<string>(5) ?? "", "CurrentVolume"));
    const muteValue = line("MU") ?? xmlValue(result<string>(6) ?? "", "CurrentMute");
    const band = telnetBand(telnetLines);
    const upnpBand = result<string>(8)?.match(/&lt;bandMode&gt;(DAB|FM)&lt;\/bandMode&gt;/)?.[1];
    const dab = line("TFDA")?.match(/^TFDA([0-9]{1,2}[A-D])(?:\s|$)/);
    const resolvedBand = band ?? (upnpBand === "DAB" ? "dab" : upnpBand === "FM" ? "fm" : undefined);
    const fmFrequencyMHz = power === "PWON" && resolvedBand === "fm"
      ? decodeHeosFmFrequency(result<string>(1)) : undefined;
    const bass = Number(xmlValue(result<string>(2) ?? "", "CurrentBass"));
    const treble = Number(xmlValue(result<string>(3) ?? "", "CurrentTreble"));
    const balance = Number(xmlValue(result<string>(4) ?? "", "CurrentBalance"));
    const available = queries.some((result) => result.status === "fulfilled");
    const catalog = await this.stationCatalog();
    return {
      id: device.id, name: device.name, provider: "denon", available,
      power: power === "PWON" ? "on" : power === "PWSTANDBY" ? "off" : "unknown",
      receiver: {
        ...(Number.isInteger(volume) && volume >= 0 && volume <= 60 ? { volume } : {}),
        ...(muteValue !== undefined ? { muted: muteValue === "MUON" || muteValue === "1" } : {}),
        ...(line("SI") ? { source: line("SI")?.slice(2).toLowerCase() } : {}),
        ...(resolvedBand ? { band: resolvedBand } : {}),
        ...(power === "PWON" && resolvedBand === "dab" && typeof result<string>(1) === "string"
          ? { station: result<string>(1) } : {}),
        ...(resolvedBand === "dab" && dab ? { dabChannel: dab[1] } : {}),
        ...(resolvedBand === "fm" && fmFrequencyMHz !== undefined ? { fmFrequencyMHz } : {}),
        ...(Number.isInteger(bass) ? { bass: bass - 10 } : {}),
        ...(Number.isInteger(treble) ? { treble: treble - 10 } : {}),
        ...(Number.isInteger(balance) ? { balance: balance - 50 } : {}),
        sources: Object.keys(INPUTS),
        ...(result<"play" | "pause" | "stop">(7) ? { playback: result<"play" | "pause" | "stop">(7) } : {}),
        dabCatalog: {
          state: catalog.state,
          stationCount: catalog.stations.length,
          ...(catalog.scannedAt ? { scannedAt: catalog.scannedAt } : {}),
          ...(catalog.uncertainSteps ? { uncertainSteps: catalog.uncertainSteps } : {}),
          ...(catalog.guidance ? { guidance: catalog.guidance } : {}),
        },
        alternatives,
      },
    };
  }

  private async absolute(
    methods: readonly Interface[],
    via: Interface | undefined,
    run: (method: Interface) => Promise<void>,
  ): Promise<void> {
    if (via && !methods.includes(via)) throw new LocalDeviceError("unsupported_method", "This control method is unavailable for the requested action");
    const selected = via ? [via] : methods;
    for (const [index, method] of selected.entries()) {
      try { await run(method); return; }
      catch (error) {
        if (!(error instanceof LocalDeviceError) || error.code !== "receiver_unavailable" || index === selected.length - 1) throw error;
      }
    }
  }

  private async confirmed(expected: (status: DeviceStatus) => boolean, signal?: AbortSignal): Promise<DeviceStatus> {
    for (let attempt = 0; attempt < 16; attempt++) {
      const status = await this.status(signal);
      if (expected(status)) return status;
      if (attempt < 15) await delay(250, undefined, { signal });
    }
    throw new LocalDeviceError("receiver_unconfirmed", "Receiver did not confirm the requested state");
  }

  private async ensureOn(signal?: AbortSignal): Promise<void> {
    if ((await this.status(signal)).power !== "on") {
      await this.control({ type: "turn_on" }, signal);
      await delay(1000, undefined, { signal });
    }
  }

  private async settledDabStation(signal?: AbortSignal): Promise<string> {
    for (let attempt = 0; attempt < 24; attempt++) {
      const name = await currentStation(this.configuredDevice, this.timeoutMs, signal);
      if (name && !/^FM\s+\d/i.test(name)) return name;
      await delay(250, undefined, { signal });
    }
    throw new LocalDeviceError("receiver_unconfirmed", "DAB station metadata is not ready");
  }

  private async changedStation(previous: string, waitMs = 6_000, signal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await delay(250, undefined, { signal });
      const station = await currentStation(this.configuredDevice, this.timeoutMs, signal);
      if (station && station !== previous) return station;
    }
    throw new LocalDeviceError("receiver_unconfirmed", "DAB station change was not confirmed; the tuner may have moved");
  }

  private async advanceDab(
    direction: "UP" | "DOWN", previous: string, signal?: AbortSignal,
  ): Promise<{ station: string; recovered: boolean }> {
    return await moveDabWithRecovery(direction, previous, {
      send: async (step) => { await telnet(this.configuredDevice, `TFDA${step}`, "TFDA", Math.min(this.timeoutMs, 125), signal); },
      changed: async (station, waitMs) => await this.changedStation(station, waitMs, signal),
      current: async () => await currentStation(this.configuredDevice, this.timeoutMs, signal),
      pause: async (waitMs) => { await delay(waitMs, undefined, { signal }); },
    });
  }

  private async selectNextNamedDabStation(catalog: DabCatalog, targetIndex: number, signal?: AbortSignal): Promise<DeviceStatus> {
    const target = catalog.stations[targetIndex];
    const names = catalog.stations.map((station) => station.name);
    let navigation: Awaited<ReturnType<typeof navigateDabByName>>;
    try {
      navigation = await navigateDabByName(names, await this.settledDabStation(signal), target.name, {
        send: async (direction) => { await telnet(this.configuredDevice, `TFDA${direction}`, "TFDA", Math.min(this.timeoutMs, 125), signal); },
        changed: async (previous) => await this.changedStation(previous, 6_000, signal),
        current: async () => await currentStation(this.configuredDevice, this.timeoutMs, signal),
      }, new Map(catalog.stations.map((station) => [station.name, station.occurrences])));
    } catch (error) {
      if (error instanceof LocalDeviceError && error.code === "dab_catalog_stale") await this.markCatalogStale();
      throw error;
    }
    const status = await this.status(signal);
    if (!status.receiver || status.receiver.station !== target.name) {
      throw new LocalDeviceError("receiver_unconfirmed", "DAB target name was not confirmed in final receiver status");
    }
    return { ...status, receiver: { ...status.receiver, dabSelection: {
      stationId: target.id, label: target.label ?? target.name,
      direction: navigation.direction === "UP" ? "next" : "previous", steps: navigation.steps,
      confirmed: navigation.confirmed && target.occurrences === 1 && catalog.complete && catalog.uncertainSteps === 0,
      method: "relative",
    } } };
  }

  private async refreshDabStations(signal?: AbortSignal): Promise<DeviceStatus> {
    if (this.scanningDab || this.activeControls > 0) {
      throw new LocalDeviceError("receiver_busy", "Receiver controls must finish before refreshing its DAB list");
    }
    this.scanningDab = true;
    const scanSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(240_000)]) : AbortSignal.timeout(240_000);
    try {
      const before = await this.status(scanSignal);
      if (before.power !== "on" || before.receiver?.source !== "tuner" || before.receiver?.band !== "dab") {
        throw new LocalDeviceError("dab_scan_requires_tuner", "Select and start DAB playback before refreshing its station list");
      }
      let initial: string;
      try {
        initial = await this.settledDabStation(scanSignal);
      } catch (error) {
        if (!(error instanceof LocalDeviceError) || error.code !== "receiver_unconfirmed") throw error;
        await telnet(this.configuredDevice, "TFDAUP", "TFDA", Math.min(this.timeoutMs, 125), scanSignal);
        initial = await this.settledDabStation(scanSignal);
      }
      const names = [initial];
      const ambiguousNames = new Set<string>();
      let previous = initial;
      let uncertainSteps = 0;
      let consecutiveUncertain = 0;
      let completedCycle = false;
      let observedSteps = 0;
      for (let step = 1; step <= MAX_DAB_STEPS; step++) {
        if (scanSignal.aborted) throw new LocalDeviceError("scan_interrupted", "DAB list refresh was interrupted; the receiver may be on another station");
        observedSteps = step;
        let next: string;
        try {
          const result = await this.advanceDab("UP", previous, scanSignal);
          next = result.station;
          if (result.recovered) {
            uncertainSteps++;
            ambiguousNames.add(previous);
          }
        } catch (error) {
          if (!(error instanceof LocalDeviceError) || error.code !== "receiver_unconfirmed") throw error;
          uncertainSteps++;
          consecutiveUncertain++;
          ambiguousNames.add(previous);
          if (consecutiveUncertain >= 3) break;
          // Continue to a distinct, observable name, but keep the catalog
          // partial: one or more equal-name services may have been skipped.
          continue;
        }
        consecutiveUncertain = 0;
        names.push(next);
        const cycle = findRepeatedDabCycle(names);
        if (cycle) {
          names.splice(0, names.length, ...names.slice(cycle.start, cycle.start + cycle.length));
          completedCycle = true;
          break;
        }
        previous = next;
      }
      if (names.length < 2) throw new LocalDeviceError("scan_incomplete", "DAB list refresh found fewer than two stations");
      const catalog = buildDabCatalog(this.configuredDevice.address, names, observedSteps, uncertainSteps, completedCycle && uncertainSteps === 0, Date.now(), ambiguousNames);
      await this.catalogStore.register(this.configuredDevice.id, catalog);
      this.scanningDab = false;
      return await this.status(signal);
    } catch (error) {
      if (scanSignal.aborted) {
        throw new LocalDeviceError("scan_interrupted", "DAB list refresh was interrupted; the receiver may be on another station");
      }
      throw error;
    } finally {
      this.scanningDab = false;
    }
  }

  async control(action: LocalDeviceAction, signal?: AbortSignal): Promise<DeviceStatus> {
    if (action.type === "refresh_dab_stations") return await this.refreshDabStations(signal);
    if (this.scanningDab) {
      throw new LocalDeviceError("receiver_busy", "Receiver controls are paused while its DAB list is being refreshed");
    }
    this.activeControls++;
    try {
      return await this.controlAction(action, signal);
    } finally {
      this.activeControls--;
    }
  }

  private async controlAction(action: LocalDeviceAction, signal?: AbortSignal): Promise<DeviceStatus> {
    const device = this.configuredDevice;
    const timeout = this.timeoutMs;
    switch (action.type) {
      case "turn_on":
      case "turn_off": {
        const on = action.type === "turn_on";
        await telnet(device, on ? "PWON" : "PWSTANDBY", "PW", timeout, signal);
        return await this.confirmed((status) => status.power === (on ? "on" : "off"), signal);
      }
      case "set_volume":
        await this.absolute(["telnet", "upnp"], action.via, async (method) => {
          if (method === "telnet") await telnet(device, `MV${String(action.volume).padStart(2, "0")}`, "MV", timeout, signal);
          else await soap(device, "render", "SetVolume", `${renderArgs}<DesiredVolume>${action.volume}</DesiredVolume>`, timeout, signal);
        });
        return await this.confirmed((status) => status.receiver?.volume === action.volume, signal);
      case "set_mute":
        await this.absolute(["telnet", "upnp", "heos"], action.via, async (method) => {
          if (method === "telnet") await telnet(device, action.muted ? "MUON" : "MUOFF", "MU", timeout, signal);
          else if (method === "upnp") await soap(device, "render", "SetMute", `${renderArgs}<DesiredMute>${action.muted ? 1 : 0}</DesiredMute>`, timeout, signal);
          else {
            const id = await heosPlayerId(device, timeout, signal);
            await heos(device, `heos://player/set_mute?pid=${id}&state=${action.muted ? "on" : "off"}`, timeout, signal);
          }
        });
        return await this.confirmed((status) => status.receiver?.muted === action.muted, signal);
      case "select_source": {
        const methods: Interface[] = action.source === "cd" || action.source === "tuner" ? ["heos", "telnet"] : ["heos"];
        if (action.via && !methods.includes(action.via)) {
          throw new LocalDeviceError("unsupported_method", `Source ${action.source} is not available via ${action.via}`);
        }
        await this.ensureOn(signal);
        await this.absolute(methods, action.via, async (method) => {
          if (method === "telnet") await telnet(device, `SI${action.source.toUpperCase()}`, "SI", timeout, signal);
          else {
            const id = await heosPlayerId(device, timeout, signal);
            await heos(device, `heos://browse/play_input?pid=${id}&input=${INPUTS[action.source]}`, timeout, signal);
          }
        });
        const expected = { cd: "cd", tuner: "tuner", optical1: "optical1", optical2: "optical2", analog: "analog" }[action.source];
        return await this.confirmed((status) => status.receiver?.source === expected, signal);
      }
      case "select_band":
        await this.ensureOn(signal);
        if ((await this.status(signal)).receiver?.source !== "tuner") {
          await this.control({ type: "select_source", source: "tuner" }, signal);
        }
        await this.absolute(["telnet", "upnp"], action.via, async (method) => {
          if (method === "telnet") await telnet(device, action.band === "dab" ? "TMDA" : "TMANFM", "TM", timeout, signal);
          else {
            const inner = `<TunerConfig><bandMode>${action.band.toUpperCase()}</bandMode></TunerConfig>`;
            const escaped = inner.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
            await soap(device, "act", "SetTunerConfig", `<TunerConfig>${escaped}</TunerConfig>`, timeout, signal);
          }
        });
        return await this.confirmed((status) => status.receiver?.band === action.band, signal);
      case "station_next":
      case "station_previous": {
        await this.ensureOn(signal);
        const before = await this.status(signal);
        if (before.receiver?.source !== "tuner" || (before.receiver?.band !== "dab" && before.receiver?.band !== "fm")) {
          throw new LocalDeviceError("unsupported_action", "Select DAB or FM before changing stations");
        }
        if (before.receiver.band === "dab") {
          const previous = await this.settledDabStation(signal);
          await telnet(device, action.type === "station_next" ? "TFDAUP" : "TFDADOWN", "TFDA", Math.min(timeout, 125), signal);
          let confirmed = true;
          try {
            await this.changedStation(previous, 6_000, signal);
          } catch (error) {
            if (!(error instanceof LocalDeviceError) || error.code !== "receiver_unconfirmed") throw error;
            confirmed = false;
          }
          const status = await this.status(signal);
          if (!status.receiver) return status;
          return { ...status, receiver: { ...status.receiver, dabStep: {
            direction: action.type === "station_next" ? "next" : "previous", confirmed,
          } } };
        }
        await telnet(device, "TFAN" + (action.type === "station_next" ? "UP" : "DOWN"), "TFAN", Math.min(timeout, 800), signal);
        return await this.confirmed((status) => status.receiver?.fmFrequencyMHz !== before.receiver?.fmFrequencyMHz, signal);
      }
      case "select_dab_station": {
        const catalog = await this.cachedCatalog();
        if (!catalog) throw new LocalDeviceError("dab_catalog_missing", "DAB station list is missing. Ask the user before refreshing it; refresh audibly cycles all stations.");
        if (catalog.stale) throw new LocalDeviceError("dab_catalog_stale", "Cached DAB station list is stale. Ask the user whether to refresh it.");
        const target = catalog.stations.find((station) => station.id === action.station);
        if (!target) throw new LocalDeviceError("unknown_station", "DAB station is not in the cached list. Ask the user whether to refresh it.");
        if (!target.selectable) throw new LocalDeviceError("ambiguous_station", "DAB station was not sufficiently observed in the cached scan");
        await this.ensureOn(signal);
        const before = await this.status(signal);
        if (before.receiver?.source !== "tuner" || before.receiver?.band !== "dab") await this.control({ type: "select_band", band: "dab" }, signal);
        return await this.selectNextNamedDabStation(catalog, catalog.stations.indexOf(target), signal);
      }
      case "tune_fm": {
        const encoded = encodeFmFrequency(action.frequencyMHz);
        await this.control({ type: "select_band", band: "fm" }, signal);
        await telnet(device, `TFAN${encoded}`, "TFAN", timeout, signal);
        return await this.confirmed((status) => status.receiver?.fmFrequencyMHz === action.frequencyMHz, signal);
      }
      case "set_bass":
      case "set_treble":
      case "set_balance": {
        const field = action.type === "set_bass" ? "Bass" : action.type === "set_treble" ? "Treble" : "Balance";
        const value = action.type === "set_balance" ? action.balance + 50 : action.level + 10;
        await soap(device, "render", `X_Set${field}`, `${renderArgs}<Desired${field}>${value}</Desired${field}>`, timeout, signal);
        return await this.confirmed((status) => (field === "Bass" ? status.receiver?.bass : field === "Treble" ? status.receiver?.treble : status.receiver?.balance) === (action.type === "set_balance" ? action.balance : action.level), signal);
      }
      case "play":
      case "pause":
      case "stop":
      case "track_next":
      case "track_previous": {
        await this.ensureOn(signal);
        const status = await this.status(signal);
        if (status.receiver?.source === "tuner") throw new LocalDeviceError("unsupported_action", "HEOS playback controls are unavailable for live radio");
        const id = await heosPlayerId(device, timeout, signal);
        const command = action.type === "track_next" ? "play_next" : action.type === "track_previous" ? "play_previous" : "set_play_state";
        await heos(device, `heos://player/${command}?pid=${id}${command === "set_play_state" ? `&state=${action.type}` : ""}`, timeout, signal);
        return await this.status(signal);
      }
      default:
        throw new LocalDeviceError("unsupported_action", "Receiver does not support this action");
    }
  }
}
