import { days } from "./store.mjs";

export const sourceUrls = {
  debian: "https://security-tracker.debian.org/tracker/data/json",
  kev: "https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json",
  nvd: "https://services.nvd.nist.gov/rest/json/cves/2.0",
};
const cvePattern = /^CVE-[0-9]{4}-[0-9]{4,19}$/;
const packagePattern = /^[a-z0-9][a-z0-9+.-]{0,126}$/;
const versionPattern = /^[a-zA-Z0-9.+:~\-]{1,160}$/;
const levels = ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

function order(c) {
  if (c === "~") return -1;
  if (!c || /[0-9]/.test(c)) return 0;
  return /[A-Za-z]/.test(c) ? c.charCodeAt(0) : c.charCodeAt(0) + 256;
}

function comparePart(a, b) {
  let i = 0, j = 0;
  const digit = c => c !== undefined && c >= "0" && c <= "9";
  while (i < a.length || j < b.length) {
    while ((i < a.length && !digit(a[i])) || (j < b.length && !digit(b[j]))) {
      const diff = order(a[i]) - order(b[j]);
      if (diff) return Math.sign(diff);
      i++;
      j++;
    }
    while (a[i] === "0") i++;
    while (b[j] === "0") j++;
    let diff = 0;
    while (digit(a[i]) && digit(b[j])) {
      if (!diff) diff = a.charCodeAt(i) - b.charCodeAt(j);
      i++;
      j++;
    }
    if (digit(a[i])) return 1;
    if (digit(b[j])) return -1;
    if (diff) return Math.sign(diff);
  }
  return 0;
}

function versionParts(v) {
  const colon = v.indexOf(":");
  const epoch = colon < 0 ? 0n : BigInt(v.slice(0, colon));
  const version = v.slice(colon + 1);
  const hyphen = version.lastIndexOf("-");
  return [epoch, hyphen < 0 ? version : version.slice(0, hyphen), hyphen < 0 ? "0" : version.slice(hyphen + 1)];
}

export function compareDebian(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  if (x[0] !== y[0]) return x[0] > y[0] ? 1 : -1;
  return comparePart(x[1], y[1]) || comparePart(x[2], y[2]);
}

function validVersion(v) {
  return typeof v === "string" && versionPattern.test(v) && /^(?:\d+:)?[^:]+$/.test(v);
}

export function packageRows(text) {
  return text.split("\n").flatMap(line => {
    const [binary, source, version, state, builtUsing] = line.split("\t");
    if (state?.trim() !== "installed" || !/^[a-z0-9][a-z0-9+.-]{0,126}(?::[a-z0-9-]+)?$/.test(binary) ||
      !packagePattern.test(source) || !validVersion(version)) return [];
    const linuxVersion = source.startsWith("linux-signed-") && binary.startsWith("linux-image-")
      ? /(?:^|,\s*)linux\s*\(=\s*([^\s)]+)\)/.exec(builtUsing ?? "")?.[1] : undefined;
    return [{ binary, source, version, ...(validVersion(linuxVersion)?{builtLinux:linuxVersion}:{}) }];
  });
}

export function correlateDebian(feed, release, packages, kernel) {
  const component = new Map();
  function add(source,version) {
    const versions = component.get(source) ?? new Set();
    versions.add(version);
    component.set(source, versions);
  }
  for (const { source, version, builtLinux } of packages) {
    add(source,version);
    if(builtLinux) add("linux",builtLinux);
  }
  if (kernel?.source && validVersion(kernel.version)) add(kernel.source,kernel.version);
  const result = [];
  let covered = 0;
  let releaseRecords = 0;
  let coverageUnknown = 0;
  let unsupported = 0;
  for (const [source, versions] of component) {
    const entries = feed[source];
    if (!entries || typeof entries !== "object") continue;
    covered++;
    for (const [id, item] of Object.entries(entries)) {
      if (!cvePattern.test(id)) continue;
      const r = item?.releases?.[release];
      if (!r) continue;
      releaseRecords++;
      if (r.status === "undetermined") { coverageUnknown++; continue; }
      if (r.status !== "open" && r.status !== "resolved") { unsupported++; continue; }
      const fixed = validVersion(r.fixed_version) ? r.fixed_version : undefined;
      if (r.status === "resolved" && fixed === "0") continue;
      if (r.status === "resolved" && !fixed) { coverageUnknown++; continue; }
      for (const version of versions) {
        if (fixed && fixed !== "0" && compareDebian(version, fixed) >= 0) continue;
        const kernelAffected = kernel?.source === source && kernel.version === version;
        const urgency = typeof r.urgency === "string" && /^[a-z -]{1,32}$/.test(r.urgency) ? r.urgency : "unknown";
        result.push({
          id, source, version, urgency, kernelRunning: kernelAffected,
          ...(fixed && fixed !== "0" ? { fixedVersion: fixed } : {}),
          ...(r.nodsa === undefined ? {} : { noDedicatedAdvisory: true }),
          ...(Object.hasOwn(r.repositories ?? {}, release + "-security") ? { securityRepositoryListed: true } : {}),
          reference: `https://security-tracker.debian.org/tracker/${id}`,
        });
      }
    }
  }
  if (!releaseRecords) throw new Error("unsupported_distribution_release");
  return { findings: result, exactSourceMatches: covered, installedSources: component.size, coverageUnknown, unsupported };
}

