import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readEvents} from './queue-test-helper.js';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function listen(s){s.listen(0,'127.0.0.1');await once(s,'listening');return s.address().port}
async function port(){const s=createServer();const p=await listen(s);await new Promise(r=>s.close(r));return p}
async function ready(base,proc){
 for(let i=0;i<120;i++){
  if(proc.exitCode!==null)throw Error('Server exited at startup');
  try{if((await fetch(base+'/api/me')).status===401)return}catch{}
  await sleep(50);
 }
 throw Error('Server did not start');
}
async function spawnApp(dataDir,p){
 const child=spawn(process.execPath,['server/index.js'],{
  cwd:project,env:{...process.env,DATA_DIR:dataDir,HOST:'127.0.0.1',PORT:String(p),
   ADMIN_USERNAME:'queueadmin',ADMIN_PASSWORD:'strong-test-password-123456',
   SESSION_SECRET:'test-session-secret-long-432111111111111111',
   DATA_ENCRYPTION_KEY:'test-data-secret-long-433222222222222222'},
  stdio:['ignore','pipe','pipe'],windowsHide:true
 });
 let stderr='';child.stderr.on('data',c=>stderr+=c);child.stdout.on('data',()=>{});
 await ready('http://127.0.0.1:'+p,child);
 return {child,stderr:()=>stderr};
}
async function terminate(proc){
 proc.kill();
 await new Promise(resolve=>{
  if(proc.exitCode!==null)return resolve();
  proc.once('exit',resolve);setTimeout(resolve,3000);
 });
}
test('FIFO, idempotency, SSE cursor replay and first-turn automatic title', {timeout:35000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aistation-queue-naming-'));
 const calls=[],nameCalls=[];
 const upstream=createServer(async(req,res)=>{
  if(req.url==='/v1/models'){
   res.setHeader('Content-Type','application/json');
   res.end(JSON.stringify({data:[{id:'chat-model'},{id:'title-model'}]}));return;
  }
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());
  if(body.stream===false){
   nameCalls.push(body);
   res.setHeader('Content-Type','application/json');
   res.end(JSON.stringify({choices:[{message:{content:'「 Node.js 平台設計 」'}}],
      usage:{prompt_tokens:14,completion_tokens:6,total_tokens:20}}));
   return;
  }
  const content=body.messages.at(-1)?.content;
  calls.push(content);
  if(content==='API error'){
   res.writeHead(429,{'Content-Type':'application/json'});
   res.end(JSON.stringify({error:{code:'quota',message:'quota exceeded'}}));return;
  }
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const finish=()=>{if(!res.destroyed)res.end(
    'data: '+JSON.stringify({choices:[{delta:{content:'答覆 '+content},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:4,total_tokens:11}})+'\n\n'+
    'data: [DONE]\n\n'
   )};
  if(content==='slow first'||content==='never finish'){
   if(content==='slow first')setTimeout(finish,380);
   // never finish holds connection open for restart testing.
  }else finish();
 });
 const upstreamPort=await listen(upstream),serverPort=await port();
 let proc;
 try{
  ({child:proc}=await spawnApp(dir,serverPort));
  const base='http://127.0.0.1:'+serverPort;
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({username:'queueadmin',password:'strong-test-password-123456'})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const req=async(uri,method='GET',payload)=>{
   const r=await fetch(base+'/api'+uri,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},
    ...(payload===undefined?{}:{body:JSON.stringify(payload)})});
   return {status:r.status,data:await r.json()};
  };
  const provider=await req('/providers','POST',{name:'upstream',protocol:'openai',endpoint:'http://127.0.0.1:'+upstreamPort+'/v1/chat/completions',api_key:'test'});
  assert.equal(provider.status,201);
  const models=(await req('/models')).data;
  const titleModel=models.find(x=>x.model_id==='title-model');
  assert.ok(titleModel?.id);
  assert.equal((await req('/settings','PATCH',{naming_model_id:titleModel.id})).status,200);
  const convo=(await req('/conversations','POST',{provider_id:provider.data.id,model_id:'chat-model',system_prompt:'系統上下文：專注軟體架構'})).data;
  const cid=convo.id;
  assert.equal(convo.title,'新的對話');
  const key=randomUUID(),secondKey=randomUUID(),thirdKey=randomUUID();
  const first=await req('/conversations/'+cid+'/send','POST',{idempotency_key:key,content:'slow first'});
  assert.equal(first.status,202);
  assert.equal(first.data.request_id,key);
  const duplicate=await req('/conversations/'+cid+'/send','POST',{idempotency_key:key,content:'slow first'});
  assert.equal(duplicate.status,200);
  assert.equal(duplicate.data.deduplicated,true);
  const conflict=await req('/conversations/'+cid+'/send','POST',{idempotency_key:key,content:'different'});
  assert.equal(conflict.status,409);
  const second=await req('/conversations/'+cid+'/send','POST',{idempotency_key:secondKey,content:'second'});
  assert.equal(second.status,202);
  const third=await req('/conversations/'+cid+'/send','POST',{idempotency_key:thirdKey,content:'cancel me'});
  assert.equal(third.status,202);
  assert.equal((await req('/conversations/'+cid+'/queue/'+thirdKey,'DELETE')).status,200);
  let secondDone=false;
  for(let i=0;i<120;i++){
   if((await req('/conversations/'+cid+'/jobs/'+secondKey)).data.state==='complete'){secondDone=true;break}
   await sleep(55);
  }
  assert.ok(secondDone,'second FIFO job completed');
  assert.deepEqual(calls,['slow first','second']);
  assert.equal((await req('/conversations/'+cid+'/jobs/'+thirdKey)).data.state,'cancelled');
  let title=null;
  for(let i=0;i<80;i++){
   const c=(await req('/conversations/'+cid)).data;
   if(c.title==='Node.js 平台設計'){title=c;break}
   await sleep(50);
  }
  assert.ok(title,'first-turn title was assigned');
  assert.equal(nameCalls.length,1,'auto naming runs exactly once');
  assert.match(JSON.stringify(nameCalls[0]),/系統上下文：專注軟體架構/);
  assert.match(JSON.stringify(nameCalls[0]),/slow first/);
  assert.match(JSON.stringify(nameCalls[0]),/答覆 slow first/);
  assert.equal(title.requests.filter(r=>r.kind==='naming').length,1);
  assert.equal(title.requests.find(r=>r.kind==='naming').total_tokens,20);
  const firstEvents=await readEvents(base,cookie,cid,0,(event,payload)=>event==='complete'&&payload.request_id===key);
  const ids=[...firstEvents.matchAll(/^id: (\d+)$/gm)].map(x=>Number(x[1]));
  const cursor=Math.max(...ids);
  assert.ok(Number.isFinite(cursor));
  assert.match(firstEvents,/event: queued/);
  // SSE reconnect: Last-Event-ID overrides an older query cursor.
  const replay=await fetch(base+'/api/conversations/'+cid+'/events?after=0',{headers:{Cookie:cookie,'Last-Event-ID':String(cursor)}});
  const reader=replay.body.getReader();let data='';
  for(let i=0;i<10&&!data.includes('event: complete');i++){
   const part=await reader.read();if(part.done)break;
   data+=new TextDecoder().decode(part.value);
  }
  await reader.cancel();
  assert.match(data,/event: complete/);
  assert.ok([...data.matchAll(/^id: (\d+)$/gm)].every(x=>Number(x[1])>cursor),'replay starts after supplied cursor');
  const failConvo=(await req('/conversations','POST',{provider_id:provider.data.id,model_id:'chat-model'})).data;
  const bad=randomUUID(),next=randomUUID();
  assert.equal((await req('/conversations/'+failConvo.id+'/send','POST',{idempotency_key:bad,content:'API error'})).status,202);
  assert.equal((await req('/conversations/'+failConvo.id+'/send','POST',{idempotency_key:next,content:'after error'})).status,202);
  for(let i=0;i<70;i++){
   if((await req('/conversations/'+failConvo.id+'/jobs/'+bad)).data.state==='error')break;
   await sleep(50);
  }
  assert.equal((await req('/conversations/'+failConvo.id)).data.queue.paused,true);
  assert.equal((await req('/conversations/'+failConvo.id+'/jobs/'+next)).data.state,'queued');
  assert.equal((await req('/conversations/'+failConvo.id+'/queue/resume','POST')).status,200);
  for(let i=0;i<70;i++){
   if((await req('/conversations/'+failConvo.id+'/jobs/'+next)).data.state==='complete')break;
   await sleep(50);
  }
  assert.equal((await req('/conversations/'+failConvo.id+'/jobs/'+next)).data.state,'complete');
  // A manually set title is not overwritten when the naming request is eligible.
  const manual=(await req('/conversations','POST',{provider_id:provider.data.id,model_id:'chat-model'})).data;
  await req('/conversations/'+manual.id,'PATCH',{title:'我的人工標題'});
  const manualKey=randomUUID();
  await req('/conversations/'+manual.id+'/send','POST',{idempotency_key:manualKey,content:'manual'});
  for(let i=0;i<70;i++){
   if((await req('/conversations/'+manual.id+'/jobs/'+manualKey)).data.state==='complete')break;
   await sleep(50);
  }
  assert.equal((await req('/conversations/'+manual.id)).data.title,'我的人工標題');
  assert.equal(nameCalls.length,2,'error conversation may still be named, manual title is skipped');
 }finally{
  if(proc)await terminate(proc);
  await new Promise(resolve=>upstream.close(resolve));
  try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200})}
  catch(e){if(process.platform!=='win32'||e.code!=='EPERM')throw e}
 }
});
