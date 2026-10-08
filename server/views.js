import {query,one} from './db.js';
import {queueState,flushDeltas,liveMessage} from './queue.js';

export const conversationFields='id,title,provider_id,model_id,created_at,updated_at';
export function pageSize(value,defaultValue=50){
 const n=Number(value??defaultValue);
 if(!Number.isSafeInteger(n)||n<1||n>100)throw Object.assign(Error('分頁大小必須是 1 到 100'),{status:400});
 return n;
}
function decodeCursor(value){
 try{const c=JSON.parse(Buffer.from(String(value),'base64url').toString());if(typeof c.updated_at!=='string'||typeof c.id!=='string')throw Error();return c}
 catch{throw Object.assign(Error('無效分頁游標'),{status:400})}
}
export function conversationsPage({limit,cursor,q}={}){
 const size=pageSize(limit),where=[],args=[];
 if(q){where.push("title LIKE ? ESCAPE '\\'");args.push('%'+String(q).slice(0,120).replace(/[\\%_]/g,'\\$&')+'%')}
 if(cursor){const c=decodeCursor(cursor);where.push('(updated_at<? OR (updated_at=? AND id<?))');args.push(c.updated_at,c.updated_at,c.id)}
 const rows=query(`SELECT ${conversationFields} FROM conversations ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY updated_at DESC,id DESC LIMIT ?`,...args,size+1);
 const hasMore=rows.length>size,items=rows.slice(0,size),last=items.at(-1);
 return {items,next_cursor:hasMore?Buffer.from(JSON.stringify({updated_at:last.updated_at,id:last.id})).toString('base64url'):null};
}
const requestFields='r.id,r.conversation_id,r.assistant_message_id,r.provider_name,r.model_id,r.status,r.input_tokens,r.output_tokens,r.total_tokens,r.cache_read_tokens,r.cache_creation_tokens,r.reasoning_tokens,r.finish_reason,r.http_status,r.provider_error_code,r.error_body,r.started_at,r.finished_at,r.thinking_mode,r.thinking_effort,r.thinking_budget_tokens';
export function messagesPage(cid,{limit,before}={}){
 const size=pageSize(limit);let bound=Number.MAX_SAFE_INTEGER;
 if(before!==undefined){bound=Number(before);if(!Number.isSafeInteger(bound)||bound<1)throw Object.assign(Error('無效訊息游標'),{status:400})}
 const rows=query('SELECT rowid AS cursor,* FROM messages WHERE conversation_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?',cid,bound,size+1);
 const hasMore=rows.length>size,items=rows.slice(0,size).reverse();
 const requests=items.length?query(`SELECT ${requestFields} FROM requests r WHERE r.conversation_id=? AND r.assistant_message_id IN (${items.map(()=>'?').join(',')})`,cid,...items.map(m=>m.id)):[];
 return {items,requests,next_cursor:hasMore?items[0].cursor:null};
}
export function conversationDetail(cid,limit){
 const c=one('SELECT * FROM conversations WHERE id=?',cid);if(!c)return null;
 flushDeltas(cid);
 const page=limit===undefined?null:messagesPage(cid,{limit});
 const messages=page?.items??query('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at,rowid',cid);
 const live=liveMessage(cid);if(live){const msg=messages.find(m=>m.id===live.id);if(msg)Object.assign(msg,live)}
 return {...c,messages,requests:page?.requests??query('SELECT * FROM requests WHERE conversation_id=? ORDER BY started_at',cid),
  messages_cursor:page?.next_cursor??null,queue:queueState(cid),event_cursor:Math.max(one('SELECT MAX(seq) AS seq FROM queue_events WHERE conversation_id=?',cid)?.seq||0,one('SELECT seq FROM event_floors WHERE conversation_id=?',cid)?.seq||0)};
}
