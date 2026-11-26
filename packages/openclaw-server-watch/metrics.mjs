import { hour, minute, sampleRange, MAX_HOURS } from "./store.mjs";

const positive = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
const round = (n) => Math.round(n * 10) / 10;
function delta(after, before) {
  return positive(after) && positive(before) && after >= before ? after - before : undefined;
}

export function hostCpu(previous, current) {
  const elapsed = delta(current?.total, previous?.total);
  const idle = delta(current?.idle, previous?.idle);
  const wait = delta(current?.wait, previous?.wait);
  if (!elapsed || idle === undefined || wait === undefined || idle + wait > elapsed) return {};
  return { busyPercent: round(100 * (elapsed - idle - wait) / elapsed), ioWaitPercent: round(100 * wait / elapsed) };
}

export function intervals(before, after, elapsedMs) {
  const result = {};
  const valid = !!before && !!before.boot && before.boot === after.boot && elapsedMs > 0 && elapsedMs <= 3 * minute;
  if (valid) Object.assign(result, hostCpu(before.cpu, after.cpu));
  result.workloads = {};
  for (const [id, item] of Object.entries(after.workloads)) {
    const old = before?.workloads[id];
    const usage = valid && item.instance && old?.instance === item.instance ? delta(item.cpuUsec, old.cpuUsec) : undefined;
    result.workloads[id] = {
      ...Object.fromEntries(Object.entries({ memoryBytes: item.memoryBytes, swapBytes: item.swapBytes }).filter(([, v]) => positive(v))),
      ...(usage === undefined ? {} : { cpuCorePercent: round(usage / elapsedMs / 10), cpuIntervalMs: elapsedMs }),
    };
  }
  return result;
}

function add(o, key, value, weight = 1, at) {
  if (!positive(value) || !positive(weight) || !weight) return;
  const current = o[key] ??= { sum: 0, weights: 0, peak: -1, peakAt: null, samples: 0 };
  current.sum += value * weight;
  current.weights += weight;
  current.samples++;
  if (value > current.peak) {
    current.peak = value;
    current.peakAt = new Date(at).toISOString();
  }
}

function values(o) {
  return Object.fromEntries(Object.entries(o).map(([k, s]) => [k, {
    average: round(s.sum / s.weights), peak: s.peak, peakAt: s.peakAt, samples: s.samples,
  }]));
}

export function resourceReport(db, from, to, top = 10) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > MAX_HOURS * hour ||
      !Number.isInteger(top) || top < 1 || top > 20) throw new Error("invalid_window");
  const host = {};
  const filesystems = new Map();
  const gpu = new Map();
  const group = new Map();
  let first;
  let latest;
  let samples = 0;
  for (const row of sampleRange(db, from, to)) {
    const item = JSON.parse(row.data);
    const at = row.at;
    first ??= at;
    latest = { at, filesystems: item.filesystems, gpu: item.gpu,
      memoryTotalBytes:item.memoryTotalBytes,swapTotalBytes:item.swapTotalBytes };
    samples++;
    for (const k of ["busyPercent", "ioWaitPercent", "memoryUsedBytes", "swapUsedBytes"]) add(host, k, item[k], 1, at);
    for (const f of item.filesystems) {
      if (!filesystems.has(f.id)) filesystems.set(f.id, {});
      const g = filesystems.get(f.id);
      add(g, "usedBytes", f.usedBytes, 1, at);
      add(g, "availableBytes", f.availableBytes, 1, at);
    }
    for (const [id, m] of Object.entries(item.workloads)) {
      if (!group.has(id)) group.set(id, {});
      const g = group.get(id);
      add(g, "cpuCorePercent", m.cpuCorePercent, m.cpuIntervalMs, at);
      add(g, "memoryBytes", m.memoryBytes, 1, at);
      add(g, "swapBytes", m.swapBytes, 1, at);
    }
    for (const d of item.gpu) {
      if (!gpu.has(d.id)) gpu.set(d.id, {});
      const g = gpu.get(d.id);
      add(g, "busyPercent", d.busyPercent, 1, at);
      add(g, "vramUsedMiB", d.vramUsedMiB, 1, at);
    }
  }
  const topBy = (key) => [...group].filter(([, d]) => d[key]).sort((a, b) => b[1][key].peak - a[1][key].peak)
    .slice(0, top).map(([id, data]) => ({ id, ...values(data) }));
  return {
    from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    samples, nominalMinutes: Math.floor((to - from) / minute),
    firstSample: first === undefined ? null : new Date(first).toISOString(),
    latestSample: latest ? new Date(latest.at).toISOString() : null,
    host: values(host), gpu: [...gpu].map(([id, data]) => ({ id, ...values(data) })),
    hostCapacityLatest: latest ? {memoryTotalBytes:latest.memoryTotalBytes,swapTotalBytes:latest.swapTotalBytes} : undefined,
    gpuLatestState: latest?.gpu.map(({ id, state, vramTotalMiB }) => ({ id, state,
      ...(vramTotalMiB===undefined?{}:{vramTotalMiB}) })) ?? [],
    filesystems: [...filesystems].map(([id, data]) => ({ id, ...values(data) })),
    filesystemsLatest: latest?.filesystems ?? [],
    topCpu: topBy("cpuCorePercent"), topMemory: topBy("memoryBytes"), topSwap: topBy("swapBytes"),
  };
}
