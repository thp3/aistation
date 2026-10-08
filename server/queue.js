import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {db,id,query,one,run,utcNow} from './db.js';
import {streamProvider,normalizedUsage,redact} from './provider.js';
import {resolveThinking} from './thinking.js';
import {autoNameFirstTurn} from './naming.js';

const active=new Map();
const bus=new EventEmitter();
bus.setMaxListeners(200);
const fingerprint=({conversation_id,content,thinking})=>crypto.createHash('sha256')
  .update(JSON.stringify([conversation_id,content,thinking])).digest('hex');
export const isActive=cid=>active.has(cid);
export const running=()=>[...active.entries()].map(([conversation_id,entry])=>({
 conversation_id,request_id:entry.job.id,started_at:entry.started
}));
export const isPaused=cid=>!!one('SELECT 1 FROM queue_pauses WHERE conversation_id=?',cid);

export function emit(cid,job,event,payload={}){
 if(!one('SELECT 1 FROM conversations WHERE id=?',cid))return;
 const record=run('INSERT INTO queue_events(conversation_id,job_id,event,payload) VALUES(?,?,?,?)',cid,job,event,JSON.stringify(payload));
 const seq=Number(record.lastInsertRowid);
 bus.emit(cid,{seq,event,payload});
}

export function subscribe(cid,after,listener){
 // Synchronous query+listener registration: no lost-event window.
 const rows=query('SELECT seq,event,payload FROM queue_events WHERE conversation_id=? AND seq>? ORDER BY seq ASC',cid,after);
 for(const e of rows)listener({seq:e.seq,event:e.event,payload:JSON.parse(e.payload)});
 bus.on(cid,listener);
 return ()=>bus.off(cid,listener);
}

export function queueState(cid){
 return {
  paused:isPaused(cid),
  jobs:query("SELECT id,conversation_id,content,state,created_at,started_at,finished_at,error_text FROM queue_jobs WHERE conversation_id=? AND state IN ('queued','running') ORDER BY rowid ASC",cid)
 };
}
export function allQueued(){
 return query("SELECT DISTINCT conversation_id FROM queue_jobs WHERE state='queued' ORDER BY rowid");
}

export function enqueue({cid,requestId,content,thinking:rawThinking}){
 if(typeof requestId!=='string'||!(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)))
   return {error:'需要有效 UUID 格式的 idempotency_key',code:400};
 const convo=one('SELECT * FROM conversations WHERE id=?',cid);
 if(!convo)return {error:'對話不存在',code:404};
 if(typeof content!=='string'||!content.trim()||content.length>100000)return {error:'訊息內容不可空白或過長',code:400};
 const clean=content.trim(),raw=rawThinking??{mode:'default'};
 const digest=fingerprint({conversation_id:cid,content:clean,thinking:raw});
 const existing=one('SELECT * FROM queue_jobs WHERE id=?',requestId);
 if(existing){
   if(existing.fingerprint!==digest||existing.conversation_id!==cid)return {error:'相同 idempotency_key 對應不同訊息',code:409};
   return {job:existing,deduplicated:true};
 }
 const provider=one('SELECT * FROM providers WHERE id=?',convo.provider_id);
 if(!provider||!convo.model_id||!one('SELECT 1 FROM models WHERE provider_id=? AND model_id=? AND enabled=1',provider.id,convo.model_id))
   return {error:'請先選擇有效模型',code:400};
 let resolved;
 try{resolved=resolveThinking(provider.protocol,convo.model_id,raw)}
 catch(e){return {error:e.message,code:400}}
 const pending=one("SELECT COUNT(*) AS n FROM queue_jobs WHERE conversation_id=? AND state='queued'",cid)?.n||0;
 if(pending>=100)return {error:'每個對話最多允許 100 則待發送訊息',code:429};
 try{
  run("INSERT INTO queue_jobs(id,conversation_id,fingerprint,content,provider_id,model_id,system_prompt,thinking_json,state) VALUES(?,?,?,?,?,?,?,?, 'queued')",
    requestId,cid,digest,clean,provider.id,convo.model_id,convo.system_prompt,JSON.stringify(resolved));
 }catch(e){
  // A concurrent retry may win the unique id constraint.
  const found=one('SELECT * FROM queue_jobs WHERE id=?',requestId);
  if(found&&found.fingerprint===digest&&found.conversation_id===cid)return {job:found,deduplicated:true};
  return {error:'建立排隊任務失敗',code:409};
 }
 const job=one('SELECT * FROM queue_jobs WHERE id=?',requestId);
 emit(cid,requestId,'queued',{request_id:requestId,content:clean});
 setImmediate(()=>kick(cid));
 return {job,deduplicated:false};
}
export function cancel(cid,jobId){
 const row=one('SELECT * FROM queue_jobs WHERE id=? AND conversation_id=?',jobId,cid);
 if(!row)return {error:'找不到佇列訊息',code:404};
 if(row.state!=='queued')return {error:'只能取消尚未開始的訊息',code:409};
 run("UPDATE queue_jobs SET state='cancelled',finished_at=? WHERE id=? AND state='queued'",utcNow(),jobId);
 emit(cid,jobId,'cancelled',{request_id:jobId});
 return {ok:true};
}
export function stop(cid){
 const job=active.get(cid);
 if(job){job.stopped=true;job.controller.abort('stopped')}
 return {ok:true,stopping:!!job};
}
export function resume(cid){
 run('DELETE FROM queue_pauses WHERE conversation_id=?',cid);
 emit(cid,null,'resumed',{});
 setImmediate(()=>kick(cid));
 return {ok:true};
}

