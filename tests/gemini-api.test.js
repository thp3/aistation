import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sendAndWait} from './queue-test-helper.js';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return server.address().port}
test('Gemini admin, queued multi-turn chat, thinking, naming and errors work end to end',{timeout:25000},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aistation-gemini-api-'));
  const calls=[];let child,stderr='';
  const upstream=createServer(async(req,res)=>{
    assert.equal(req.headers['x-goog-api-key'],'gemini-key');
    const url=new URL(req.url,'http://mock');
    if(url.pathname==='/v1beta/models'){
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify(url.searchParams.has('pageToken')?{
        models:[{name:'models/gemini-title',supportedGenerationMethods:['generateContent']}]
      }:{models:[{name:'models/gemini-3-flash-preview',supportedGenerationMethods:['generateContent']},
        {name:'models/embedding',supportedGenerationMethods:['embedContent']}],nextPageToken:'page2'}));return;
    }
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString());calls.push({url,body});
    if(url.pathname.endsWith(':generateContent')){
      assert.equal(url.pathname,'/v1beta/models/gemini-title:generateContent');
      res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({candidates:[{content:{parts:[{thought:true,text:'這不是標題'},{text:'「Gemini 整合測試」'}]},finishReason:'STOP'}],
        usageMetadata:{promptTokenCount:12,candidatesTokenCount:5,thoughtsTokenCount:2,totalTokenCount:19}}));return;
    }
    assert.equal(url.pathname,'/v1beta/models/gemini-3-flash-preview:streamGenerateContent');
    assert.equal(url.searchParams.get('alt'),'sse');
    const prompt=body.contents.at(-1).parts[0].text;
    if(prompt==='quota'){
      res.writeHead(429,{'Content-Type':'application/json'});
      res.end(JSON.stringify({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'quota gemini-key'}}));return;
    }
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const frame=data=>'data: '+JSON.stringify(data)+'\n\n';
    if(prompt==='blocked'){
      res.end(frame({promptFeedback:{blockReason:'SAFETY'},usageMetadata:{promptTokenCount:7}}));return;
    }
    res.write(frame({candidates:[{index:0,content:{parts:[{thought:true,text:'思考摘要'},{thoughtSignature:'signature'},{text:'你好 Gemini'}]}}]}));
    if(prompt==='incomplete'){res.end();return;}
    res.end(frame({candidates:[{index:0,finishReason:'STOP'}],usageMetadata:{promptTokenCount:7,candidatesTokenCount:4,thoughtsTokenCount:3,cachedContentTokenCount:2,totalTokenCount:14}}));
  });
  try{
    const upstreamPort=await listen(upstream);
    const portServer=createServer(),appPort=await listen(portServer);
    await new Promise(resolve=>portServer.close(resolve));
    const base='http://127.0.0.1:'+appPort;
    child=spawn(process.execPath,['server/index.js'],{cwd:path.resolve(import.meta.dirname,'..'),
      env:{...process.env,HOST:'127.0.0.1',PORT:String(appPort),DATA_DIR:dir,
        ADMIN_USERNAME:'geminiadmin',ADMIN_PASSWORD:'gemini-test-password-123456',
        SESSION_SECRET:'gemini-test-session-secret-at-least-32-chars',DATA_ENCRYPTION_KEY:'gemini-test-encryption-key-at-least-32-chars'},
      stdio:['ignore','pipe','pipe'],windowsHide:true});
    child.stdout.on('data',()=>{});child.stderr.on('data',chunk=>stderr+=chunk);
    let ready=false;
    for(let i=0;i<100;i++){
      if(child.exitCode!==null)throw Error('App exited: '+stderr);
      try{if((await fetch(base+'/api/me')).status===401){ready=true;break}}catch{}
      await sleep(50);
    }
    assert.ok(ready,stderr);
    const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username:'geminiadmin',password:'gemini-test-password-123456'})});
    assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const req=async(uri,method='GET',body)=>{
      const res=await fetch(base+'/api'+uri,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
      return {status:res.status,data:await res.json()};
    };
    const p=await req('/providers','POST',{name:'Gemini',protocol:'gemini',endpoint:'http://127.0.0.1:'+upstreamPort+'/v1beta',api_key:'gemini-key'});
    assert.equal(p.status,201,JSON.stringify(p.data));assert.equal(p.data.models_found,2);
    const providers=(await req('/providers')).data;
    assert.equal(providers[0].protocol,'gemini');assert.ok(!JSON.stringify(providers).includes('gemini-key'));
    assert.equal((await req('/providers/'+p.data.id,'PATCH',{name:'Google Gemini'})).status,200);
    assert.equal((await req('/providers/'+p.data.id,'PATCH',{protocol:'invalid'})).status,400);
    assert.equal((await req('/providers/'+p.data.id+'/test','POST')).data.models_found,2);
    const models=(await req('/models')).data;
    assert.ok(models.every(m=>m.protocol==='gemini'));
    const naming=models.find(m=>m.model_id==='gemini-title');
    await req('/settings','PATCH',{naming_model_id:naming.id});
    const convo=(await req('/conversations','POST',{provider_id:p.data.id,model_id:'gemini-3-flash-preview',system_prompt:'請用繁體中文'})).data;
    const cid=convo.id;
    const sent=await sendAndWait(base,cookie,req,cid,{content:'Hello',thinking:{mode:'effort',effort:'medium'}});
    assert.equal(sent.job.state,'complete');assert.match(sent.data,/event: thinking_delta/);
    let detail;
    for(let i=0;i<100;i++){
      detail=(await req('/conversations/'+cid)).data;
      if(detail.requests.some(r=>r.kind==='naming'))break;
      await sleep(40);
    }
    assert.equal(detail.title,'Gemini 整合測試');
    assert.equal(detail.messages.at(-1).content,'你好 Gemini');
    assert.equal(detail.messages.at(-1).thinking_content,'思考摘要');
    const chat=detail.requests.find(r=>r.kind==='chat'),title=detail.requests.find(r=>r.kind==='naming');
    assert.equal(chat.thinking_effort,'medium');assert.equal(chat.reasoning_tokens,3);
    assert.equal(chat.total_tokens,14);assert.equal(chat.cache_read_tokens,2);
    assert.equal(title.total_tokens,19);assert.equal(title.reasoning_tokens,2);
    assert.deepEqual(calls[0].body.generationConfig,{thinkingConfig:{thinkingLevel:'medium',includeThoughts:true}});
    assert.equal(calls[0].body.systemInstruction.parts[0].text,'請用繁體中文');
    assert.match(calls[1].body.contents[0].parts[0].text,/你好 Gemini/);
    await sendAndWait(base,cookie,req,cid,{content:'第二輪'});
    const next=calls.at(-1).body;
    assert.deepEqual(next.contents.map(c=>c.role),['user','model','user']);
    assert.deepEqual(next.contents.map(c=>c.parts[0].text),['Hello','你好 Gemini','第二輪']);
    assert.equal(next.generationConfig,undefined);
    assert.equal(calls.filter(c=>c.url.pathname.endsWith(':generateContent')).length,1);
    for(const [content,code] of [['quota','RESOURCE_EXHAUSTED'],['blocked','SAFETY'],['incomplete','unknown']]){
      const c=(await req('/conversations','POST',{title:'錯誤測試',provider_id:p.data.id,model_id:'gemini-3-flash-preview'})).data;
      const sent=await sendAndWait(base,cookie,req,c.id,{content});assert.equal(sent.job.state,'error');
      const saved=(await req('/conversations/'+c.id)).data;
      assert.equal(saved.queue.paused,true);assert.equal(saved.requests[0].provider_error_code,code);
      assert.ok(!JSON.stringify(saved).includes('gemini-key'));
      if(content==='quota')assert.equal(saved.requests[0].http_status,429);
      if(content==='blocked')assert.equal(saved.requests[0].input_tokens,7);
      if(content==='incomplete')assert.equal(saved.messages.at(-1).content,'你好 Gemini');
    }
  }finally{
    if(child){child.kill();if(child.exitCode===null)await Promise.race([once(child,'exit'),sleep(3000)])}
    upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
    fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
});
