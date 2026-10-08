import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aistation-gemini-unit-'));
process.env.DATA_DIR=dir;
process.env.DATA_ENCRYPTION_KEY='gemini-unit-test-key-at-least-32-characters';
const {db,encrypt}=await import('../server/db.js');
const {validateEndpoint,modelsUrl,generationUrl,requestSpec,discoverModels,streamProvider,normalizedUsage,redact}=await import('../server/provider.js');
const {resolveThinking}=await import('../server/thinking.js');
const provider={protocol:'gemini',endpoint:'https://gemini.invalid/v1beta',encrypted_key:encrypt('gemini-test-key')};
const options={provider,model:'gemini-3-flash-preview',system:'系統指令',messages:[{role:'user',content:'你好'}],signal:AbortSignal.timeout(5000)};
async function withFetch(mock,fn){
  const saved=globalThis.fetch;globalThis.fetch=mock;
  try{return await fn()}finally{globalThis.fetch=saved}
}
const sse=events=>new Response(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});

test('Gemini endpoint normalization, model action URLs and API key header',()=>{
  for(const endpoint of [provider.endpoint,provider.endpoint+'/',provider.endpoint+'/models',provider.endpoint+'/models/gemini-2.5-flash:generateContent'])
    assert.equal(validateEndpoint(endpoint,'gemini'),provider.endpoint);
  assert.equal(modelsUrl(provider),provider.endpoint+'/models');
  assert.equal(generationUrl(provider,'models/gemini-3-flash-preview'),provider.endpoint+'/models/gemini-3-flash-preview:streamGenerateContent?alt=sse');
  assert.equal(generationUrl(provider,'gemini-2.5-flash',false),provider.endpoint+'/models/gemini-2.5-flash:generateContent');
  assert.throws(()=>validateEndpoint(provider.endpoint+'?key=secret','gemini'));
  assert.throws(()=>validateEndpoint(provider.endpoint+'/chat/completions','gemini'));
  assert.throws(()=>validateEndpoint('file:///v1beta','gemini'));
  assert.throws(()=>validateEndpoint(provider.endpoint,'unknown'));
  assert.throws(()=>generationUrl(provider,'../../evil'));
  const spec=requestSpec(provider,'gemini-2.5-flash','系統',[
    {role:'user',content:'第一輪'},{role:'assistant',content:'回答'},{role:'user',content:'第二輪'}
  ]);
  assert.equal(spec.headers['x-goog-api-key'],'gemini-test-key');
  assert.equal(spec.headers.Authorization,undefined);
  assert.deepEqual(spec.body,{
    systemInstruction:{parts:[{text:'系統'}]},
    contents:[{role:'user',parts:[{text:'第一輪'}]},{role:'model',parts:[{text:'回答'}]},{role:'user',parts:[{text:'第二輪'}]}]
  });
  assert.equal(redact('{"x-goog-api-key":"secret"}'),'{"x-goog-api-key":"[REDACTED]"}');
});

test('Gemini model discovery follows pages and excludes embedding-only models',async()=>{
  const urls=[];
  await withFetch(async(url,init)=>{
    urls.push(String(url));assert.equal(init.headers['x-goog-api-key'],'gemini-test-key');
    return Response.json(urls.length===1?{
      models:[{name:'models/gemini-2.5-flash',supportedGenerationMethods:['generateContent']},
        {name:'models/embedding-001',supportedGenerationMethods:['embedContent']}],nextPageToken:'next page'
    }:{models:[{name:'models/gemini-3-flash-preview',supportedGenerationMethods:['generateContent']},
      {name:'models/gemini-2.5-flash',supportedGenerationMethods:['generateContent']}]});
  },async()=>assert.deepEqual(await discoverModels(provider),['gemini-2.5-flash','gemini-3-flash-preview']));
  assert.equal(urls[0],provider.endpoint+'/models');
  assert.equal(new URL(urls[1]).searchParams.get('pageToken'),'next page');
  await withFetch(async()=>Response.json({models:[],nextPageToken:'loop'}),
    ()=>assert.rejects(discoverModels(provider),/重複/));
});

