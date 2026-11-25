import { open, stat } from "node:fs/promises";
import { connect } from "node:tls";
import { openStore, putSnapshot, hour, days } from "./store.mjs";

function socketAddress(address, family) {
  const i = address.lastIndexOf(":");
  const number = Number(address.slice(i + 1));
  if (i < 1 || !Number.isInteger(number) || number < 1 || number > 65535) return;
  const host = address.slice(0, i).replace(/^\[|\]$/g,"");
  return { port:number, scope:/^(?:127\.|::1$)/.test(host) ? "loopback" : ["*", "0.0.0.0", "::"].includes(host) ? "wildcard" : "interface",
    family };
}

export async function connections(command) {
  const live = await command("ss",["-H","-tan","state","established"]);
  const listeners = new Map();
  for (const family of [4,6]) {
    const text = await command("ss",["-H","-lntu","-"+family]);
    for (const line of text.trim().split("\n")) {
      const [network,,,,local] = line.trim().split(/\s+/);
      if (!["tcp","udp"].includes(network)) continue;
      const parsed = socketAddress(local ?? "",family);
      if (!parsed) continue;
      const key = `${network}:${family}:${parsed.port}:${parsed.scope}`;
      if (listeners.size < 150 || listeners.has(key)) listeners.set(key,{ network,...parsed });
    }
  }
  return { establishedTcp: live.split("\n").filter(x=>x.trim()).length,
    listeners: [...listeners.values()].sort((a,b)=>a.port-b.port), listenerLimitReached: listeners.size===150 };
}

export function loginCounts(lines) {
  let accepted = 0, rejected = 0, other = 0;
  for (const line of lines) {
    if (/^Accepted (?:password|publickey|keyboard-interactive|gssapi-with-mic) for /i.test(line)) accepted++;
    else if (/^(?:Failed (?:password|publickey|keyboard-interactive) for |Invalid user |error: maximum authentication attempts exceeded)/i.test(line)) rejected++;
    else other++;
  }
  return { accepted,rejected,other };
}

function boundedLines(s) {
  return s.trim() ? s.trimEnd().split("\n") : [];
}

async function tailFail2Ban() {
  const path = "/var/log/fail2ban.log";
  const f = await open(path,"r");
  try {
    const meta = await f.stat();
    if (!meta.isFile()) throw new Error("unexpected_log_file");
    const offset = Math.max(0, meta.size - 512 * 1024);
    const bytes = Buffer.alloc(meta.size-offset);
    const out = await f.read(bytes,0,bytes.length,offset);
    const lines = boundedLines(bytes.subarray(0,out.bytesRead).toString("utf8"));
    return { lines:offset ? lines.slice(1) : lines, cut:!!offset };
  } finally { await f.close(); }
}

export function banCounts(lines, jails, now) {
  const data = new Map(jails.map(j=>[j,{ban:0,unban:0,found:0,hourly:{}}]));
  for (const line of lines) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}),\d+\s+fail2ban\.(?:actions|filter)\s+\[\d+\]:\s+\w+\s+\[([\w.-]+)\]\s+(Ban|Unban|Found)\s/.exec(line);
    if (!m || !data.has(m[3])) continue;
    // Fail2ban's file logger timestamps are in the server's local timezone.
    const at = Date.parse(m[1]+"T"+m[2]);
    if (!Number.isFinite(at) || at < now - days || at > now) continue;
    const kind = m[4].toLowerCase();
    const j = data.get(m[3]);
    j[kind]++;
    const key = new Date(Math.floor(at/hour)*hour).toISOString();
    const counters = j.hourly[key] ??= {ban:0,unban:0,found:0};
    counters[kind]++;
  }
  return Object.fromEntries(data);
}

async function security(c, command, optional, now) {
  const jobs = [
    optional(() => command("journalctl",["--quiet","--no-pager","--since=-24h","--unit=ssh.service","--output=cat","-n","5000"],4*1024*1024,6500)),
    optional(tailFail2Ban),
    ...c.jails.map(jail => optional(() => command("fail2ban-client",["status",jail]))),
  ];
  const [j, log, ...statuses] = await Promise.all(jobs);
  const lines = j === undefined ? [] : boundedLines(j);
  const counts = log ? banCounts(log.lines,c.jails,now) : {};
  return {
    windowHours:24,
    ssh:j===undefined?{status:"unavailable"}:{status:"read",...loginCounts(lines),limitedByLineCount:lines.length>=5000,
      coverage:"entries visible to collector; journal retention may be shorter than window"},
    jails:c.jails.map((id,i)=> {
      const state = statuses[i];
      const n = state && /Currently banned:\s*(\d+)/.exec(state)?.[1];
      return { id, ...(n ? { currentlyBanned:Number(n) } : { status:"unavailable" }),
        ...(counts[id] ? { logCounts: counts[id] } : {}) };
    }),
    fail2banLog:log ? { source:"current_file", tailLimited:log.cut, coverage:"rotated segments excluded" } : {status:"unavailable"},
  };
}

