import {id,db,one,run,query,decrypt,getSetting,utcNow} from './db.js';
import {normalizedUsage,providerError,redact} from './provider.js';

/**
 * Title generation only runs once, after the first successful assistant turn.
 * It is independent from the FIFO and must never hold or fail chat generation.
 */
export async function autoNameFirstTurn(cid,emit){
  const setting=getSetting('naming_model_id');
  if(!setting)return;
  const convo=one('SELECT * FROM conversations WHERE id=?',cid);
  if(!convo||convo.auto_title_attempted||convo.title_customized)return;
  const completed=one("SELECT COUNT(*) AS n FROM messages WHERE conversation_id=? AND role='assistant' AND status='complete'",cid)?.n||0;
  if(completed!==1)return;
  const model=one('SELECT m.*,p.name provider_name,p.protocol,p.endpoint,p.encrypted_key FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id=? AND m.enabled=1',setting);
  if(!model)return;
  const changed=run('UPDATE conversations SET auto_title_attempted=1 WHERE id=? AND auto_title_attempted=0 AND title_customized=0',cid);
  if(!changed.changes)return;
  const started=utcNow(),rid=id();
  const messages=query("SELECT role,content FROM messages WHERE conversation_id=? ORDER BY created_at,rowid",cid);
  const transcript=[...(convo.system_prompt?['系統提示詞：'+convo.system_prompt.slice(0,1500)]:[]),...messages.map(m=>`${m.role==='user'?'使用者':'助理'}：${m.content.slice(0,3500)}`)].join('\n').slice(0,9000);
  const instructions='請依下列對話內容，提供一個簡短、具辨識度的繁體中文話題標題，最多 16 個中文字或 32 個字元。只回傳一行標題，不要引號、前綴、說明或 Markdown。';
  const key=decrypt(model.encrypted_key);
  const headers={'Content-Type':'application/json',...(model.protocol==='openai'?{Authorization:'Bearer '+key}:{'x-api-key':key,'anthropic-version':'2023-06-01'})};
  const body=model.protocol==='openai'
   ?{model:model.model_id,stream:false,messages:[{role:'system',content:instructions},{role:'user',content:transcript}]}
   :{model:model.model_id,stream:false,max_tokens:128,system:instructions,messages:[{role:'user',content:transcript}]};
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort('title_timeout'),20000);
  let status='complete',rawUsage={},errorBody=null,httpStatus=null,errorCode=null,title=null;
  try{
    const response=await fetch(model.endpoint,{method:'POST',headers,body:JSON.stringify(body),signal:controller.signal});
    const text=await response.text();
    if(!response.ok)throw providerError(response.status,text,key);
    const data=JSON.parse(text);
    rawUsage=data.usage||{};
    const value=model.protocol==='openai'?data.choices?.[0]?.message?.content:data.content?.filter(c=>c.type==='text').map(c=>c.text).join('');
    title=String(value||'').split(/[\r\n]/)[0].replace(/^[\s"'「『#*]+|[\s"'」』#*]+$/g,'').trim().slice(0,40);
    if(!title)throw Error('命名模型未回傳有效標題');
    const changed=run("UPDATE conversations SET title=?,updated_at=? WHERE id=? AND title_customized=0 AND auto_title_attempted=1 AND title IN ('新的對話','新對話')",title,utcNow(),cid);
    if(changed.changes)emit(cid,null,'title',{title});
  }catch(err){
    status='error';httpStatus=err.status||null;errorCode=err.provider_code||String(controller.signal.reason||'NAMING_ERROR');
    errorBody=redact(err.raw||err.message,[key]);
  }finally{
    clearTimeout(timeout);
    // Naming calls are recorded independently so statistics never omit their cost.
    const usage=normalizedUsage(model.protocol,rawUsage);
    if(one('SELECT id FROM conversations WHERE id=?',cid))run(`INSERT INTO requests
      (id,conversation_id,provider_id,provider_name,model_id,status,started_at,finished_at,
       input_tokens,output_tokens,total_tokens,cache_read_tokens,cache_creation_tokens,reasoning_tokens,
       usage_raw,kind,http_status,provider_error_code,error_body)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      rid,cid,model.provider_id,model.provider_name,model.model_id,status,started,utcNow(),
      usage.input_tokens,usage.output_tokens,usage.total_tokens,usage.cache_read_tokens,
      usage.cache_creation_tokens,usage.reasoning_tokens,JSON.stringify(rawUsage),'naming',
      httpStatus,errorCode,errorBody);
  }
}
