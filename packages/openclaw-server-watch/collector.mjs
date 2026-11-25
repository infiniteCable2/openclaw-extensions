import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, statfs } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { release, version } from "node:os";
import { openStore, snapshot, putSnapshot, putSample, minute } from "./store.mjs";
import { intervals } from "./metrics.mjs";
import { sourceUrls, downloadJson, projectKev, fetchNvd, mergeNvd, packageRows, correlateDebian } from "./advisories.mjs";
import { collectObservations } from "./observations.mjs";

const exec = promisify(execFile);

export async function command(program, args, maxBuffer = 512 * 1024, timeout = 4000, keepPartial = false) {
  try {
    const { stdout } = await exec(program, args, { timeout, maxBuffer, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" } });
    return stdout;
  } catch (error) {
    if (keepPartial && typeof error.code==="number" && !error.killed && typeof error.stdout==="string" && error.stdout) return error.stdout;
    throw error;
  }
}

export async function optional(operation) {
  try { return await operation(); } catch { return undefined; }
}

const number = (v) => /^\d+$/.test(String(v).trim()) ? Number(v) : undefined;
const text = (p) => readFile(p, "utf8");

export function cpuCounters(input) {
  const [cpu, ...fields] = input.split("\n", 1)[0].trim().split(/\s+/);
  const values = fields.slice(0, 8).map(number);
  if (cpu !== "cpu" || values.length < 5 || values.some(x => x === undefined)) throw new Error("invalid_proc_stat");
  return { total: values.reduce((a,b)=>a+b,0), idle: values[3], wait: values[4] };
}

function memory(input) {
  const values = Object.fromEntries([...input.matchAll(/^(\w+):\s*(\d+) kB/gm)].map(m=>[m[1],Number(m[2])*1024]));
  return {
    ...(values.MemTotal >= values.MemAvailable ? { memoryUsedBytes: values.MemTotal - values.MemAvailable, memoryTotalBytes: values.MemTotal } : {}),
    ...(values.SwapTotal >= values.SwapFree ? { swapUsedBytes: values.SwapTotal - values.SwapFree, swapTotalBytes: values.SwapTotal } : {}),
  };
}

function pathForCgroup(group) {
  if (typeof group !== "string" || !group.startsWith("/") || group === "/" || group.split("/").includes("..")) return;
  return join("/sys/fs/cgroup", group);
}

async function cgroup(group, instance) {
  const p = pathForCgroup(group);
  if (!p) return { instance };
  const [cpu, ram, swap] = await Promise.all(["cpu.stat","memory.current","memory.swap.current"].map(f => optional(() => text(join(p,f)))));
  return { instance, cpuUsec: number(/^usage_usec (\d+)/m.exec(cpu ?? "")?.[1]),
    memoryBytes: number(ram), swapBytes: number(swap) };
}

async function unitState(units) {
  const names = units.map(x => x.unit);
  if (!names.length) return [];
  const fields = ["Id","ActiveState","SubState","NRestarts","ControlGroup","InvocationID"];
  const lines = (await command("systemctl", ["show","--no-pager",...fields.map(p=>"-p"+p),"--",...names],512*1024,4000,true)).trim();
  const byName = new Map(lines.split(/\n\s*\n/).map(block => {
    const props = Object.fromEntries(block.split("\n").filter(x=>x.includes("=")).map(x=>[x.slice(0,x.indexOf("=")),x.slice(x.indexOf("=")+1)]));
    return [props.Id, props];
  }));
  return Promise.all(units.map(async ({id,unit,expected}) => {
    const r = byName.get(unit);
    if (!r) return { id, expected, state: "unknown", sample: {} };
    const state = /^(active|inactive|failed|activating|deactivating|reloading|maintenance)$/.test(r.ActiveState) ? r.ActiveState : "unknown";
    return { id, expected, state, restarts: number(r.NRestarts), sample: await cgroup(r.ControlGroup, r.InvocationID) };
  }));
}

async function containers(entries) {
  if (!entries.length) return [];
  const fmt = '{{json .Name}} {{json .State.Status}} {{json .State.Pid}} {{json .Id}} {{with (index .State "Health")}}{{.Status}}{{else}}none{{end}} {{json .RestartCount}}';
  const names = entries.map(x => x.container);
  const out = await optional(() => command("docker", ["inspect","--type=container","--format",fmt,"--",...names],2*1024*1024,4000,true));
  // Only inspect these selected fields. Container environment and health logs stay local.
  if (!out) return entries.map(({ id, expected }) => ({ id, expected, state: "unknown", sample: {} }));
  const byName = new Map();
  for (const line of out.trim().split("\n")) {
    const m = /^"\/([A-Za-z0-9_.-]+)" "([a-z]+)" (\d+) "([a-f0-9]{64})" (healthy|unhealthy|starting|none) (\d+)$/.exec(line);
    if (m) {
      const health = m[5] === "none" ? undefined : m[5];
      byName.set(m[1], { state: m[2], pid: number(m[3]), instance: m[4] + ":" + m[3], health, restarts: number(m[6]) });
    }
  }
  return Promise.all(entries.map(async ({id,container,expected}) => {
    const info = byName.get(container);
    if (!info) return { id, expected, state: "unknown", sample: {} };
    const group = info.pid > 0 ? await optional(() => text(`/proc/${info.pid}/cgroup`)) : "";
    return { id, expected, state: info.state, health: info.health, restarts: info.restarts,
      sample: await cgroup(/^0::([^\n]+)/m.exec(group ?? "")?.[1], info.instance) };
  }));
}

async function disks(items) {
  return Promise.all(items.map(async ({id,path}) => {
    const v = await optional(() => statfs(path));
    if (!v) return { id, state:"unavailable" };
    return { id, state:"ok", totalBytes: v.bsize*v.blocks, availableBytes:v.bsize*v.bavail,
      usedBytes: v.bsize*(v.blocks-v.bfree) };
  }));
}

async function gpus(items) {
  return Promise.all(items.map(async ({id,pci}) => {
    const p = await optional(() => text(`/sys/bus/pci/devices/${pci}/power/runtime_status`));
    const state = p?.trim();
    // Runtime-suspended accelerators must not be woken for telemetry.
    if (state !== "active") return { id, state: state === "suspended" ? "suspended" : "unavailable" };
    const raw = await optional(() => command("nvidia-smi", ["-i",pci,"--query-gpu=utilization.gpu,memory.used,memory.total","--format=csv,noheader,nounits"]));
    const [busyPercent,vramUsedMiB,vramTotalMiB] = raw?.trim().split(",").map(number) ?? [];
    if (busyPercent === undefined || busyPercent > 100 || vramUsedMiB === undefined || vramTotalMiB === undefined) return { id,state:"unavailable" };
    return { id, state:"active", busyPercent, vramUsedMiB, vramTotalMiB };
  }));
}

export function settings(raw) {
  if (!raw || typeof raw.database !== "string" || !isAbsolute(raw.database)) throw new Error("invalid_settings");
  const specs = {
    units: [/^[a-zA-Z0-9_@.:-]{1,120}\.service$/, "unit", 32],
    containers: [/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/, "container", 24],
    gpus: [/^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/, "pci", 4],
    filesystems: [/^\/.{0,255}$/, "path", 8],
    tls: [/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/, "host", 12],
  };
  const out = { database: raw.database, jails: raw.jails ?? [] };
  const labels = new Set();
  for (const [name,[pattern,key,limit]] of Object.entries(specs)) {
    const items = raw[name] ?? (name === "filesystems" ? [{id:"root",path:"/"}] : []);
    if (!Array.isArray(items) || items.length > limit) throw new Error("invalid_settings");
    out[name] = items.map(x => {
      if (!x || typeof x.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(x.id) || labels.has(x.id) ||
          typeof x[key] !== "string" || !pattern.test(x[key]) || x[key].includes("\0")) throw new Error("invalid_settings");
      if ((name === "units" || name === "containers") && !["running","stopped"].includes(x.expected ?? "running")) throw new Error("invalid_settings");
      if (name === "tls" && (!Number.isInteger(x.port ?? 443) || (x.port ?? 443) < 1 || (x.port ?? 443) > 65535 ||
        (x.address !== undefined && (typeof x.address !== "string" || !/^[\da-fA-F:.]{2,45}$/.test(x.address))) ||
        (x.renewalTimer !== undefined && (typeof x.renewalTimer !== "string" || !/^[a-zA-Z0-9_@.:-]{1,120}\.timer$/.test(x.renewalTimer))) ||
        (x.renewalUnit !== undefined && (typeof x.renewalUnit !== "string" || !/^[a-zA-Z0-9_@.:-]{1,120}\.service$/.test(x.renewalUnit))))) throw new Error("invalid_settings");
      labels.add(x.id);
      return { id:x.id, [key]:x[key], expected:x.expected ?? "running", ...(name==="tls"?{
        port:x.port??443,address:x.address,renewalTimer:x.renewalTimer,renewalUnit:x.renewalUnit,
      }: {}) };
    });
  }
  if (!Array.isArray(out.jails) || out.jails.length > 12 || out.jails.some(x => typeof x !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(x))) throw new Error("invalid_settings");
  return out;
}

export async function collectSample(c, now = Date.now()) {
  const at = Math.floor(now / minute) * minute;
  const [boot,cpu,ram,units,docker,filesystems,gpu] = await Promise.all([
    text("/proc/sys/kernel/random/boot_id"), text("/proc/stat"), text("/proc/meminfo"),
    optional(() => unitState(c.units)), containers(c.containers), disks(c.filesystems), gpus(c.gpus),
  ]);
  const services = [...(units ?? c.units.map(x => ({id:x.id,expected:x.expected,state:"unknown",sample:{}}))),...docker];
  const raw = { boot:boot.trim(), cpu:cpuCounters(cpu), workloads:Object.fromEntries(services.map(x=>[x.id,x.sample])) };
  const db = openStore(c.database);
  try {
    const prev = snapshot(db,"lastCounters");
    if (prev?.at >= at) return;
    putSample(db,at,{
      ...intervals(prev?.data,raw,at-(prev?.at ?? at)), ...memory(ram), filesystems,gpu,
    },raw);
    putSnapshot(db,"health",at,services.map(({sample,...service})=>service));
  } finally { db.close(); }
}

async function inventory() {
  const releaseName = /^VERSION_CODENAME="?([a-z0-9-]+)"?$/m.exec(await text("/etc/os-release"))?.[1];
  if (!releaseName) throw new Error("distribution_codename_unknown");
  const format="-f=${binary:Package}\\t${source:Package}\\t${source:Version}\\t${db:Status-Status}\\t${Built-Using}\\n";
  const rows = packageRows(await command("dpkg-query",["-W",format],8*1024*1024,10_000));
  if (!rows.length) throw new Error("package_inventory_unavailable");
  const kernelRelease = release();
  const ownerText = await optional(() => command("dpkg-query",["-S","--","/boot/vmlinuz-"+kernelRelease]));
  const owner = ownerText?.split(": ")[0];
  const row = rows.find(x=>x.binary===owner || x.binary.split(":")[0]===owner);
  const liveVersion = /\bDebian ([0-9][0-9a-z.+:~\-]+)/i.exec(version())?.[1];
  const kernel = { release:kernelRelease, ...(row&&liveVersion?{
    source:row.builtLinux?"linux":row.source, version:liveVersion,packageVersion:row.builtLinux??row.version,
  }: {}) };
  const nvidia = /^NVRM version: NVIDIA .+? ([0-9]+(?:\.[0-9]+){1,3})(?:\s|$)/m.exec(await optional(()=>text("/proc/driver/nvidia/version")) ?? "")?.[1];
  return { releaseName,rows,kernel,nvidia };
}

async function remember(db,id,at,task) {
  try { putSnapshot(db,id,at,await task()); return { status:"ok" }; }
  catch (error) {
    const message=error?.message;
    const reason=typeof message==="string"&&/^(feed_http_\d{3}|feed_too_large|invalid_kev|invalid_nvd|unsupported_distribution_release|package_inventory_unavailable|distribution_codename_unknown)$/.test(message)
      ? message : error?.name==="TimeoutError" ? "timeout" : "unavailable";
    return { status:"unavailable",reason,priorSnapshotAt:snapshot(db,id)?.at ?? null };
  }
}

export async function refreshFeeds(c, now = Date.now()) {
  const db = openStore(c.database);
  try {
    const [debian,kev,nvd] = await Promise.all([
      remember(db,"debian",now,async () => {
        const host = await inventory();
        // Fetch's limit applies to decompressed bytes, not the smaller transfer.
        const feed = await downloadJson(sourceUrls.debian,128*1024*1024);
        const result = correlateDebian(feed,host.releaseName,host.rows,host.kernel);
        // Dates here describe local observation, since tracker entries have no publication date.
        const prev = new Map((snapshot(db,"debian")?.data.findings ?? []).map(x=>[`${x.id}/${x.source}/${x.version}`,x.firstObserved]));
        return { ...result, findings: result.findings.map(x=>({...x,firstObserved:prev.get(`${x.id}/${x.source}/${x.version}`) ?? now})),
          release:host.releaseName, totalPackages:host.rows.length, kernel:host.kernel,
          coverage:{ containerImagePackages:"not_scanned", thirdPartyAndOutOfTreeDrivers:"unverified", runningUserspaceVersions:"unverified",
            ...(host.nvidia ? {runningNvidiaDriverVersion:host.nvidia} : {}) } };
      }),
      remember(db,"kev",now,async () => projectKev(await downloadJson(sourceUrls.kev,8*1024*1024))),
      remember(db,"nvd",now,async () => mergeNvd(snapshot(db,"nvd")?.data,await fetchNvd(now))),
    ]);
    putSnapshot(db,"feedHealth",now,{debian,kev,nvd});
    if ([debian,kev,nvd].every(x=>x.status!=="ok")) throw new Error("all_feeds_unavailable");
  } finally { db.close(); }
}

export async function main(argv) {
  const [mode,path] = argv;
  if (!["sample","observe","feeds"].includes(mode) || !isAbsolute(path ?? "")) throw new Error("invalid_mode");
  const data = settings(JSON.parse(await text(path)));
  if (mode === "sample") return collectSample(data);
  if (mode === "observe") return collectObservations(data, command, optional);
  return refreshFeeds(data);
}
