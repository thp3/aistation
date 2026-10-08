import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {sendAndWait,readEvents} from './queue-test-helper.js';

async function listen(server) {
 server.listen(0,'127.0.0.1');
 await once(server,'listening');
 return server.address().port;
}
async function availablePort(){
 const s=createServer();const port=await listen(s);await new Promise(resolve=>s.close(resolve));return port;
}
async function untilReady(url,child) {
 for(let i=0;i<80;i++) {
  if(child.exitCode!=null)throw new Error('AI Station exited before ready');
  try{const r=await fetch(url+'/api/me');if(r.status===401)return;}catch{}
  await new Promise(r=>setTimeout(r,60));
 }
 throw Error('AI Station HTTP server did not start');
}

test('request thinking setting reaches OpenAI/Claude mock endpoints and is stored in SQLite', {timeout:30000}, async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'aistation-send-'));
 const received=[];
 const mock=createServer(async(req,res)=>{
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   if(req.url.endsWith('/models')){
     res.writeHead(200,{'Content-Type':'application/json'});
     res.end(JSON.stringify({data:[{id:'gpt-test'},{id:'claude-sonnet-4-6'},{id:'claude-sonnet-4-5-20250929'}]}));
     return;
   }
   if(req.method!=='POST'){res.writeHead(404).end();return;}
   const payload=JSON.parse(Buffer.concat(chunks).toString());
   received.push(payload);
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   if(payload.messages?.at(-1)?.content==='idle timeout'){
     res.write('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'閒置前的思考',content:'閒置前的回答'},finish_reason:null}]})+'\n\n');
     return;
   }
   if(payload.messages?.at(-1)?.content==='stop me'){
     res.write('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'思考一部分',content:'部分答案'},finish_reason:null}]})+'\n\n');
     const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': ping\n\n')},60);
     res.on('close',()=>clearInterval(heartbeat));
     return;
   }
   if(payload.messages?.at(-1)?.content==='missing-done'){
     res.end('data: '+JSON.stringify({choices:[{delta:{content:'未完成'},finish_reason:'stop'}]})+'\n\n');
     return;
   }
   if(req.url.endsWith('/chat/completions')){
     res.end('data: '+JSON.stringify({choices:[{delta:{content:'Hello',reasoning_content:'模型回傳的推理'},finish_reason:null}]})+'\n\n'+
       'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:4,total_tokens:9,completion_tokens_details:{reasoning_tokens:2}}})+'\n\n'+
       'data: [DONE]\n\n');
   }else{
     res.end('data: '+JSON.stringify({type:'message_start',message:{usage:{input_tokens:10}}})+'\n\n'+
       'data: '+JSON.stringify({type:'content_block_delta',delta:{type:'thinking_delta',thinking:'需要仔細思考'}})+'\n\n'+
       'data: '+JSON.stringify({type:'content_block_delta',delta:{type:'signature_delta',signature:'private-signature'}})+'\n\n'+
       'data: '+JSON.stringify({type:'content_block_delta',delta:{type:'text_delta',text:'Hello'}})+'\n\n'+
       'data: '+JSON.stringify({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:7}})+'\n\n'+
       'data: '+JSON.stringify({type:'message_stop'})+'\n\n');
   }
 });
 const mockPort=await listen(mock),port=await availablePort();
 const base='http://127.0.0.1:'+port;
 const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const child=spawn(process.execPath,['server/index.js'],{
  cwd:project,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:tmp,
   ADMIN_USERNAME:'smoketest',ADMIN_PASSWORD:'test-password-is-long-enough',
   SESSION_SECRET:'test-session-key-is-long-enough-123456789',
   DATA_ENCRYPTION_KEY:'test-data-key-is-long-enough-1234567890',
   UPSTREAM_IDLE_TIMEOUT_MS:'10000'},
  stdio:['ignore','pipe','pipe'],windowsHide:true
 });
 let errors='';child.stderr.on('data',x=>errors+=String(x));
 child.stdout.on('data',()=>{});
 try{
   await untilReady(base,child);
   const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({username:'smoketest',password:'test-password-is-long-enough'})});
   assert.equal(login.status,200);
   const cookie=login.headers.get('set-cookie').split(';')[0];
   async function req(uri,method='GET',body) {
     if(method==='POST'&&uri.endsWith('/send'))return sendAndWait(base,cookie,req,uri.split('/')[2],body);
     const response=await fetch(base+'/api'+uri,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},
       ...(body===undefined?{}:{body:JSON.stringify(body)})});
     return {status:response.status,data:response.headers.get('content-type')?.includes('text/event-stream')?await response.text():await response.json()};
   }
   const openai=await req('/providers','POST',{name:'mock-openai',protocol:'openai',endpoint:'http://127.0.0.1:'+mockPort+'/v1/chat/completions',api_key:'sk-test'});
   assert.equal(openai.status,201);assert.equal(openai.data.models_found,3);
   const c=await req('/conversations','POST',{title:'Test',provider_id:openai.data.id,model_id:'gpt-test'});
   assert.equal(c.status,201);
   const sent=await req('/conversations/'+c.data.id+'/send','POST',{content:'Hello',thinking:{mode:'effort',effort:'medium'}});
   assert.match(sent.data,/event: complete/);
   assert.equal(received.at(-1).reasoning_effort,'medium');
   const detail=await req('/conversations/'+c.data.id);
   assert.equal(detail.data.requests[0].thinking_effort,'medium');
   assert.match(sent.data,/event: thinking_delta/);
   assert.equal(detail.data.messages.at(-1).thinking_content,'模型回傳的推理');
   assert.equal(detail.data.requests[0].reasoning_tokens,2);
   const count=detail.data.messages.length;
   const rejected=await req('/conversations/'+c.data.id+'/send','POST',{content:'Nope',thinking:{mode:'budget',budget_tokens:2048}});
   assert.equal(rejected.status,400);
   const afterRejected=await req('/conversations/'+c.data.id);
   assert.equal(afterRejected.data.messages.length,count);
   const brokenConversation=await req('/conversations','POST',{title:'Incomplete',provider_id:openai.data.id,model_id:'gpt-test'});
   const broken=await req('/conversations/'+brokenConversation.data.id+'/send','POST',{content:'missing-done'});
   assert.match(broken.data,/event: error/);
   assert.doesNotMatch(broken.data,/event: complete/);
   const incompleteRecord=await req('/conversations/'+brokenConversation.data.id);
   assert.equal(incompleteRecord.data.messages.at(-1).content,'未完成');
   assert.equal(incompleteRecord.data.messages.at(-1).status,'error');

   const stoppedConversation=await req('/conversations','POST',{title:'Stopped',provider_id:openai.data.id,model_id:'gpt-test'});
   const beforeStop=await req('/conversations/'+stoppedConversation.data.id);
   const streamResponse=await fetch(base+'/api/conversations/'+stoppedConversation.data.id+'/send',{
     method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},
     body:JSON.stringify({content:'stop me',idempotency_key:randomUUID()})
   });
   assert.equal(streamResponse.status,202);
   let stopPromise=null;
   const streamText=await readEvents(base,cookie,stoppedConversation.data.id,beforeStop.data.event_cursor||0,(event)=>{
      if(event==='thinking_delta'&&!stopPromise)stopPromise=req('/conversations/'+stoppedConversation.data.id+'/stop','POST');
      return event==='stopped';
   },{timeout:6000});
   const stop=await stopPromise;
   assert.equal(stop.data.stopping,true);
   assert.match(streamText,/event: stopped/);
   const stoppedSaved=await req('/conversations/'+stoppedConversation.data.id);
   assert.equal(stoppedSaved.data.messages.at(-1).status,'stopped');
   assert.equal(stoppedSaved.data.messages.at(-1).thinking_content,'思考一部分');
   assert.equal(stoppedSaved.data.messages.at(-1).content,'部分答案');

   const idleConversation=await req('/conversations','POST',{title:'Timeout',provider_id:openai.data.id,model_id:'gpt-test'});
   const timedOut=await req('/conversations/'+idleConversation.data.id+'/send','POST',{content:'idle timeout'});
   assert.match(timedOut.data,/event: error/);
   assert.match(timedOut.data,/idle_timeout/);
   const idleRecord=await req('/conversations/'+idleConversation.data.id);
   assert.equal(idleRecord.data.messages.at(-1).status,'error');
   assert.equal(idleRecord.data.messages.at(-1).content,'閒置前的回答');
   assert.equal(idleRecord.data.messages.at(-1).thinking_content,'閒置前的思考');

   const claude=await req('/providers','POST',{name:'mock-claude',protocol:'claude',endpoint:'http://127.0.0.1:'+mockPort+'/v1/messages',api_key:'sk-test'});
   assert.equal(claude.status,201);
   for(const [model,thinking,expectedType] of [
     ['claude-sonnet-4-6',{mode:'effort',effort:'low'},'adaptive'],
     ['claude-sonnet-4-5-20250929',{mode:'budget',budget_tokens:4096},'enabled']
   ]){
     const conversation=await req('/conversations','POST',{title:'Claude',provider_id:claude.data.id,model_id:model});
     const r=await req('/conversations/'+conversation.data.id+'/send','POST',{content:'Hello',thinking});
     assert.match(r.data,/event: complete/);
     assert.equal(received.at(-1).thinking.type,expectedType);
     assert.equal(received.at(-1).thinking.display,'summarized');
     assert.match(r.data,/event: thinking_delta/);
     assert.doesNotMatch(r.data,/private-signature/);
     if(expectedType==='enabled')assert.equal(received.at(-1).thinking.budget_tokens,4096);
     else assert.equal(received.at(-1).output_config.effort,'low');
     const saved=await req('/conversations/'+conversation.data.id);
     assert.equal(saved.data.requests[0].thinking_mode,thinking.mode);
     assert.equal(saved.data.messages.at(-1).thinking_content,'需要仔細思考');
     assert.equal(saved.data.messages.at(-1).content,'Hello');
   }
 }finally{
  child.kill();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,1800)});
  await new Promise(resolve=>mock.close(resolve));
  try{fs.rmSync(tmp,{recursive:true,force:true,maxRetries:3,retryDelay:200})}
  catch(e){if(process.platform!=='win32'||e.code!=='EPERM')throw e}
 }
});