export function projectKev(data) {
  if (!Array.isArray(data?.vulnerabilities) || !data.vulnerabilities.length) throw new Error("invalid_kev");
  return Object.fromEntries(data.vulnerabilities.filter(x => cvePattern.test(x?.cveID) && /^\d{4}-\d{2}-\d{2}$/.test(x.dateAdded))
    .map(x => [x.cveID, x.dateAdded]));
}

export function projectNvd(v) {
  const c = v?.cve;
  const utc=(x)=> typeof x==="string" ? Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(x)?x:x+"Z") : NaN;
  const published=utc(c?.published), modified=utc(c?.lastModified);
  if (!cvePattern.test(c?.id) || !Number.isFinite(published) || !Number.isFinite(modified)) return;
  if (c.vulnStatus === "Rejected") return;
  const choices = c.metrics ?? {};
  const options = choices.cvssMetricV40 ?? choices.cvssMetricV31 ?? choices.cvssMetricV30 ?? choices.cvssMetricV2 ?? [];
  const metric = options.find(v => v.type === "Primary") ?? options[0];
  const raw = metric?.cvssData?.baseSeverity ?? metric?.baseSeverity;
  const severity = levels.includes(raw) ? raw : "UNKNOWN";
  const products = new Set();
  for (const config of c.configurations ?? []) {
    for (const node of config.nodes ?? []) {
      for (const item of node.cpeMatch ?? []) {
        const p = /^cpe:2\.3:[aho]:([a-z0-9_.-]{1,60}):([a-z0-9_.-]{1,100}):/i.exec(item.criteria);
        if (item.vulnerable === true && p && products.size < 12) products.add(p[1] + "/" + p[2]);
      }
    }
  }
  const score = metric?.cvssData?.baseScore;
  return {
    id: c.id, published: new Date(published).toISOString(), modified: new Date(modified).toISOString(), severity,
    ...(typeof score === "number" && score >= 0 && score <= 10 ? { cvss: score } : {}),
    products: [...products], reference: `https://nvd.nist.gov/vuln/detail/${c.id}`,
  };
}

export function severityAtLeast(value, minimum) {
  return levels.indexOf(value) >= levels.indexOf(minimum);
}

export async function downloadJson(url, maxBytes, timeoutMs = 35_000) {
  const result = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (!result.ok || !result.body) throw new Error(`feed_http_${result.status}`);
  const chunks = [];
  let size = 0;
  const reader = result.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error("feed_too_large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function fetchNvd(now, download = downloadJson) {
  // Query the public publication timeline. No package or device inventory leaves the host.
  // Overlap adjacent daily refreshes, without paging through a whole week each run.
  const from = now - 36 * (days / 24);
  const query = new URL(sourceUrls.nvd);
  query.searchParams.set("pubStartDate", new Date(from).toISOString());
  query.searchParams.set("pubEndDate", new Date(now).toISOString());
  query.searchParams.set("resultsPerPage", "1000");
  let offset = 0, total = 0, changedDuringRead = false;
  const entries = new Map();
  for (let page=0;page<3;page++) {
    if (offset) query.searchParams.set("startIndex",String(offset));
    const feed = await download(query, 32 * 1024 * 1024);
    if (!Array.isArray(feed.vulnerabilities) || feed.vulnerabilities.length>1000 ||
        !Number.isInteger(feed.totalResults) || feed.totalResults<0 || (feed.startIndex??0)!==offset) throw new Error("invalid_nvd");
    changedDuringRead ||= page>0 && total!==feed.totalResults;
    total=feed.totalResults;
    for (const candidate of feed.vulnerabilities) {
      const item=projectNvd(candidate);
      if (item) entries.set(item.id,item);
    }
    offset+=feed.vulnerabilities.length;
    if (offset>=total || !feed.vulnerabilities.length) break;
  }
  return { from, to: now, total, complete:!changedDuringRead&&total<=offset, entries:[...entries.values()] };
}

export function mergeNvd(previous, current) {
  const oldest = current.to - 7 * days;
  const from = previous?.complete && current.complete && previous.to >= current.from
    ? Math.max(oldest, previous.from) : current.from;
  const entries = new Map();
  for (const prior of previous?.entries ?? []) {
    const published = Date.parse(prior.published);
    if (published >= oldest && (published < current.from || !current.complete)) entries.set(prior.id, prior);
  }
  for (const item of current.entries) entries.set(item.id,item);
  return { ...current, from, entries:[...entries.values()], total:entries.size };
}

export function advisoryQuery(nvd, kev, { from, to, minimum = "UNKNOWN", component = "", exploitedOnly = false, limit = 20 }) {
  if (!levels.includes(minimum) || !Number.isFinite(from) || !Number.isFinite(to) || from >= to ||
      typeof component !== "string" || component.length > 128 || typeof exploitedOnly !== "boolean" ||
      !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_advisory_filter");
  const key = component.trim().toLowerCase();
  const results = nvd.entries.filter(e => {
    const t = Date.parse(e.published);
    return t >= from && t <= to && severityAtLeast(e.severity, minimum) &&
      (!key || e.id.toLowerCase() === key || e.products.some(p => p.includes(key))) &&
      (!exploitedOnly || Object.hasOwn(kev, e.id));
  });
  results.sort((a,b) => b.published.localeCompare(a.published) || a.id.localeCompare(b.id));
  return {
    coveredPublicationWindow: from >= nvd.from && to <= nvd.to && nvd.complete,
    sourceResults: nvd.total, matched: results.length,
    entries: results.slice(0, limit).map(x => ({ ...x, ...(kev[x.id] ? { knownExploitedSince: kev[x.id] } : {}) })),
  };
}
