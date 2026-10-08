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
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function listen(s){s.listen(0,'127.0.0.1');await once(s,'listening');return s.address().port}
async function port(){const s=createServer();const p=await listen(s);await new Promise(r=>s.close(r));return p}
async function launch(dir,p){
 const proc=spawn(process.execPath,['server/index.js'],{cwd:project,
  env:{...process.env,DATA_DIR:dir,PORT:String(p),HOST:'127.0.0.1',ADMIN_USERNAME:'restartadmin',
    ADMIN_PASSWORD:'restart-secret-password-1234',SESSION_SECRET:'stable-test-session-secret-01234567890000',
    DATA_ENCRYPTION_KEY:'stable-test-database-secret-01234567890000'},
  stdio:['ignore','pipe','pipe'],windowsHide:true});
 let stderr='';proc.stderr.on('data',b=>stderr+=String(b));proc.stdout.on('data',()=>{});
 for(let i=0;i<100;i++){
  if(proc.exitCode!==null)throw Error('Process exited early: '+stderr);
  try{if((await fetch('http://127.0.0.1:'+p+'/api/me')).status===401)return proc}catch{}
  await sleep(60);
 }
 throw Error('Service failed to start: '+stderr);
}
async function stopProcess(p){
 if(!p)return;
 p.kill();
 await new Promise(r=>{if(p.exitCode!==null)return r();p.once('exit',r);setTimeout(r,2000)});
}
test('recovery does not retry ambiguous in-flight request; pending queue resumes after restart', {timeout:20000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aistation-restart-'));
 const calls=[];
 const upstream=createServer(async(req,res)=>{
  if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'model'}]}));return}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString());
  const content=body.messages.at(-1).content;calls.push(content);
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  if(content==='running when restart'){
   res.write('data: '+JSON.stringify({choices:[{delta:{content:'不完整'},finish_reason:null}]})+'\n\n');
   return;
  }
  res.end('data: '+JSON.stringify({choices:[{delta:{content:'成功完成'},finish_reason:'stop'}]})+'\n\n'+'data: [DONE]\n\n');
 });
 const up=await listen(upstream),httpPort=await port(),base='http://127.0.0.1:'+httpPort;
 let proc=null;
 try{
  proc=await launch(dir,httpPort);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({username:'restartadmin',password:'restart-secret-password-1234'})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const req=async(uri,method='GET',payload)=>{
   const res=await fetch(base+'/api'+uri,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},
    ...(payload===undefined?{}:{body:JSON.stringify(payload)})});
   return {status:res.status,data:await res.json()};
  };
  const provider=await req('/providers','POST',{name:'test',protocol:'openai',endpoint:'http://127.0.0.1:'+up+'/v1/chat/completions',api_key:'test-key'});
  assert.equal(provider.status,201);
  const chat=(await req('/conversations','POST',{provider_id:provider.data.id,model_id:'model'})).data;
  const a=randomUUID(),b=randomUUID();
  assert.equal((await req('/conversations/'+chat.id+'/send','POST',{idempotency_key:a,content:'running when restart'})).status,202);
  for(let i=0;i<80;i++){
   if((await req('/conversations/'+chat.id+'/jobs/'+a)).data.state==='running')break;
   await sleep(30);
  }
  assert.equal((await req('/conversations/'+chat.id+'/jobs/'+a)).data.state,'running');
  assert.equal((await req('/conversations/'+chat.id+'/send','POST',{idempotency_key:b,content:'queued across restart'})).status,202);
  await stopProcess(proc);proc=null;
  proc=await launch(dir,httpPort);
  const restarted=(await req('/conversations/'+chat.id)).data;
  assert.equal((await req('/conversations/'+chat.id+'/jobs/'+a)).data.state,'error');
  assert.equal((await req('/conversations/'+chat.id+'/jobs/'+b)).data.state,'queued');
  assert.equal(restarted.queue.paused,true,'automatic retry must be paused after ambiguous call');
  assert.equal(restarted.requests[0].provider_error_code,'SERVER_RESTARTED');
  const events=await readEvents(base,cookie,chat.id,0,(event,payload)=>event==='error'&&payload.request_id===a);
  assert.match(events,/SERVER_RESTARTED/);
  assert.equal(calls.filter(c=>c==='running when restart').length,1);
  assert.equal((await req('/conversations/'+chat.id+'/queue/resume','POST')).status,200);
  for(let i=0;i<90;i++){
   if((await req('/conversations/'+chat.id+'/jobs/'+b)).data.state==='complete')break;
   await sleep(40);
  }
  assert.equal((await req('/conversations/'+chat.id+'/jobs/'+b)).data.state,'complete');
  assert.deepEqual(calls,['running when restart','queued across restart']);
  assert.equal((await req('/conversations/'+chat.id+'/send','POST',{idempotency_key:b,content:'queued across restart'})).data.deduplicated,true);
 }finally{
  if(proc)await stopProcess(proc);
  await new Promise(r=>upstream.close(r));
  try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:150})}
  catch(e){if(process.platform!=='win32'||e.code!=='EPERM')throw e}
 }
});
