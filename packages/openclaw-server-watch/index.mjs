import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { openStore, MAX_HOURS } from "./store.mjs";
import { query } from "./queries.mjs";

const id="server-watch";
const manifest=JSON.parse(readFileSync(new URL("./openclaw.plugin.json",import.meta.url),"utf8"));
const levels=["UNKNOWN","LOW","MEDIUM","HIGH","CRITICAL"];
const component={type:"string",maxLength:128};
const severity={type:"string",enum:levels};
const limit={type:"integer",minimum:1,maximum:100};
const stamp={type:"string",maxLength:35,description:"UTC date or ISO timestamp with a time zone"};
const exploitedOnly={type:"boolean"};

const definitions = [
  ["server_health","Current state of the explicitly monitored systemd services and Docker containers.",{}],
  ["server_connections","Counts and listener scopes for host sockets. Includes a bounded series of recent established TCP counts.",{}],
  ["server_security_events","Summarized SSH and Fail2ban observations. Counts are limited by log retention and collector permissions.",{}],
  ["server_tls","Recently observed TLS certificate expiry and verification status of configured endpoints.",{}],
  ["server_resources","Host CPU, I/O wait, RAM, swap, filesystems, GPU and highest CPU/memory/swap workloads in a bounded window.",
    {hours:{type:"integer",minimum:1,maximum:MAX_HOURS},to:stamp,top:{type:"integer",minimum:1,maximum:20}}],
  ["server_vulnerabilities","Match Debian vulnerability entries against exact installed source package versions and the running kernel. Report coverage gaps separately.",
    {component,minimumSeverity:severity,limit,exploitedOnly,firstObservedAfter:stamp}],
  ["server_advisories","Search cached NVD publications by time, CVSS severity and affected component. Annotated with CISA KEV.",
    {component,minimumSeverity:severity,limit,exploitedOnly,from:stamp,to:stamp}],
];

function permitted(api, agentId) {
  const live=api.runtime.config.current().plugins?.entries?.[id];
  const c=live?.config;
  if (!agentId||live?.enabled===false||c?.agentId!==agentId||typeof c.database!=="string"||!isAbsolute(c.database)) return;
  return c.database;
}

export default defineToolPlugin({
  id,name:manifest.name,description:manifest.description,activation:manifest.activation,configSchema:manifest.configSchema,
  tools: (register) => definitions.map(([name,description,properties]) => {
    const parameters={type:"object",additionalProperties:false,properties};
    return register({name,description,parameters,optional:true,workspaceAccess:false,factory:({api,toolContext}) => {
      if (!permitted(api,toolContext.agentId)) return;
      return { name,label:name,description,parameters,execute:async (_id,params,signal) => {
        try {
          signal?.throwIfAborted();
          toolContext.assertInvocationCurrent?.();
          const file=permitted(api,toolContext.agentId);
          if (!file) return jsonResult({ok:false,error:"server_watch_denied"});
          const db=openStore(file,true);
          try {
            const payload=query(db,name,params??{});
            return jsonResult({ok:true,...payload});
          } finally {db.close();}
        } catch (error) {
          const message=error?.message;
          const code=error?.name==="AbortError"?"request_cancelled":message==="no_samples"?"no_samples":
            typeof message==="string"&&message.startsWith("invalid_")?"invalid_request":"server_watch_unavailable";
          return jsonResult({ok:false,error:code});
        }
      }};
    }});
  }),
});
