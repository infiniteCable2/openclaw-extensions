import { createConnection } from "node:net";

const MAX_REQUEST = 8 * 1024;
const MAX_REPLY = 512 * 1024;

export function querySocket(path, name, params, signal) {
  signal?.throwIfAborted();
  const request = JSON.stringify({ name, params }) + "\n";
  if (Buffer.byteLength(request)>MAX_REQUEST) throw new Error("invalid_request");
  return new Promise((resolve,reject)=>{
    const client=createConnection({path});
    let chunks=[],size=0,settled=false;
    const timer=setTimeout(()=>finish(new Error("server_watch_timeout")),6000);
    const cancelled=()=>finish(signal.reason??new DOMException("Cancelled","AbortError"));
    function finish(error, result) {
      if(settled)return;
      settled=true;
      clearTimeout(timer);
      signal?.removeEventListener("abort",cancelled);
      client.destroy();
      if(error)reject(error);
      else resolve(result);
    }
    signal?.addEventListener("abort",cancelled,{once:true});
    if(signal?.aborted)return cancelled();
    client.on("error",()=>finish(new Error("server_watch_unavailable")));
    client.on("connect",()=>client.write(request));
    client.on("data",chunk=>{
      size+=chunk.length;
      if(size>MAX_REPLY)return finish(new Error("server_watch_reply_too_large"));
      chunks.push(chunk);
    });
    client.on("end",()=>{
      try{
        const result=JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if(!result||typeof result.ok!=="boolean")throw new Error("invalid_reply");
        finish(undefined,result);
      }catch{finish(new Error("server_watch_unavailable"));}
    });
    client.on("close",()=>finish(new Error("server_watch_unavailable")));
  });
}