function finishJob(job,state,errorText=null){
 const cid=job.conversation_id;
 run('UPDATE queue_jobs SET state=?,finished_at=?,error_text=? WHERE id=?',state,utcNow(),errorText,job.id);
 if(state==='error')run('INSERT OR REPLACE INTO queue_pauses(conversation_id,reason) VALUES(?,?)',cid,errorText||'API_ERROR');
}
async function execute(job,entry){
 const cid=job.conversation_id,started=utcNow(),uid=id(),aid=id(),rid=id();
 const provider=one('SELECT * FROM providers WHERE id=?',job.provider_id);
 const model=job.model_id;
 let content='',thinkingContent='',usage={},finishReason=null,lastCheckpoint=0;
 const ctrl=entry.controller;
 let idle;
 const max=setTimeout(()=>ctrl.abort('max_timeout'),Math.max(30000,Number(process.env.UPSTREAM_MAX_TIMEOUT_MS)||600000));
 const reset=()=>{clearTimeout(idle);idle=setTimeout(()=>ctrl.abort('idle_timeout'),Math.max(10000,Number(process.env.UPSTREAM_IDLE_TIMEOUT_MS)||90000))};
 const checkpoint=()=>{if(Date.now()-lastCheckpoint<750)return;lastCheckpoint=Date.now();run('UPDATE messages SET content=?,thinking_content=? WHERE id=?',content,thinkingContent,aid)};
 let messages=[];
 try{
  if(!provider)throw Error('供應商已被刪除');
  run("INSERT INTO messages(id,conversation_id,role,content) VALUES(?,?,'user',?)",uid,cid,job.content);
  run("INSERT INTO messages(id,conversation_id,role,content,thinking_content,status) VALUES(?,?,'assistant','','','running')",aid,cid);
  run(`INSERT INTO requests(id,conversation_id,assistant_message_id,provider_id,provider_name,model_id,started_at,thinking_mode,thinking_effort,thinking_budget_tokens)
    VALUES(?,?,?,?,?,?,?,?,?,?)`,rid,cid,aid,provider.id,provider.name,model,started,
    JSON.parse(job.thinking_json).mode,JSON.parse(job.thinking_json).effort,JSON.parse(job.thinking_json).budget_tokens);
  run('UPDATE conversations SET updated_at=? WHERE id=?',utcNow(),cid);
  messages=query("SELECT role,content FROM messages WHERE conversation_id=? AND id!=? AND status IN ('complete','stopped') ORDER BY created_at,rowid",cid,aid);
  emit(cid,job.id,'started',{request_id:job.id,user_id:uid,assistant_id:aid,started_at:started});
  reset();
  await streamProvider({provider,model,system:job.system_prompt,messages,thinking:JSON.parse(job.thinking_json),signal:ctrl.signal,
   onActivity:reset,
   onDelta:delta=>{content+=delta;checkpoint();emit(cid,job.id,'delta',{request_id:job.id,assistant_id:aid,text:delta})},
   onThinking:delta=>{thinkingContent+=delta;checkpoint();emit(cid,job.id,'thinking_delta',{request_id:job.id,assistant_id:aid,text:delta})},
   onUsage:(u,r)=>{usage=u;finishReason=r},
   onFinished:(u,r)=>{usage=u;finishReason=r}});
  const n=normalizedUsage(provider.protocol,usage);
  run("UPDATE messages SET content=?,thinking_content=?,status='complete' WHERE id=?",content,thinkingContent,aid);
  run('UPDATE requests SET status=?,input_tokens=?,output_tokens=?,total_tokens=?,cache_read_tokens=?,cache_creation_tokens=?,reasoning_tokens=?,usage_raw=?,finish_reason=?,finished_at=? WHERE id=?',
   'complete',n.input_tokens,n.output_tokens,n.total_tokens,n.cache_read_tokens,n.cache_creation_tokens,n.reasoning_tokens,JSON.stringify(usage),finishReason,utcNow(),rid);
  finishJob(job,'complete');
  emit(cid,job.id,'complete',{request_id:job.id,usage:n,finish_reason:finishReason});
  // Separate task; a failed title request never blocks the conversation FIFO.
  void autoNameFirstTurn(cid,emit).catch(()=>{});
 }catch(e){
  const status=entry.stopped?'stopped':'error';
  const code=entry.stopped?'USER_STOP':ctrl.signal.aborted?String(ctrl.signal.reason||'TIMEOUT'):(e.provider_code||'unknown');
  const error=redact(e.raw||e.message||String(e),provider?.encrypted_key?[]:[]);
  if(one('SELECT id FROM conversations WHERE id=?',cid)){
   const n=normalizedUsage(provider?.protocol||'openai',usage);
   run('UPDATE messages SET content=?,thinking_content=?,status=? WHERE id=?',content,thinkingContent,status,aid);
   run('UPDATE requests SET status=?,input_tokens=?,output_tokens=?,total_tokens=?,cache_read_tokens=?,cache_creation_tokens=?,reasoning_tokens=?,usage_raw=?,finish_reason=?,http_status=?,provider_error_code=?,error_body=?,finished_at=? WHERE id=?',
    status,n.input_tokens,n.output_tokens,n.total_tokens,n.cache_read_tokens,n.cache_creation_tokens,n.reasoning_tokens,JSON.stringify(usage),finishReason,e.status||null,code,status==='stopped'?null:error,utcNow(),rid);
   finishJob(job,status,status==='error'?error:null);
   emit(cid,job.id,status,{request_id:job.id,http_status:e.status||null,provider_code:code,error:status==='stopped'?'已停止生成':error,partial:content});
  }
 }finally{clearTimeout(idle);clearTimeout(max)}
}
export async function kick(cid){
 if(active.has(cid)||isPaused(cid))return;
 // Synchronous claim: one process worker per conversation, FIFO by immutable rowid.
 const job=one("SELECT * FROM queue_jobs WHERE conversation_id=? AND state='queued' ORDER BY rowid ASC LIMIT 1",cid);
 if(!job)return;
 const controller=new AbortController();
 const entry={job,controller,stopped:false,started:utcNow()};
 active.set(cid,entry);
 run("UPDATE queue_jobs SET state='running',started_at=? WHERE id=? AND state='queued'",entry.started,job.id);
 try{await execute(job,entry)}
 catch(e){
  // Worker safety net: never lose a job to an unhandled exception.
  if(one('SELECT 1 FROM conversations WHERE id=?',cid)){
   finishJob(job,'error',String(e.message).slice(0,500));
   emit(cid,job.id,'error',{request_id:job.id,error:String(e.message).slice(0,500)});
  }
 }finally{
  active.delete(cid);
  setImmediate(()=>kick(cid));
 }
}
export function recoverQueue(){
 // An upstream request cannot safely be reissued after a process crash:
 // the provider may have billed it already. Pause for explicit user action.
 const interrupted=query("SELECT id,conversation_id FROM queue_jobs WHERE state='running'");
 for(const task of interrupted){
  run("UPDATE queue_jobs SET state='error',error_text='SERVER_RESTARTED: execution outcome unknown',finished_at=? WHERE id=?",utcNow(),task.id);
  run("INSERT OR REPLACE INTO queue_pauses(conversation_id,reason) VALUES(?,'SERVER_RESTARTED')",task.conversation_id);
  emit(task.conversation_id,task.id,'error',{request_id:task.id,provider_code:'SERVER_RESTARTED',error:'伺服器重新啟動，上一筆請求結果未知，不會自動重試以避免重複計費'});
 }
 for(const {conversation_id} of allQueued())setImmediate(()=>kick(conversation_id));
}
