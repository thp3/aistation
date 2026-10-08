import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let child,upstream,dir,base,cookie,db,providerId,modelCalls=0;
test.before(async()=>{
 dir=fs.mkdtempSync(path.join(os.tmpdir(),'aistation-workflows-'));
 upstream=createServer(async(req,res)=>{
  if(req.url==='/v1/models'){modelCalls++;await sleep(100);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'mock'}]}));return}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks)),last=body.messages.at(-1).content;
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const event=(text,reason=null)=>'data: '+JSON.stringify({choices:[{delta:{content:text},finish_reason:reason}]})+'\n\n';
  if(last==='slow'){
   res.write(event('開始'));const timer=setTimeout(()=>res.end(event('結束','stop')+'data: [DONE]\n\n'),10000);res.on('close',()=>clearTimeout(timer));
  }else res.end(Array.from({length:100},()=>event('字')).join('')+event('','stop')+'data: [DONE]\n\n');
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
 const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 base='http://127.0.0.1:'+port;
 child=spawn(process.execPath,['server/index.js'],{windowsHide:true,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dir,ADMIN_USERNAME:'test',ADMIN_PASSWORD:'testing-password-at-least-12',SESSION_SECRET:'test-session-secret-at-least-32-characters',DATA_ENCRYPTION_KEY:'test-data-secret-at-least-32-characters'},stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',c=>stderr+=c);child.stdout.on('data',()=>{});
 for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(stderr);try{if((await fetch(base+'/api/me')).status===401)break}catch{}await sleep(50)}
 const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'test',password:'testing-password-at-least-12'})});assert.equal(login.status,200,stderr);cookie=login.headers.get('set-cookie').split(';')[0];
 db=new DatabaseSync(path.join(dir,'aistation.sqlite'));db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
 const provider=await request('/providers','POST',{name:'Mock',protocol:'openai',endpoint:'http://127.0.0.1:'+upstream.address().port+'/v1/chat/completions',api_key:'test-key',discover:false});providerId=provider.data.id;
});
test.after(async()=>{
 db?.close();child?.kill();if(child?.exitCode===null)await Promise.race([once(child,'exit'),sleep(3000)]);
 upstream?.closeAllConnections();await new Promise(r=>upstream?upstream.close(r):r());
 fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});
});
async function request(uri,method='GET',payload){
 const res=await fetch(base+'/api'+uri,{method,headers:{Cookie:cookie,...(payload!==undefined?{'Content-Type':'application/json'}:{})},...(payload!==undefined?{body:JSON.stringify(payload)}:{})});return {status:res.status,data:await res.json(),headers:res.headers};
}
async function until(fn){for(let i=0;i<100;i++){const value=await fn();if(value)return value;await sleep(30)}throw Error('Timed out waiting for job')}

