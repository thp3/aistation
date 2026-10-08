import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {sendAndWait} from './queue-test-helper.js';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function serve(s){s.listen(0,'127.0.0.1');await once(s,'listening');return s.address().port}
async function emptyPort(){const srv=createServer();const port=await serve(srv);await new Promise(r=>srv.close(r));return port}
async function awaitReady(base,proc){
 for(let i=0;i<90;i++){
   if(proc.exitCode!==null)throw new Error('Server exited unexpectedly');
   try{if((await fetch(base+'/api/me')).status===401)return}catch{}
   await sleep(50);
 }
 throw Error('Server did not become ready');
}

test('detached SSE survives browser close and edits, deletes, rewinds actual context', {timeout:30000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aistation-detached-'));
 const requests=[];
 let upstreamInterrupted=false;
 let delayedComplete=false;
 const upstream=createServer(async(req,res)=>{
  if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'mock-model'}]}));return}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push(body);
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
  const last=body.messages.at(-1)?.content;
  const event=(content,finish_reason=null)=>'data: '+JSON.stringify({choices:[{delta:{content},finish_reason}]})+'\n\n';
  if(last==='背景測試'){
   res.write(event('部分'));
   let finished=false;
   res.on('close',()=>{if(!finished)upstreamInterrupted=true});
   setTimeout(()=>{finished=true;delayedComplete=true;if(!res.destroyed)res.end(event('完成','stop')+'data: [DONE]\n\n')},450);
  }else res.end(event('答覆','stop')+'data: [DONE]\n\n');
 });
 const upstreamPort=await serve(upstream);
 const port=await emptyPort();
 const base='http://127.0.0.1:'+port;
 const child=spawn(process.execPath,['server/index.js'],{
  cwd:project,env:{...process.env,DATA_DIR:dir,HOST:'127.0.0.1',PORT:String(port),
   ADMIN_USERNAME:'testadmin',ADMIN_PASSWORD:'testing-long-password-54321',
   SESSION_SECRET:'testing-session-secret-54321-long-enough',
   DATA_ENCRYPTION_KEY:'testing-encryption-secret-54321-long-enough'},
  stdio:['ignore','pipe','pipe'],windowsHide:true
 });
 let stderr='';child.stderr.on('data',d=>stderr+=d);child.stdout.on('data',()=>{});
 try{
  await awaitReady(base,child);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'testadmin',password:'testing-long-password-54321'})});
  assert.equal(login.status,200,stderr);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  async function request(url,method='GET',payload){
   if(method==='POST'&&url.endsWith('/send'))return sendAndWait(base,cookie,request,url.split('/')[2],payload);
   const response=await fetch(base+'/api'+url,{
    method,headers:{Cookie:cookie,'Content-Type':'application/json'},
    ...(payload===undefined?{}:{body:JSON.stringify(payload)})
   });
   const text=await response.text();
   return {status:response.status,data:response.headers.get('content-type')?.includes('text/event-stream')?text:JSON.parse(text)};
  }
  assert.equal((await request('/generations')).data.active.length,0);
  const provider=await request('/providers','POST',{name:'mock',protocol:'openai',endpoint:'http://127.0.0.1:'+upstreamPort+'/v1/chat/completions',api_key:'test'});
  assert.equal(provider.status,201);
  const chat=await request('/conversations','POST',{title:'測試對話',provider_id:provider.data.id,model_id:'mock-model'});
  assert.equal(chat.status,201);
  const cid=chat.data.id;
  const cursor=(await request('/conversations/'+cid)).data.event_cursor;
  const response=await fetch(base+'/api/conversations/'+cid+'/send',{
   method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({content:'背景測試',idempotency_key:randomUUID()})
  });
  assert.equal(response.status,202);
  const eventsResponse=await fetch(base+'/api/conversations/'+cid+'/events?after='+cursor,{headers:{Cookie:cookie}});
  const reader=eventsResponse.body.getReader();
  const first=await reader.read();
  assert.match(new TextDecoder().decode(first.value),/event: started/);
  // Browser loses the network link, but the upstream stream must keep going.
  await reader.cancel();
  assert.equal((await request('/generations')).data.active[0].conversation_id,cid);
  assert.equal((await request('/conversations/'+cid+'/messages/does-not-exist','DELETE')).status,409);
  assert.equal((await request('/conversations/'+cid+'/rewind','POST',{message_id:'irrelevant'})).status,409);
  let finished=false;
  for(let i=0;i<60;i++){
   const active=(await request('/generations')).data.active;
   if(!active.length){finished=true;break}
   await sleep(50);
  }
  assert.ok(finished,'Background generation continued to completion');
  assert.ok(delayedComplete,'provider completed request');
  assert.equal(upstreamInterrupted,false,'browser closing must not close upstream');
  const stored=(await request('/conversations/'+cid)).data;
  assert.deepEqual(stored.messages.map(m=>m.role),['user','assistant']);
  assert.equal(stored.messages[1].content,'部分完成');
  assert.equal(stored.messages[1].status,'complete');
  assert.equal(stored.requests[0].status,'complete');
  const userId=stored.messages[0].id,assistantId=stored.messages[1].id;
  assert.equal((await request('/conversations/'+cid+'/messages/'+userId,'PATCH',{content:'已修改的問題'})).status,200);
  assert.equal((await request('/conversations/'+cid+'/messages/'+assistantId,'DELETE')).status,200);
  const next=await request('/conversations/'+cid+'/send','POST',{content:'追問'});
  assert.match(next.data,/event: complete/);
  assert.deepEqual(requests.at(-1).messages.map(m=>m.content),['已修改的問題','追問']);
  const revised=(await request('/conversations/'+cid)).data;
  assert.equal(revised.messages.length,3);
  const turn2= revised.messages[1].id;
  const rewind=await request('/conversations/'+cid+'/rewind','POST',{message_id:turn2});
  assert.equal(rewind.status,200);
  assert.equal(rewind.data.rewound_text,'追問');
  assert.equal(rewind.data.removed_count,2);
  const rewound=(await request('/conversations/'+cid)).data;
  assert.deepEqual(rewound.messages.map(m=>m.content),['已修改的問題']);
  assert.equal(rewound.requests.length,2,'historical request accounting remains');
  const last=await request('/conversations/'+cid+'/send','POST',{content:'重寫的追問'});
  assert.match(last.data,/event: complete/);
  assert.deepEqual(requests.at(-1).messages.map(m=>m.content),['已修改的問題','重寫的追問']);
  assert.equal((await request('/conversations/'+cid+'/rewind','POST',{message_id:(await request('/conversations/'+cid)).data.messages.at(-1).id})).status,400);
  assert.equal((await request('/conversations/'+cid+'/messages/'+userId,'PATCH',{content:'  '})).status,400);
 }finally{
  child.kill();
  await new Promise(resolve=>{
   if(child.exitCode!==null)return resolve();
   child.once('exit',resolve);setTimeout(resolve,2000);
  });
  await new Promise(resolve=>upstream.close(resolve));
  try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200})}
  catch(e){if(process.platform!=='win32'||e.code!=='EPERM')throw e}
 }
});
