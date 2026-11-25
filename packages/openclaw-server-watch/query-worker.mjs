import { readFileSync } from "node:fs";
import { openStore } from "./store.mjs";
import { query } from "./queries.mjs";

function result() {
  try {
    const raw=readFileSync(0,"utf8");
    if(Buffer.byteLength(raw)>8192)return {ok:false,error:"invalid_request"};
    const {name,params}=JSON.parse(raw);
    if(typeof name!=="string"||!params||typeof params!=="object"||Array.isArray(params))return {ok:false,error:"invalid_request"};
    const db=openStore(process.argv[2],true);
    try { return {ok:true,...query(db,name,params)}; }
    finally { db.close(); }
  } catch(error) {
    const message=error?.message;
    const code=message==="no_samples"?"no_samples":
      typeof message==="string"&&message.startsWith("invalid_")?"invalid_request":"server_watch_unavailable";
    return {ok:false,error:code};
  }
}
process.stdout.write(JSON.stringify(result()));
