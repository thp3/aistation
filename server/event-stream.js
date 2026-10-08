// Bound slow clients instead of allowing res.write() to grow process memory indefinitely.
export function eventStream(res,{maxBuffer=1024*1024}={}){
 res.status(200).set({'Content-Type':'text/event-stream; charset=utf-8','Connection':'keep-alive','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'});
 res.flushHeaders();res.write('retry: 1500\n\n');
 let blocked=false,bytes=0,closed=false,queue=[];
 const send=frame=>{
  if(closed||res.destroyed||res.writableEnded)return;
  if(blocked){bytes+=Buffer.byteLength(frame);if(bytes>maxBuffer){closed=true;queue=[];res.destroy();return}queue.push(frame)}
  else blocked=!res.write(frame);
 };
 res.on('drain',()=>{blocked=false;while(queue.length&&!blocked){const frame=queue.shift();bytes-=Buffer.byteLength(frame);blocked=!res.write(frame)}});
 const heartbeat=setInterval(()=>send(': heartbeat\n\n'),15000);heartbeat.unref();
 res.on('close',()=>{closed=true;queue=[];clearInterval(heartbeat)});
 return e=>send(`${e.seq?`id: ${e.seq}\n`:''}event: ${e.event}\ndata: ${JSON.stringify(e.payload)}\n\n`);
}
