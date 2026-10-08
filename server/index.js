import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import {setStaticCacheHeaders} from './static-cache.js';
import {db,id,query,one,run,encrypt,publicProvider,utcNow,getSetting,setSetting} from './db.js';
import {validateEndpoint,discoverModels,redact} from './provider.js';
import {enqueue,queueState,subscribe,stop,running,resume,cancel,recoverQueue,isActive,subscribeStatus,statusSnapshot,pauseQueue,cancelPending} from './queue.js';
import {conversationsPage,messagesPage,conversationDetail,conversationFields} from './views.js';
import {eventStream} from './event-stream.js';
// A process restart cannot resume an upstream HTTP connection. Mark stale work
// interrupted instead of leaving conversations indefinitely "generating".
run("UPDATE requests SET status='error',provider_error_code='SERVER_RESTARTED',error_body='伺服器重新啟動，原生成連線已中斷',finished_at=? WHERE status='running'",utcNow());
run("UPDATE messages SET status='error' WHERE status='running'");
const app=express();app.disable('x-powered-by');
app.use('/api',(req,res,next)=>{
 res.setHeader('X-Request-ID',crypto.randomUUID());
 const json=res.json.bind(res);
 res.json=data=>json(res.statusCode>=400&&data?.error?{...data,code:data.code||'HTTP_'+res.statusCode}:data);
 res.sendStatus=code=>res.status(code).json({error:code===404?'資料不存在':'請求失敗',code:'HTTP_'+code});
 next();
});
app.use(express.json({limit:'1mb'}));
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'");next()});
if(!process.env.ADMIN_USERNAME||!process.env.ADMIN_PASSWORD||process.env.ADMIN_PASSWORD.length<12||!process.env.SESSION_SECRET||process.env.SESSION_SECRET.length<32)throw Error('Configure secure ADMIN_USERNAME, ADMIN_PASSWORD and SESSION_SECRET in .env');
const hash=s=>crypto.createHmac('sha256',process.env.SESSION_SECRET).update(s).digest('hex');
const cookie=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=').slice(0,2)));
function auth(req,res,next){const token=cookie(req).session||'';const session=token?one('SELECT expires_at FROM sessions WHERE token_hash=?',hash(token)):null;if(!session||session.expires_at<Date.now())return res.status(401).json({error:'請先登入'});req.sessionToken=token;req.sessionExpires=session.expires_at;next();}
function csrf(req,res,next){if(['POST','PATCH','PUT','DELETE'].includes(req.method)&&req.headers.origin){try{if(new URL(req.headers.origin).host!==req.headers.host)return res.status(403).json({error:'Invalid origin'});}catch{return res.status(403).json({error:'Invalid origin'});}}next();}
app.use('/api',csrf);
const attempts=new Map();
app.post('/api/login',(req,res)=>{const ip=req.ip||'unknown', entry=attempts.get(ip)||{count:0,until:0};if(entry.until>Date.now())return res.status(429).json({error:'嘗試次數過多，稍後重試'});const a=Buffer.from(String(req.body.username||'')),b=Buffer.from(process.env.ADMIN_USERNAME),c=Buffer.from(String(req.body.password||'')),d=Buffer.from(process.env.ADMIN_PASSWORD);if(!(a.length===b.length&&crypto.timingSafeEqual(a,b)&&c.length===d.length&&crypto.timingSafeEqual(c,d))){entry.count++;if(entry.count>=5){entry.until=Date.now()+900000;entry.count=0;}attempts.set(ip,entry);return res.status(401).json({error:'帳號或密碼錯誤'});}attempts.delete(ip);const token=crypto.randomBytes(32).toString('hex');const days=Math.max(1,Math.min(30,Number(process.env.SESSION_DAYS)||7));run('INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)',hash(token),Date.now()+days*86400000);res.setHeader('Set-Cookie',`session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${days*86400}`);res.json({ok:true});});
app.post('/api/logout',auth,(req,res)=>{run('DELETE FROM sessions WHERE token_hash=?',hash(req.sessionToken));res.setHeader('Set-Cookie','session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');res.json({ok:true})});
app.get('/api/me',auth,(req,res)=>res.json({username:process.env.ADMIN_USERNAME}));
const modelRows=()=>query('SELECT m.*,p.name AS provider_name,p.protocol FROM models m JOIN providers p ON m.provider_id=p.id ORDER BY p.name,m.model_id');
const settingsView=()=>({default_system_prompt:getSetting('default_system_prompt'),naming_model_id:getSetting('naming_model_id')});
app.get('/api/bootstrap',auth,(req,res)=>res.json({me:{username:process.env.ADMIN_USERNAME},models:modelRows(),settings:settingsView(),conversations:conversationsPage(),active:running(),detail:req.query.conversation?conversationDetail(String(req.query.conversation),50):null}));
app.get('/api/admin',auth,(req,res)=>res.json({providers:query('SELECT * FROM providers ORDER BY created_at DESC').map(publicProvider),models:modelRows(),settings:settingsView()}));
function streamFor(req,res){
 const write=eventStream(res),timer=setTimeout(()=>res.end(),Math.min(2147483647,Math.max(1,req.sessionExpires-Date.now())));
 timer.unref();res.on('close',()=>clearTimeout(timer));return write;
}
app.get('/api/events',auth,(req,res)=>{const write=streamFor(req,res),detach=subscribeStatus(write);write({event:'status',payload:statusSnapshot()});res.on('close',detach)});
const discoveries=new Map();
function discoverOnce(provider){
 const key=JSON.stringify([provider.id,provider.updated_at,provider.endpoint,provider.encrypted_key]);
 if(discoveries.has(key))return discoveries.get(key);
 const task=discoverModels(provider).finally(()=>discoveries.delete(key));discoveries.set(key,task);return task;
}
app.get('/api/providers',auth,(req,res)=>res.json(query('SELECT * FROM providers ORDER BY created_at DESC').map(publicProvider)));
app.post('/api/providers',auth,async(req,res)=>{try{const {name,protocol,endpoint,api_key}=req.body;if(!String(name||'').trim()||!['openai','claude','gemini'].includes(protocol)||!String(api_key||'').trim())return res.status(400).json({error:'請填寫名稱、協定與 API Key'});const url=validateEndpoint(endpoint,protocol);const pid=id();run('INSERT INTO providers(id,name,protocol,endpoint,encrypted_key) VALUES(?,?,?,?,?)',pid,String(name).trim(),protocol,url,encrypt(api_key));let discovery_error=null,models_found=0;if(req.body.discover===false)return res.status(201).json({id:pid,models_found:0,discovery_pending:true});try{const p=one('SELECT * FROM providers WHERE id=?',pid);const models=await discoverOnce(p);for(const model of models)run("INSERT INTO models(id,provider_id,model_id,source) VALUES(?,?,?,'discovered') ON CONFLICT(provider_id,model_id) DO UPDATE SET updated_at=excluded.updated_at",id(),pid,model);models_found=models.length;}catch(e){discovery_error=redact(e.raw||e.message,[api_key]);}res.status(201).json({id:pid,models_found,discovery_error});}catch(e){res.status(400).json({error:e.message})}});
app.patch('/api/providers/:id',auth,(req,res)=>{try{const p=one('SELECT * FROM providers WHERE id=?',req.params.id);if(!p)return res.sendStatus(404);const protocol=req.body.protocol||p.protocol;const endpoint=validateEndpoint(req.body.endpoint||p.endpoint,protocol);const name=String(req.body.name??p.name).trim();if(!name)throw Error('名稱不可空白');run('UPDATE providers SET name=?,protocol=?,endpoint=?,encrypted_key=?,updated_at=? WHERE id=?',name,protocol,endpoint,req.body.api_key?encrypt(req.body.api_key):p.encrypted_key,utcNow(),p.id);res.json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.delete('/api/providers/:id',auth,(req,res)=>{run('DELETE FROM providers WHERE id=?',req.params.id);res.json({ok:true})});
async function scan(req,res){const p=one('SELECT * FROM providers WHERE id=?',req.params.id);if(!p)return res.sendStatus(404);try{const ids=await discoverOnce(p);for(const model of ids)run("INSERT INTO models(id,provider_id,model_id,source) VALUES(?,?,?,'discovered') ON CONFLICT(provider_id,model_id) DO UPDATE SET updated_at=excluded.updated_at",id(),p.id,model);res.json({count:ids.length,models:ids});}catch(e){res.status(e.status||502).json({error:redact(e.raw||e.message),provider_code:e.provider_code||null,http_status:e.status||null})}}
app.post('/api/providers/:id/scan',auth,scan);
app.post('/api/providers/:id/test',auth,async(req,res)=>{const p=one('SELECT * FROM providers WHERE id=?',req.params.id);if(!p)return res.sendStatus(404);try{const ids=await discoverOnce(p);res.json({ok:true,models_found:ids.length})}catch(e){res.status(e.status||502).json({error:redact(e.raw||e.message),provider_code:e.provider_code||null})}});
app.get('/api/models',auth,(req,res)=>res.json(query('SELECT m.*,p.name AS provider_name,p.protocol AS protocol,p.endpoint AS endpoint FROM models m JOIN providers p ON m.provider_id=p.id ORDER BY p.name,m.model_id')));
app.post('/api/models',auth,(req,res)=>{const {provider_id,model_id}=req.body;if(!one('SELECT id FROM providers WHERE id=?',provider_id)||!String(model_id||'').trim())return res.status(400).json({error:'無效模型'});try{run("INSERT INTO models(id,provider_id,model_id,source) VALUES(?,?,?,'manual') ON CONFLICT(provider_id,model_id) DO UPDATE SET source='manual',enabled=1,updated_at=excluded.updated_at",id(),provider_id,String(model_id).trim());res.status(201).json({ok:true})}catch(e){res.status(400).json({error:e.message})}});
app.patch('/api/models/:id',auth,(req,res)=>{run('UPDATE models SET enabled=? WHERE id=?',req.body.enabled?1:0,req.params.id);res.json({ok:true})});
app.delete('/api/models/:id',auth,(req,res)=>{run('DELETE FROM models WHERE id=?',req.params.id);res.json({ok:true})});
app.get('/api/settings',auth,(req,res)=>res.json({default_system_prompt:getSetting('default_system_prompt'),naming_model_id:getSetting('naming_model_id')}));
app.patch('/api/settings',auth,(req,res)=>{
 const mid=String(req.body.naming_model_id||'');
 if(Object.hasOwn(req.body,'naming_model_id')&&mid&&!one('SELECT 1 FROM models WHERE id=? AND enabled=1',mid))return res.status(400).json({error:'命名模型不存在或未啟用'});
 db.exec('BEGIN IMMEDIATE');
 try{
  if(Object.hasOwn(req.body,'default_system_prompt'))setSetting('default_system_prompt',String(req.body.default_system_prompt||''));
  if(Object.hasOwn(req.body,'naming_model_id'))setSetting('naming_model_id',mid);
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error}
 res.json({ok:true,...settingsView()});
});
const convoSql='SELECT * FROM conversations';
app.get('/api/conversations',auth,(req,res)=>res.json(req.query.limit||req.query.cursor||req.query.q?conversationsPage(req.query):query(convoSql+' ORDER BY updated_at DESC,id DESC')));
app.post('/api/conversations',auth,(req,res)=>{const cid=id();const system=String(req.body.system_prompt??getSetting('default_system_prompt'));run('INSERT INTO conversations(id,title,system_prompt,provider_id,model_id,title_customized) VALUES(?,?,?,?,?,?)',cid,String(req.body.title||'新的對話').slice(0,120),system,req.body.provider_id||null,req.body.model_id||null,req.body.title?1:0);res.status(201).json(one(convoSql+' WHERE id=?',cid))});
app.get('/api/conversations/:id',auth,(req,res)=>{
 const c=conversationDetail(req.params.id,req.query.limit);if(!c)return res.sendStatus(404);res.json(c);
});
app.get('/api/conversations/:id/messages',auth,(req,res)=>{if(!one('SELECT 1 FROM conversations WHERE id=?',req.params.id))return res.sendStatus(404);res.json(messagesPage(req.params.id,req.query))});
app.get('/api/generations',auth,(req,res)=>res.json({active:running()}));
app.get('/api/conversations/:id/jobs/:jobId',auth,(req,res)=>{
 const job=one('SELECT id,state,created_at,started_at,finished_at,error_text FROM queue_jobs WHERE conversation_id=? AND id=?',req.params.id,req.params.jobId);
 if(!job)return res.sendStatus(404);
 res.json(job);
});
app.get('/api/conversations/:id/events',auth,(req,res)=>{
 const cid=req.params.id;if(!one('SELECT 1 FROM conversations WHERE id=?',cid))return res.sendStatus(404);
 const raw=req.get('Last-Event-ID')||req.query.after||'0';
 const after=Number(raw);
 if(!Number.isSafeInteger(after)||after<0)return res.status(400).json({error:'無效事件游標'});
 const write=streamFor(req,res);
 const detach=subscribe(cid,after,write);
 res.on('close',detach);
});
app.post('/api/conversations/:id/queue/pause',auth,(req,res)=>{if(!one('SELECT 1 FROM conversations WHERE id=?',req.params.id))return res.sendStatus(404);res.json(pauseQueue(req.params.id))});
app.delete('/api/conversations/:id/queue',auth,(req,res)=>{if(!one('SELECT 1 FROM conversations WHERE id=?',req.params.id))return res.sendStatus(404);res.json(cancelPending(req.params.id))});
app.post('/api/conversations/:id/queue/resume',auth,(req,res)=>{
 if(!one('SELECT 1 FROM conversations WHERE id=?',req.params.id))return res.sendStatus(404);
 res.json(resume(req.params.id));
});
app.delete('/api/conversations/:id/queue/:jobId',auth,(req,res)=>{
 const result=cancel(req.params.id,req.params.jobId);
 res.status(result.code||200).json(result.code?{error:result.error}:result);
});
// History edits are forbidden while a job is running, so its context snapshot
// cannot diverge from what the user sees after completion.
function editableConversation(req,res,next){
 const cid=req.params.id;
 if(!one('SELECT id FROM conversations WHERE id=?',cid))return res.status(404).json({error:'對話不存在'});
 if(isActive(cid)||one("SELECT 1 FROM queue_jobs WHERE conversation_id=? AND state='queued'",cid))
   return res.status(409).json({error:'目前仍有生成或待發送任務，請先完成或取消佇列再修改歷史上下文'});
 next();
}
app.patch('/api/conversations/:id/messages/:messageId',auth,editableConversation,(req,res)=>{
 const msg=one('SELECT * FROM messages WHERE conversation_id=? AND id=?',req.params.id,req.params.messageId);
 if(!msg)return res.status(404).json({error:'訊息不存在'});
 const content=req.body?.content;
 if(typeof content!=='string'||!content.trim()||content.length>100000)return res.status(400).json({error:'訊息必須是非空白文字且不得超過 100000 字元'});
 run("UPDATE messages SET content=?,thinking_content=CASE WHEN role='assistant' THEN '' ELSE thinking_content END WHERE id=?",content,msg.id);
 run('UPDATE conversations SET updated_at=? WHERE id=?',utcNow(),req.params.id);
 res.json({ok:true,message:one('SELECT * FROM messages WHERE id=?',msg.id),conversation:one(`SELECT ${conversationFields} FROM conversations WHERE id=?`,req.params.id)});
});
app.delete('/api/conversations/:id/messages/:messageId',auth,editableConversation,(req,res)=>{
 const result=run('DELETE FROM messages WHERE conversation_id=? AND id=?',req.params.id,req.params.messageId);
 if(!result.changes)return res.status(404).json({error:'訊息不存在'});
 run('UPDATE conversations SET updated_at=? WHERE id=?',utcNow(),req.params.id);
 res.json({ok:true});
});
app.post('/api/conversations/:id/rewind',auth,editableConversation,(req,res)=>{
 const messages=query('SELECT id,role,content FROM messages WHERE conversation_id=? ORDER BY created_at,rowid',req.params.id);
 const idx=messages.findIndex(m=>m.id===req.body?.message_id);
 if(idx<0)return res.status(404).json({error:'找不到指定訊息'});
 if(messages[idx].role!=='user')return res.status(400).json({error:'只能回退到使用者傳送的訊息'});
 // Delete the chosen user message and all messages after it. Return its draft
 // for resubmission; older requests retain token accounting and become unlinked.
 db.exec('BEGIN IMMEDIATE');
 try{
   for(const m of messages.slice(idx))run('DELETE FROM messages WHERE id=? AND conversation_id=?',m.id,req.params.id);
   run('UPDATE conversations SET updated_at=? WHERE id=?',utcNow(),req.params.id);
   db.exec('COMMIT');
 }catch(err){db.exec('ROLLBACK');throw err}
 res.json({ok:true,rewound_text:messages[idx].content,removed_count:messages.length-idx,removed_ids:messages.slice(idx).map(m=>m.id)});
});
app.patch('/api/conversations/:id',auth,(req,res)=>{
 const c=one(convoSql+' WHERE id=?',req.params.id);if(!c)return res.sendStatus(404);
 const pid=req.body.provider_id===undefined?c.provider_id:req.body.provider_id;
 const mid=req.body.model_id===undefined?c.model_id:req.body.model_id;
 if(pid&&mid&&!one('SELECT id FROM models WHERE provider_id=? AND model_id=? AND enabled=1',pid,mid))return res.status(400).json({error:'模型未啟用'});
 const customized=Object.hasOwn(req.body,'title')?1:c.title_customized;
 run('UPDATE conversations SET title=?,title_customized=?,system_prompt=?,provider_id=?,model_id=?,updated_at=? WHERE id=?',
   String(req.body.title??c.title).slice(0,120),customized,String(req.body.system_prompt??c.system_prompt),pid,mid,utcNow(),c.id);
 res.json(one(convoSql+' WHERE id=?',c.id));
});
app.delete('/api/conversations/:id',auth,(req,res)=>{stop(req.params.id);run('DELETE FROM conversations WHERE id=?',req.params.id);res.json({ok:true})});
app.get('/api/stats',auth,(req,res)=>res.json({requests:one("SELECT COUNT(*) AS count, SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END) AS completed FROM requests"),usage:one('SELECT SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens,SUM(total_tokens) AS total_tokens,SUM(cache_read_tokens) AS cache_read_tokens,SUM(cache_creation_tokens) AS cache_creation_tokens,SUM(reasoning_tokens) AS reasoning_tokens FROM requests'),...(req.query.by_model==='1'?{by_model:query('SELECT provider_name,model_id,COUNT(*) AS calls,SUM(input_tokens) AS input_tokens,SUM(output_tokens) AS output_tokens FROM requests GROUP BY provider_name,model_id ORDER BY calls DESC')} : {}),recent:query('SELECT id,provider_name,model_id,status,input_tokens,output_tokens,http_status,provider_error_code,error_body,started_at FROM requests ORDER BY started_at DESC LIMIT 30')}));
app.get('/api/export',auth,(req,res)=>{const type=req.query.type==='settings'?'settings':'chats';const data=type==='chats'?{conversations:query('SELECT * FROM conversations'),messages:query('SELECT * FROM messages'),requests:query('SELECT * FROM requests')}:{providers:query('SELECT id,name,protocol,endpoint,created_at FROM providers'),models:query('SELECT * FROM models'),settings:query('SELECT * FROM settings')};res.setHeader('Content-Disposition',`attachment; filename="aistation-${type}.json"`);res.type('json').send(JSON.stringify({exported_at:utcNow(),type,...data},null,2))});
app.post('/api/conversations/:id/stop',auth,(req,res)=>{if(!one('SELECT 1 FROM conversations WHERE id=?',req.params.id))return res.sendStatus(404);res.json(stop(req.params.id,{pause:req.body?.pause===true}))});
app.post('/api/conversations/:id/send',auth,(req,res)=>{
 const key=req.get('Idempotency-Key')||req.body?.idempotency_key;
 const outcome=enqueue({cid:req.params.id,requestId:key,content:req.body?.content,thinking:req.body?.thinking});
 if(outcome.error)return res.status(outcome.code).json({error:outcome.error});
 const job=outcome.job;
 // The POST only enqueues. Reconnectable SSE is a separate authenticated GET.
 res.status(outcome.deduplicated?200:202).json({
   request_id:job.id,state:job.state,deduplicated:outcome.deduplicated,queue:queueState(job.conversation_id),
   events_url:'/api/conversations/'+encodeURIComponent(req.params.id)+'/events'
 });
});
recoverQueue();
app.use('/api',(req,res)=>res.status(404).json({error:'API 路徑不存在',code:'NOT_FOUND'}));
app.use((err,req,res,next)=>{
 if(!req.path.startsWith('/api'))return next(err);
 if(res.headersSent)return res.end();
 const status=err.status||500;
 res.status(status).json({error:status<500?err.message:'伺服器暫時無法處理請求',code:status===500?'INTERNAL_ERROR':'HTTP_'+status});
});
app.use(express.static(path.resolve('dist'),{index:false,setHeaders:setStaticCacheHeaders}));
app.get('/{*any}',(req,res)=>{const p=path.resolve('dist/index.html');if(fs.existsSync(p))res.sendFile(p);else res.status(503).send('Frontend is not built. Run npm run build.');});
const port=Number(process.env.PORT||3000);app.listen(port,process.env.HOST||'0.0.0.0',()=>console.log(`AI Station listening on ${process.env.HOST||'0.0.0.0'}:${port}`));
