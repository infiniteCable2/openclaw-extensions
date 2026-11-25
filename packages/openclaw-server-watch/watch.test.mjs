import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { compareDebian, correlateDebian, projectKev, projectNvd, advisoryQuery, fetchNvd, mergeNvd, packageRows } from "./advisories.mjs";
import { intervals, resourceReport } from "./metrics.mjs";
import { cpuCounters, settings } from "./collector.mjs";
import { banCounts, connections, loginCounts } from "./observations.mjs";
import { openStore, putSample,putSnapshot,snapshot,hour,minute } from "./store.mjs";
import { query } from "./queries.mjs";
import { querySocket } from "./socket.mjs";

test("complete Debian version order and source package identity", () => {
  const pairs=[["1:1.0-2","2.0-1",1],["1.2~rc1-1","1.2-1",-1],
    ["1.2-1~bpo13+1","1.2-1",-1],["1.2-1+deb13u10","1.2-1+deb13u2",1],
    ["1.0","1.0-0",0],["1.0-001","1.0-1",0],["1.0+a","1.0a",1]];
  for (const [a,b,ordering] of pairs) {
    assert.equal(compareDebian(a,b),ordering);
    assert.equal(compareDebian(b,a),ordering===0?0:-ordering);
  }
  const lines=["libexample:amd64\texample\t1:2.4-1\tinstalled","example-extra\texample\t1:2.4-2\tconfig-files"];
  assert.deepEqual(packageRows(lines.join("\n")),[{binary:"libexample:amd64",source:"example",version:"1:2.4-1"}]);
});

test("fixed versions, backports and old running kernel are distinct", () => {
  const feed={
    linux:{"CVE-2026-1234":{releases:{trixie:{status:"resolved",fixed_version:"6.12.45-1",urgency:"high"}}}},
    example:{
      "CVE-2026-3456":{releases:{trixie:{status:"open",urgency:"medium"}}},
      "CVE-2026-9999":{releases:{trixie:{status:"resolved",fixed_version:"0"}}},
      "CVE-2026-8888":{releases:{trixie:{status:"undetermined"}}},
    },
  };
  const kernel=packageRows("linux-image-6.12-test\tlinux-signed-amd64\t6.12.46-1+1\tinstalled\tlinux (= 6.12.46-1)")[0];
  assert.equal(kernel.builtLinux,"6.12.46-1");
  const result=correlateDebian(feed,"trixie",[kernel,{source:"example",version:"1.4-3"}],
    {source:"linux",version:"6.12.44-1"});
  assert.equal(result.coverageUnknown,1);
  assert.deepEqual(result.findings.map(x=>x.id),["CVE-2026-1234","CVE-2026-3456"]);
  assert.equal(result.findings[0].kernelRunning,true);
  assert.throws(()=>correlateDebian(feed,"unknown",[{source:"linux",version:"6.12.46-1"}]),/unsupported_distribution_release/);
});

