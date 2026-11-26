import { hour, days, MAX_HOURS, snapshot } from "./store.mjs";
import { resourceReport } from "./metrics.mjs";
import { advisoryQuery } from "./advisories.mjs";

const levels = ["UNKNOWN","LOW","MEDIUM","HIGH","CRITICAL"];
const urgencyScore = { high:3, medium:2, low:1 };
function mark(at, now, staleMs) {
  return { collectedAt:new Date(at).toISOString(), stale:now-at>staleMs };
}

function limit(value, fallback=20) {
  const v=value??fallback;
  if (!Number.isInteger(v)||v<1||v>100) throw new Error("invalid_limit");
  return v;
}

function term(value) {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length>128) throw new Error("invalid_component");
  return value.toLowerCase().trim();
}

function date(input, fallback) {
  if (input === undefined) return fallback;
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(input))
    throw new Error("invalid_date");
  const at=Date.parse(input);
  if (!Number.isFinite(at) || new Date(Date.parse(input.slice(0,10)+"T00:00:00Z")).toISOString().slice(0,10)!==input.slice(0,10))
    throw new Error("invalid_date");
  return at;
}

function sourceStatus(db, id, now, quality) {
  const row=snapshot(db,id);
  return {asOf:row?new Date(row.at).toISOString():null, stale:!row||now-row.at>36*hour,
    lastAttempt:quality?.data[id]?.status??"unknown", lastAttemptAt:quality?new Date(quality.at).toISOString():null,
    ...(quality?.data[id]?.reason?{lastFailure:quality.data[id].reason}:{})};
}

function requireSnapshot(db,id){
  const data=snapshot(db,id);
  if (!data) throw new Error("no_samples");
  return data;
}

const observations = {
  server_health:["health",3], server_connections:["connections",25],
  server_security_events:["events",25], server_tls:["tls",25],
};

export function query(db,name,params={},now=Date.now()) {
  if (name==="server_resources") {
    const hours=params.hours??24;
    const to=date(params.to,now);
    if (!Number.isInteger(hours)||hours<1||hours>MAX_HOURS||to>now) throw new Error("invalid_resources_window");
    const results=resourceReport(db,to-hours*hour,to,limit(params.top,10));
    return { ...results, stale:!results.latestSample||now-Date.parse(results.latestSample)>3*60_000, freshnessRelativeTo:"now" };
  }
  if (Object.hasOwn(observations,name)){
    const [id,maxAgeMinutes]=observations[name];
    const row=requireSnapshot(db,id);
    if (id==="connections") {
      const { timeline,...data }=row.data;
      const last=snapshot(db,"connectionHealth");
      return { ...mark(row.at,now,maxAgeMinutes*60_000),...data,
        lastProbe:last?.data.status??"unknown",
        samples:timeline.length, peak:Math.max(...timeline.map(x=>x.establishedTcp)),
        recent:timeline.slice(-24).map(x=>({at:new Date(x.at).toISOString(),establishedTcp:x.establishedTcp})) };
    }
    return { ...mark(row.at,now,maxAgeMinutes*60_000), results:row.data };
  }
  const quality=snapshot(db,"feedHealth");
  const kev=snapshot(db,"kev");
  const nvd=snapshot(db,"nvd");
  const sources=Object.fromEntries(["debian","kev","nvd"].map(id=>[id,sourceStatus(db,id,now,quality)]));
  if (name==="server_advisories") {
    if (!nvd) return { snapshotAvailable:false, sources };
    const to=date(params.to,nvd.data.to);
    const from=date(params.from,to-24*hour);
    if (to-from>7*days||to>now) throw new Error("invalid_advisory_window");
    if (params.exploitedOnly && sources.kev.stale) return { snapshotAvailable:false, reason:"kev_stale_or_unavailable", sources };
    return { ...advisoryQuery(nvd.data,kev?.data??{},{from,to,minimum:params.minimumSeverity??"UNKNOWN",
      component:term(params.component), exploitedOnly:params.exploitedOnly??false, limit:limit(params.limit)}), sources };
  }
  if (name==="server_vulnerabilities") {
    const debian=snapshot(db,"debian");
    if (!debian) return {snapshotAvailable:false,sources};
    const {findings,...coverage}=debian.data;
    const key=term(params.component);
    const since=date(params.firstObservedAfter,0);
    const minimum=params.minimumSeverity??"UNKNOWN";
    if (!levels.includes(minimum) || (params.exploitedOnly!==undefined&&typeof params.exploitedOnly!=="boolean")) throw new Error("invalid_filter");
    if (params.exploitedOnly&&sources.kev.stale) return { snapshotAvailable:false,reason:"kev_stale_or_unavailable",sources };
    const context=new Map((nvd?.data.entries??[]).map(x=>[x.id,x.severity]));
    const annotated=findings.filter(x=>!key||x.source.includes(key)||x.id.toLowerCase()===key).map(x=>({
      ...x, firstObserved:new Date(x.firstObserved).toISOString(), severity:context.get(x.id)??"UNKNOWN",
      ...(kev?.data[x.id]?{knownExploitedSince:kev.data[x.id]}:{})
    })).filter(x=>Date.parse(x.firstObserved)>=since);
    const notRated=annotated.filter(x=>x.severity==="UNKNOWN").length;
    const matched=annotated.filter(x=>(!params.exploitedOnly||x.knownExploitedSince)&&levels.indexOf(x.severity)>=levels.indexOf(minimum));
    matched.sort((a,b)=>Number(!!b.knownExploitedSince)-Number(!!a.knownExploitedSince)||
      Number(b.kernelRunning)-Number(a.kernelRunning)||
      (urgencyScore[b.urgency]??0)-(urgencyScore[a.urgency]??0)||
      levels.indexOf(b.severity)-levels.indexOf(a.severity)||a.id.localeCompare(b.id));
    return { ...coverage, sources, totalOpen:findings.length, matching:matched.length, withoutCvssSeverity:notRated,
      requiresVersionVerification:sources.debian.stale||sources.debian.lastAttempt!=="ok", entries:matched.slice(0,limit(params.limit)) };
  }
  throw new Error("unknown_tool");
}