test('saving endpoints is immediate and concurrent discovery shares one upstream request',async()=>{
 assert.equal(modelCalls,0);
 const [scan,connection]=await Promise.all([request('/providers/'+providerId+'/scan','POST'),request('/providers/'+providerId+'/test','POST')]);
 assert.equal(scan.data.count,1);assert.equal(connection.data.models_found,1);assert.equal(modelCalls,1);
});
test('bootstrap and cursor pages bound payloads and retain complete older history',async()=>{
 const insert=db.prepare('INSERT INTO conversations(id,title,system_prompt,updated_at) VALUES(?,?,?,?)');
 for(let i=0;i<120;i++)insert.run('page-'+String(i).padStart(3,'0'),'分頁 '+i,'private-system','2026-10-09 00:00:00');
 const bootstrap=(await request('/bootstrap')).data;assert.equal(bootstrap.conversations.items.length,50);assert.ok(bootstrap.conversations.next_cursor);assert.equal('providers' in bootstrap,false);assert.equal('system_prompt' in bootstrap.conversations.items[0],false);
 const ids=new Set();let cursor='';
 do{const page=(await request('/conversations?limit=37'+(cursor?'&cursor='+cursor:''))).data;assert.ok(page.items.length<=37);for(const c of page.items){assert.equal(ids.has(c.id),false);ids.add(c.id)}cursor=page.next_cursor}while(cursor);
 assert.equal(ids.size,120);assert.equal((await request('/conversations?limit=101')).status,400);assert.equal((await request('/conversations?cursor=bad')).status,400);
 assert.equal((await request('/conversations?limit=50&q='+encodeURIComponent('分頁 11'))).data.items.length,11);
 const msg=db.prepare("INSERT INTO messages(id,conversation_id,role,content) VALUES(?,'page-000','assistant',?)");
 for(let i=0;i<120;i++)msg.run('history-'+i,'內容 '+i);
 db.prepare("INSERT INTO requests(id,conversation_id,assistant_message_id,provider_name,model_id,status,usage_raw,started_at) VALUES('history-request','page-000','history-119','Mock','mock','complete',?,'2026-10-09')").run('x'.repeat(100000));
 const detail=(await request('/conversations/page-000?limit=50')).data;
 assert.equal(detail.messages.length,50);assert.equal(detail.messages[0].id,'history-70');assert.equal('usage_raw' in detail.requests[0],false);
 const older=(await request('/conversations/page-000/messages?limit=50&before='+detail.messages_cursor)).data;
 assert.equal(older.items[0].id,'history-20');assert.equal(older.items.at(-1).id,'history-69');
 const oldest=(await request('/conversations/page-000/messages?limit=50&before='+older.next_cursor)).data;assert.equal(oldest.items.length,20);assert.equal(oldest.next_cursor,null);
});
test('API errors remain JSON and settings validation cannot partially save a rejected change',async()=>{
 const error=await request('/missing-api');assert.equal(error.status,404);assert.equal(error.data.code,'NOT_FOUND');assert.ok(error.headers.get('X-Request-ID'));
 await request('/settings','PATCH',{default_system_prompt:'before'});
 assert.equal((await request('/settings','PATCH',{default_system_prompt:'after',naming_model_id:'missing'})).status,400);
 assert.equal((await request('/settings')).data.default_system_prompt,'before');
});
test('stop and pause preserves pending work; batch cancel does not stop the current request',async()=>{
 const chat=(await request('/conversations','POST',{provider_id:providerId,model_id:'mock'})).data,cid=chat.id;
 const send=content=>request('/conversations/'+cid+'/send','POST',{content,idempotency_key:randomUUID()});
 const first=await send('slow');await until(async()=>(await request('/conversations/'+cid+'/jobs/'+first.data.request_id)).data.state==='running');
 const second=await send('later');await request('/conversations/'+cid+'/stop','POST',{pause:true});
 await until(async()=>(await request('/conversations/'+cid+'/jobs/'+first.data.request_id)).data.state==='stopped');
 assert.equal((await request('/conversations/'+cid+'/jobs/'+second.data.request_id)).data.state,'queued');
 const paused=(await request('/conversations/'+cid)).data;assert.equal(paused.queue.paused,true);assert.equal(paused.queue.reason,'MANUAL');
 const cancelled=await request('/conversations/'+cid+'/queue','DELETE');assert.equal(cancelled.data.cancelled,1);assert.equal((await request('/conversations/'+cid+'/jobs/'+second.data.request_id)).data.state,'cancelled');
 await request('/conversations/'+cid+'/queue/resume','POST');
 const third=await send('slow');await until(async()=>(await request('/conversations/'+cid+'/jobs/'+third.data.request_id)).data.state==='running');await send('cancel me');
 await request('/conversations/'+cid+'/queue','DELETE');assert.equal((await request('/conversations/'+cid+'/jobs/'+third.data.request_id)).data.state,'running');await request('/conversations/'+cid+'/stop','POST',{pause:true});
});
test('batched deltas retain every character and final events provide message and usage records',async()=>{
 const chat=(await request('/conversations','POST',{provider_id:providerId,model_id:'mock'})).data,cid=chat.id;
 const sent=await request('/conversations/'+cid+'/send','POST',{content:'fast',idempotency_key:randomUUID()});
 await until(async()=>(await request('/conversations/'+cid+'/jobs/'+sent.data.request_id)).data.state==='complete');
 const events=db.prepare('SELECT event,payload FROM queue_events WHERE conversation_id=? ORDER BY seq').all(cid).map(e=>({...e,payload:JSON.parse(e.payload)}));
 const deltas=events.filter(e=>e.event==='delta');assert.ok(deltas.length<100);assert.equal(deltas.map(e=>e.payload.text).join(''),'字'.repeat(100));
 const completed=events.find(e=>e.event==='complete');assert.equal(completed.payload.message.content,'字'.repeat(100));assert.equal(completed.payload.request.status,'complete');
 const response=await fetch(base+'/api/events',{headers:{Cookie:cookie},signal:AbortSignal.timeout(3000)});const reader=response.body.getReader();let text='';
 while(!text.includes('event: status'))text+=new TextDecoder().decode((await reader.read()).value);await reader.cancel();assert.match(text,/"active"/);
});
