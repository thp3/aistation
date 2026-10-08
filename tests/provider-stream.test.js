import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aistation-stream-'));
process.env.DATA_DIR=dir;
process.env.DATA_ENCRYPTION_KEY='unit-test-provider-key-more-than-32-characters';
const {encrypt,db}=await import('../server/db.js');
const {streamProvider}=await import('../server/provider.js');

async function withChunks(chunks,fn){
 const saved=globalThis.fetch;
 globalThis.fetch=async()=>new Response(new ReadableStream({
  start(controller){for(const chunk of chunks)controller.enqueue(new TextEncoder().encode(chunk));controller.close()}
 }),{status:200,headers:{'Content-Type':'text/event-stream'}});
 try{return await fn()}finally{globalThis.fetch=saved}
}
const provider={protocol:'openai',endpoint:'https://example.invalid/v1/chat/completions',encrypted_key:encrypt('test-key')};
const options={
 provider,model:'proxy-model',system:'',messages:[{role:'user',content:'Hi'}],
 thinking:{params:{}},signal:AbortSignal.timeout(5000)
};

test('upstream activity is fired for heartbeats and thinking-only network packets',async()=>{
 const packets=[
  ': heartbeat\n\n',
  'data: '+JSON.stringify({choices:[{delta:{reasoning_content:'先思考'},finish_reason:null}]})+'\n\n',
  'data: '+JSON.stringify({choices:[{delta:{content:'回答'},finish_reason:'stop'}]})+'\n\n',
  'data: [DONE]\n\n'
 ];
 const thought=[],texts=[],calls=[];
 await withChunks(packets,async()=>{
  await streamProvider({...options,onActivity:()=>calls.push('chunk'),onDelta:t=>texts.push(t),onThinking:t=>thought.push(t),onUsage:()=>{},onFinished:()=>calls.push('done')});
 });
 assert.deepEqual(thought,['先思考']);
 assert.deepEqual(texts,['回答']);
 assert.equal(calls.filter(x=>x==='chunk').length,packets.length);
 assert.equal(calls.at(-1),'done');
});

test('finish_reason alone does not mark OpenAI SSE completion',async()=>{
 const packets=['data: '+JSON.stringify({choices:[{delta:{content:'partial'},finish_reason:'stop'}]})+'\n\n'];
 await withChunks(packets,()=>assert.rejects(
  streamProvider({...options,onActivity:()=>{},onDelta:()=>{},onUsage:()=>{},onFinished:()=>{throw Error('should not finish')}}),
  /official completion/
 ));
});

test('Claude message_stop ends its stream and exposes only real thinking text',async()=>{
 const packets=['event: ping\ndata: {"type":"ping"}\n\n',
 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"可顯示摘要"}}\n\n',
 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"signature_delta","signature":"secret"}}\n\n',
 'event: message_stop\ndata: {"type":"message_stop"}\n\n'];
 const seen=[];
 await withChunks(packets,()=>streamProvider({...options,provider:{...provider,protocol:'claude',endpoint:'https://example.invalid/v1/messages'},onDelta:t=>seen.push(t),onThinking:t=>seen.push(t),onActivity:()=>{},onUsage:()=>{},onFinished:()=>{}}));
 assert.deepEqual(seen,['可顯示摘要']);
});

test('cleanup fixture',()=>{
 db.close();
 try{fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200})}
 catch(e){if(process.platform!=='win32'||e.code!=='EPERM')throw e}
});
