import { decrypt } from './db.js';
import { SSEParser } from '../src/sse.js';

export function redact(text, secrets=[]) {
  let out=String(text ?? '');
  for(const s of secrets.filter(Boolean)) out=out.split(s).join('[REDACTED]');
  return out.replace(/(Bearer\s+)[^\s"'<>]+/gi,'$1[REDACTED]').replace(/("(?:api_key|authorization|x-api-key|key)"\s*:\s*")[^"]+/gi,'$1[REDACTED]').slice(0,100000);
}
export function validateEndpoint(raw,protocol){
  const url=new URL(raw); if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash) throw Error('Endpoint must be a complete HTTP(S) API URL without credentials or fragment');
  if(protocol==='openai'&&!url.pathname.endsWith('/chat/completions')&&!url.pathname.endsWith('/responses')) throw Error('OpenAI endpoint must end in /chat/completions (Responses is not supported for streaming yet)');
  if(protocol==='openai'&&url.pathname.endsWith('/responses')) throw Error('Please enter a /chat/completions endpoint');
  if(protocol==='claude'&&!url.pathname.endsWith('/messages')) throw Error('Claude endpoint must end in /messages');
  return url.toString();
}
export function modelsUrl(p) {
  const u=new URL(p.endpoint);
  u.pathname=p.protocol==='openai'?u.pathname.replace(/\/chat\/completions$/,'/models'):u.pathname.replace(/\/messages$/,'/models');
  u.search='';return u.toString();
}
function authHeaders(provider){
  const key=decrypt(provider.encrypted_key);
  return provider.protocol==='openai'?{'Authorization':'Bearer '+key}:{'x-api-key':key,'anthropic-version':'2023-06-01'};
}
export async function discoverModels(provider){
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),20000);
  try{
    const res=await fetch(modelsUrl(provider),{headers:authHeaders(provider),signal:controller.signal});
    const text=await res.text();if(!res.ok) throw providerError(res.status,text,decrypt(provider.encrypted_key));
    const data=JSON.parse(text);
    const arr=Array.isArray(data.data)?data.data:Array.isArray(data.models)?data.models:[];
    return [...new Set(arr.map(v=>typeof v==='string'?v:v.id||v.name).filter(v=>typeof v==='string'&&v.length<300))];
  }finally{clearTimeout(timer);}
}
export function providerError(status,raw,key=''){
  let obj;try{obj=JSON.parse(raw)}catch{}
  const err=new Error(redact(raw,[key]));err.status=status;
  err.provider_code=String(obj?.error?.code||obj?.error?.type||obj?.code||'unknown');
  err.raw=redact(raw,[key]);return err;
}
export function requestSpec(provider,model,system,messages,thinking={params:{}}){
 const body=provider.protocol==='openai'?
  {model,stream:true,stream_options:{include_usage:true},messages:[...(system?[{role:'system',content:system}]:[]),...messages]}:
  {model,max_tokens:4096,stream:true,...(system?{system}:{}),messages};
 Object.assign(body,thinking.params||{});
 const headers={'Content-Type':'application/json',...authHeaders(provider)};
 return {body,headers};
}
export async function streamProvider({provider,model,system,messages,thinking,signal,onDelta,onThinking=()=>{},onActivity=()=>{},onUsage,onFinished}){
 const key=decrypt(provider.encrypted_key), spec=requestSpec(provider,model,system,messages,thinking);
 const res=await fetch(provider.endpoint,{method:'POST',headers:spec.headers,body:JSON.stringify(spec.body),signal});
 if(!res.ok) throw providerError(res.status,await res.text(),key);
 if(!res.body)throw Error('Provider returned no SSE body');
 let finished=false, usage={}, reason=null;
 const emit=({event,data:raw})=>{
   if(provider.protocol==='openai'&&raw==='[DONE]'){finished=true;return;}
   let ev;try{ev=JSON.parse(raw)}catch{return}
   if(provider.protocol==='openai'){
     if(ev.error||ev.type==='error')throw providerError(res.status,JSON.stringify(ev.error||ev),key);
     const choice=ev.choices?.[0];
     const delta=choice?.delta?.content;if(typeof delta==='string')onDelta(delta);
     // OpenAI official Chat Completions does not expose raw reasoning.
     // Some compatible relays do supply reasoning_content / reasoning / thinking.
     const reasoning=choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? choice?.delta?.thinking;
     if(typeof reasoning==='string'&&reasoning)onThinking(reasoning);
     if(ev.usage)usage={...usage,...ev.usage};
     if(choice?.finish_reason)reason=choice.finish_reason;
   }else{
     if(ev.type==='error')throw providerError(res.status,JSON.stringify(ev.error),key);
     if(ev.type==='content_block_start'&&ev.content_block?.type==='thinking'&&ev.content_block?.thinking)
       onThinking(ev.content_block.thinking);
     if(ev.type==='content_block_delta'&&ev.delta?.type==='text_delta')onDelta(ev.delta.text||'');
     if(ev.type==='content_block_delta'&&ev.delta?.type==='thinking_delta'&&typeof ev.delta.thinking==='string')
       onThinking(ev.delta.thinking);
     if(ev.type==='message_start'&&ev.message?.usage)usage={...usage,...ev.message.usage};
     if(ev.type==='message_delta'){usage={...usage,...ev.usage};reason=ev.delta?.stop_reason||reason;}
     if(ev.type==='message_stop')finished=true;
   }
   onUsage(usage,reason);
 };
 const parser=new SSEParser(emit);
 for await (const chunk of res.body){
   onActivity();
   parser.feed(chunk);
 }
 parser.end();
 if(!finished)throw Error('Upstream ended without an official completion event');
 onFinished(usage,reason);
}
export function normalizedUsage(protocol,u={}){
 const v=(...xs)=>{for(const x of xs)if(Number.isSafeInteger(x)&&x>=0)return x;return null};
 if(protocol==='openai')return {input_tokens:v(u.prompt_tokens),output_tokens:v(u.completion_tokens),total_tokens:v(u.total_tokens),cache_read_tokens:v(u.prompt_tokens_details?.cached_tokens),cache_creation_tokens:null,reasoning_tokens:v(u.completion_tokens_details?.reasoning_tokens)};
 return {input_tokens:v(u.input_tokens),output_tokens:v(u.output_tokens),total_tokens:v(u.total_tokens),cache_read_tokens:v(u.cache_read_input_tokens),cache_creation_tokens:v(u.cache_creation_input_tokens),reasoning_tokens:v(u.output_tokens_details?.thinking_tokens,u.thinking_tokens)};
}