test("public advisory lookups carry no local inventory and retain coverage and date semantics", async () => {
  const now=Date.parse("2026-02-08T12:00:00Z");
  const fake={cve:{id:"CVE-2026-1234",published:"2026-02-07T08:00:00Z",lastModified:"2026-02-07T12:00:00Z",
    descriptions:[{lang:"en",value:"untrusted instructions"}],
    metrics:{cvssMetricV31:[{type:"Primary",cvssData:{baseSeverity:"CRITICAL",baseScore:9.8}}]},
    configurations:[{nodes:[{cpeMatch:[{vulnerable:true,criteria:"cpe:2.3:a:example:library:*:*:*:*:*:*:*:*"}]}]}],
  }};
  const nvd=await fetchNvd(now,async u=>{
    assert.equal(u.host,"services.nvd.nist.gov");
    assert.deepEqual([...u.searchParams.keys()].filter(x=>x!=="startIndex"),["pubStartDate","pubEndDate","resultsPerPage"]);
    return {totalResults:1,vulnerabilities:[fake]};
  });
  const kev=projectKev({vulnerabilities:[{cveID:"CVE-2026-1234",dateAdded:"2026-02-08"}]});
  const r=advisoryQuery(nvd,kev,{from:now-30*hour,to:now,minimum:"HIGH",component:"library",exploitedOnly:true});
  assert.equal(r.coveredPublicationWindow,true);
  assert.equal(r.entries[0].knownExploitedSince,"2026-02-08");
  assert.equal(r.entries[0].cvss,9.8);
  assert.equal(projectNvd({cve:{...fake.cve,published:"2026-02-07T08:00:00.000"}}).published,"2026-02-07T08:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(r),/untrusted instructions/);
  assert.equal(projectNvd({cve:{...fake.cve,vulnStatus:"Rejected"}}),undefined);
});

test("daily NVD updates extend coverage only when the snapshots overlap",()=>{
  const now=Date.parse("2026-02-08T12:00:00Z");
  const prior={from:now-60*hour,to:now-24*hour,complete:true,entries:[
    {id:"CVE-2026-1234",published:new Date(now-48*hour).toISOString()},
  ]};
  const current={from:now-36*hour,to:now,total:1,complete:true,entries:[
    {id:"CVE-2026-9876",published:new Date(now-12*hour).toISOString()},
  ]};
  assert.equal(mergeNvd(prior,current).from,prior.from);
  assert.equal(mergeNvd(prior,current).entries.length,2);
  assert.equal(mergeNvd({...prior,to:now-38*hour},current).from,current.from);
  assert.equal(mergeNvd({...prior,complete:false},current).from,current.from);
});

test("resource calculations handle multi-core use and discard reboot or service-reset deltas", () => {
  const before={boot:"boot-a",cpu:cpuCounters("cpu 10 0 20 70 10 0 0 0"),workloads:{app:{instance:"one",cpuUsec:0}}};
  const after={boot:"boot-a",cpu:cpuCounters("cpu 40 0 20 130 20 0 0 0"),workloads:{app:{instance:"one",cpuUsec:120_000_000,memoryBytes:1000}}};
  const interval=intervals(before,after,60000);
  assert.equal(interval.busyPercent,30);
  assert.equal(interval.ioWaitPercent,10);
  assert.equal(interval.workloads.app.cpuCorePercent,200);
  assert.equal(intervals(before,{...after,boot:"boot-b"},60000).busyPercent,undefined);
  after.workloads.app.instance="two";
  assert.equal(intervals(before,after,60000).workloads.app.cpuCorePercent,undefined);
});

test("SQLite aggregation is bounded, read-only and reports stale observations", () => {
  const root=mkdtempSync(join(tmpdir(),"server-watch-unit-"));
  const filename=join(root,"test.db");
  const now=Date.parse("2026-01-02T12:00:00Z");
  const at=now-2*minute;
  const db=openStore(filename);
  try {
    const sample={busyPercent:15,memoryUsedBytes:6000,swapUsedBytes:0,workloads:{app:{cpuCorePercent:250,cpuIntervalMs:60000,memoryBytes:5000}},
      filesystems:[{id:"root",usedBytes:1200,availableBytes:1300}],gpu:[{id:"gpu",state:"suspended"}]};
    putSample(db,at,sample,{boot:"opaque"});
    putSample(db,at,{...sample,busyPercent:90},{boot:"replacement"});
    putSnapshot(db,"feedHealth",now,{debian:{status:"unavailable"}});
    assert.deepEqual(snapshot(db,"lastCounters").data,{boot:"opaque"});
    const readonly=openStore(filename,true);
    try {
      const r=resourceReport(readonly,now-hour,now);
      assert.equal(r.samples,1);
      assert.equal(r.host.busyPercent.average,15);
      assert.equal(r.topCpu[0].cpuCorePercent.peak,250);
      assert.equal(r.filesystems[0].usedBytes.peak,1200);
      assert.deepEqual(r.gpuLatestState,[{id:"gpu",state:"suspended"}]);
      assert.equal(query(readonly,"server_vulnerabilities",{},now).sources.debian.lastAttempt,"unavailable");
      assert.throws(()=>query(readonly,"server_resources",{hours:1680},now),/invalid_resources_window/);
      assert.throws(()=>putSnapshot(readonly,"health",now,{}),/readonly/i);
    } finally { readonly.close(); }
  } finally {db.close();rmSync(root,{recursive:true,force:true});}
});

test("security observations expose counts and scopes instead of identities or command lines",async () => {
  const now=Date.parse("2026-03-05T14:30:00");
  const s=banCounts(["2026-03-05 14:10:00,001 fail2ban.actions [120]: NOTICE [sshd] Ban 192.0.2.8",
    "2026-03-05 14:11:00,002 fail2ban.filter [120]: INFO [sshd] Found 192.0.2.8",
    "2026-02-25 14:10:00,001 fail2ban.actions [120]: NOTICE [sshd] Ban 192.0.2.8"],["sshd"],now);
  assert.equal(s.sshd.ban,1);
  assert.equal(s.sshd.found,1);
  assert.doesNotMatch(JSON.stringify(s),/192\.0\.2/);
  assert.equal(loginCounts(["Accepted publickey for sample from 192.0.2.8"]).accepted,1);
  const r=await connections(async (_cmd,a)=>{
    if (a.includes("established")) return "0 0 192.0.2.8:22 192.0.2.9:5550\n";
    if (a.includes("-4")) return "tcp LISTEN 0 128 127.0.0.1:22 0.0.0.0:*\n";
    return "udp UNCONN 0 0 [::]:443 [::]:*\n";
  });
  assert.equal(r.establishedTcp,1);
  assert.deepEqual(r.listeners,[{network:"tcp",port:22,scope:"loopback",family:4},{network:"udp",port:443,scope:"wildcard",family:6}]);
  assert.doesNotMatch(JSON.stringify(r),/192\.0\.2/);
});

test("collector configuration only accepts fixed host target forms",()=>{
  const database=join(tmpdir(),"test.db");
  assert.throws(()=>settings({database,units:[{id:"test",unit:"--help"}]}),/invalid_settings/);
  assert.throws(()=>settings({database,gpus:[{id:"test",pci:"../../sys"}]}),/invalid_settings/);
  assert.throws(()=>settings({database,containers:[{id:"test",container:"--format"}]}),/invalid_settings/);
  assert.equal(settings({database}).filesystems[0].path,"/");
});

test("query transport sends a bounded request and propagates a peer denial", async ()=>{
  const root=mkdtempSync(join(tmpdir(),"server-watch-socket-"));
  const endpoint=process.platform==="win32"
    ? "\\\\.\\pipe\\server-watch-test-"+process.pid
    : join(root,"query.sock");
  let received;
  const server=createServer(conn=>{
    conn.once("data",bytes=>{
      received=JSON.parse(bytes.toString());
      conn.end(JSON.stringify({ok:false,error:"server_watch_peer_denied"}));
    });
  });
  try{
    server.listen(endpoint);
    await once(server,"listening");
    const result=await querySocket(endpoint,"server_health",{});
    assert.deepEqual(received,{name:"server_health",params:{}});
    assert.equal(result.error,"server_watch_peer_denied");
    assert.throws(()=>querySocket(endpoint,"server_health",{input:"a".repeat(9000)}),/invalid_request/);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    rmSync(root,{recursive:true,force:true});
  }
});