function checkTls({id,host,address,port}, now) {
  return new Promise(resolve => {
    const sock = connect({host:address ?? host,port,servername:host,rejectUnauthorized:true});
    let done = false;
    function finish(value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({id,...value});
    }
    const timer = setTimeout(()=>finish({status:"timeout"}),5000);
    sock.once("error",e=>{
      const code = ["CERT_HAS_EXPIRED","ERR_TLS_CERT_ALTNAME_INVALID","UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY","ENOTFOUND","ECONNREFUSED"].includes(e.code)?e.code:"TLS_UNAVAILABLE";
      finish({status:"unverified",reason:code});
    });
    sock.once("secureConnect",()=>{
      const expiry = Date.parse(sock.getPeerCertificate().valid_to);
      if (!Number.isFinite(expiry)) return finish({status:"unverified"});
      finish({status:"verified",expiresAt:new Date(expiry).toISOString(),remainingHours:Math.floor((expiry-now)/hour)});
    });
  });
}

async function renewal(target, command, optional) {
  const { renewalTimer, renewalUnit } = target;
  if (!renewalTimer && !renewalUnit) return;
  async function properties(unit, keys) {
    if (!unit) return;
    const row = await optional(() => command("systemctl",["show","--no-pager",...keys.map(x=>"-p"+x),"--",unit]));
    if (!row) return;
    return Object.fromEntries(row.split("\n").filter(l=>l.includes("=")).map(l=>l.split(/=(.*)/s,2)));
  }
  const [timer, service] = await Promise.all([
    properties(renewalTimer,["ActiveState","LastTriggerUSec","NextElapseUSecRealtime"]),
    properties(renewalUnit,["Result","ExecMainExitTimestamp"]),
  ]);
  const iso=(value)=>{
    const raw=typeof value==="string"?value.replace(/^[A-Za-z]{3} /,""):"";
    return Number.isFinite(Date.parse(raw))?new Date(Date.parse(raw)).toISOString():null;
  };
  return {
    timer: timer && ["active","inactive","failed"].includes(timer.ActiveState)?timer.ActiveState:"unknown",
    lastTrigger:iso(timer?.LastTriggerUSec), nextTrigger:iso(timer?.NextElapseUSecRealtime),
    lastServiceExit:iso(service?.ExecMainExitTimestamp),
    lastServiceResult:service?.ExecMainExitTimestamp&&/^[a-z-]{1,32}$/.test(service.Result)?service.Result:"unknown",
  };
}

export async function collectObservations(c, command, optional, now = Date.now()) {
  const [conn,events,tls] = await Promise.all([
    optional(()=>connections(command)),security(c,command,optional,now),
    Promise.all(c.tls.map(async x=>{
      const [certificate, renew] = await Promise.all([checkTls(x,now),renewal(x,command,optional)]);
      return { ...certificate, ...(renew?{renewal:renew}:{}) };
    })),
  ]);
  const db = openStore(c.database);
  try {
    const previous = db.prepare("SELECT at,data FROM snapshots WHERE id='connections'").get();
    const available = conn?.establishedTcp;
    if (conn) {
      const timeline = previous ? (JSON.parse(previous.data).timeline ?? []) : [];
      const kept = timeline.filter(x => x.at >= now - 7*days && x.at < now);
      kept.push({at:now,establishedTcp:available});
      putSnapshot(db,"connections",now,{...conn,status:"observed",timeline:kept.slice(-1100)});
    } else {
      putSnapshot(db,"connectionHealth",now,{status:"unavailable"});
    }
    if (conn) putSnapshot(db,"connectionHealth",now,{status:"ok"});
    putSnapshot(db,"events",now,events);
    putSnapshot(db,"tls",now,tls);
  } finally { db.close(); }
}