test('Gemini stream separates thoughts and text, ignores signatures, and records final usage',async()=>{
  const thought=[],text=[];let finished;
  await withFetch(async(url,init)=>{
    assert.equal(url,generationUrl(provider,options.model));
    assert.equal(JSON.parse(init.body).contents[0].parts[0].text,'你好');
    return sse([
      {candidates:[{index:0,content:{parts:[{thought:true,text:'先分析'},{thoughtSignature:'opaque-secret'}]}}]},
      {candidates:[{index:0,content:{parts:[{text:'答案'}]}}],usageMetadata:{promptTokenCount:8}},
      {candidates:[{index:0,finishReason:'STOP'}]},
      {usageMetadata:{candidatesTokenCount:4,thoughtsTokenCount:2,cachedContentTokenCount:3,totalTokenCount:14}}
    ]);
  },()=>streamProvider({...options,onDelta:t=>text.push(t),onThinking:t=>thought.push(t),onUsage:()=>{},onFinished:(u,r)=>{finished={u,r}}}));
  assert.deepEqual(thought,['先分析']);assert.deepEqual(text,['答案']);
  assert.equal(finished.r,'STOP');
  assert.deepEqual(normalizedUsage('gemini',finished.u),{input_tokens:8,output_tokens:4,total_tokens:14,cache_read_tokens:3,cache_creation_tokens:null,reasoning_tokens:2});
  assert.deepEqual(normalizedUsage('gemini',{promptTokenCount:8}),{input_tokens:8,output_tokens:null,total_tokens:null,cache_read_tokens:null,cache_creation_tokens:null,reasoning_tokens:null});
});

test('Gemini incomplete, blocked and error streams fail without claiming completion',async()=>{
  for(const [events,pattern] of [
    [[{candidates:[{content:{parts:[{text:'部分回答'}]}}]}],/official completion/],
    [[{promptFeedback:{blockReason:'SAFETY'}}],/SAFETY/],
    [[{candidates:[{finishReason:'RECITATION'}]}],/RECITATION/],
    [[{candidates:[{content:{parts:[{inlineData:{mimeType:'audio/wav',data:'ignored'}}]},finishReason:'STOP'}]}],/未回傳文字回答/],
    [[{error:{status:'RESOURCE_EXHAUSTED',message:'quota gemini-test-key'}}],/RESOURCE_EXHAUSTED/]
  ])await withFetch(async()=>sse(events),()=>assert.rejects(
    streamProvider({...options,onDelta:()=>{},onUsage:()=>{},onFinished:()=>assert.fail('must not complete')}),
    err=>{assert.match(err.message,pattern);assert.ok(!err.message.includes('gemini-test-key'));return true}
  ));
  await withFetch(async()=>new Response('data: {broken}\n\n'),()=>assert.rejects(
    streamProvider({...options,onDelta:()=>{},onUsage:()=>{},onFinished:()=>{}}),/Invalid Gemini SSE JSON/
  ));
  let reason;
  await withFetch(async()=>sse([{candidates:[{content:{parts:[{text:'截斷回答'}]},finishReason:'MAX_TOKENS'}]}]),
    ()=>streamProvider({...options,onDelta:()=>{},onUsage:()=>{},onFinished:(_u,r)=>{reason=r}}));
  assert.equal(reason,'MAX_TOKENS');
});

test('Gemini thinking uses levels for current models and budgets for 2.5 with model limits',()=>{
  assert.deepEqual(resolveThinking('gemini','gemini-3-flash-preview',{mode:'default'}).params,{});
  assert.deepEqual(resolveThinking('gemini','gemini-3-flash-preview',{mode:'effort',effort:'medium'}).params,
    {generationConfig:{thinkingConfig:{includeThoughts:true,thinkingLevel:'medium'}}});
  assert.deepEqual(resolveThinking('gemini','models/gemini-2.5-flash',{mode:'effort',effort:'high'}).params,
    {generationConfig:{thinkingConfig:{includeThoughts:true,thinkingBudget:8192}}});
  assert.equal(resolveThinking('gemini','gemini-2.5-flash',{mode:'effort',effort:'none'}).budget_tokens,0);
  assert.equal(resolveThinking('gemini','gemini-2.5-pro',{mode:'budget',budget_tokens:32768}).budget_tokens,32768);
  for(const [model,config] of [
    ['gemini-3-flash-preview',{mode:'effort',effort:'max'}],
    ['gemini-3-flash-preview',{mode:'budget',budget_tokens:4096}],
    ['gemini-2.5-pro',{mode:'effort',effort:'none'}],
    ['gemini-2.5-pro',{mode:'budget',budget_tokens:127}],
    ['gemini-2.5-flash',{mode:'budget',budget_tokens:24577}],
    ['gemini-2.5-flash-lite',{mode:'budget',budget_tokens:128}],
    ['custom-model',{mode:'budget',budget_tokens:'4096'}],
    ['custom-model',{mode:'budget',budget_tokens:-1}],
    ['custom-model',{mode:'invalid'}]
  ])assert.throws(()=>resolveThinking('gemini',model,config));
});

test.after(()=>{
  db.close();
  fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});
});
