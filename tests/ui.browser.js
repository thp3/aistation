import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';

// This optional browser suite uses a separately installed Playwright runtime.
const playwrightModule=process.env.PLAYWRIGHT_MODULE;
const {chromium}=await import(playwrightModule?pathToFileURL(playwrightModule).href:'playwright');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let browser,child,base,dir;
test.before(async()=>{
  assert.ok(fs.existsSync(path.resolve('dist/index.html')),'Run npm run build before npm run test:ui');
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'aistation-ui-'));
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  base='http://127.0.0.1:'+port;
  child=spawn(process.execPath,['server/index.js'],{cwd:path.resolve(import.meta.dirname,'..'),windowsHide:true,
    env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dir,
      ADMIN_USERNAME:'uitest',ADMIN_PASSWORD:'ui-test-password-at-least-12',
      SESSION_SECRET:'ui-test-session-secret-at-least-32-characters',DATA_ENCRYPTION_KEY:'ui-test-data-secret-at-least-32-characters'},
    stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.on('data',()=>{});
  let ready=false;
  for(let i=0;i<100;i++){
    if(child.exitCode!==null)throw Error(stderr);
    try{if((await fetch(base+'/api/me')).status===401){ready=true;break}}catch{}
    await sleep(50);
  }
  assert.ok(ready,'Server did not start: '+stderr);
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
});
test.after(async()=>{
  await browser?.close();
  if(child){child.kill();if(child.exitCode===null)await Promise.race([once(child,'exit'),sleep(3000)])}
  if(dir)fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});
});

function conversation(id){
  return {id,title:id==='a'?'對話 A':'對話 B',provider_id:'p',model_id:'model-one',system_prompt:'',requests:[],
    messages:[],queue:{paused:false,jobs:[]},event_cursor:0};
}
async function fixture(t,{mobile=false,long=false,messages=null,preparePage=null}={}){
  const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1100,height:850},...(mobile?{isMobile:true,hasTouch:true}:{})});
  t.after(()=>context.close());
  const page=await context.newPage(),errors=[],chats={a:conversation('a'),b:conversation('b')};
  if(long)chats.a.messages=Array.from({length:30},(_,i)=>({id:'m'+i,role:i%2?'assistant':'user',status:'complete',content:i%2?'歷史內容\n\n```js\nconst value = 1;\n```':'歷史問題 '+i,thinking_content:''}));
  if(messages)chats.a.messages=messages;
  const assets=[],sent=[];let onDetail=null,onSend=null,onStats=null,generationCalls=0;
  page.on('request',request=>{if(request.url().includes('/assets/'))assets.push(request.url())});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',dialog=>dialog.dismiss());
  await page.addInitScript(()=>{
    localStorage.setItem('ai-station-last-conversation','a');
    window.__feeds=[];
    window.EventSource=class {
      constructor(url){this.url=url;this.listeners={};this.closed=false;window.__feeds.push(this)}
      addEventListener(type,fn){(this.listeners[type]??=[]).push(fn)}
      close(){this.closed=true}
      emit(type,data,seq=0){if(!this.closed)for(const fn of this.listeners[type]||[])fn({data:JSON.stringify(data),lastEventId:String(seq)})}
    };
  });
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),uri=url.pathname.slice(4),method=request.method();
    const respond=data=>route.fulfill({json:data});
    if(uri==='/me')return respond({username:'uitest'});
    if(uri==='/providers')return respond([{id:'p',name:'測試端點',protocol:'openai'}]);
    if(uri==='/models')return respond(['model-one','model-two'].map((model_id,i)=>({id:'model-'+i,provider_id:'p',provider_name:'測試端點',model_id,protocol:'openai',enabled:1})));
    if(uri==='/settings')return respond({default_system_prompt:'',naming_model_id:''});
    if(uri==='/generations'){generationCalls++;return respond({active:[]})}
    if(uri==='/stats'){if(onStats)await onStats();return respond({requests:{count:0},usage:{},recent:[]})}
    if(uri==='/conversations'&&method==='GET')return respond(Object.values(chats).map(({messages,requests,queue,...rest})=>rest));
    if(uri==='/conversations'&&method==='POST'){chats.new={...conversation('new'),title:'新的對話'};return respond(chats.new)}
    const history=uri.match(/^\/conversations\/([^/]+)\/messages\/([^/]+)$/);
    if(history){
      const chat=chats[history[1]],message=chat.messages.find(m=>m.id===history[2]);
      if(method==='PATCH'){message.content=request.postDataJSON().content;message.thinking_content='';return respond({ok:true})}
      if(method==='DELETE'){chat.messages=chat.messages.filter(m=>m!==message);return respond({ok:true})}
    }
    const rewind=uri.match(/^\/conversations\/([^/]+)\/rewind$/);
    if(rewind){
      const chat=chats[rewind[1]],index=chat.messages.findIndex(m=>m.id===request.postDataJSON().message_id);
      const content=chat.messages[index].content;chat.messages=chat.messages.slice(0,index);
      return respond({rewound_text:content});
    }
    const match=uri.match(/^\/conversations\/([^/]+)(\/send)?$/);
    if(match){
      const cid=match[1];
      if(match[2]){const body=request.postDataJSON();sent.push({cid,...body});if(onSend)await onSend(body);return respond({request_id:body.idempotency_key,state:'queued'})}
      if(method==='PATCH'){Object.assign(chats[cid],request.postDataJSON());return respond(chats[cid])}
      if(onDetail)await onDetail(cid);
      return respond(chats[cid]);
    }
    throw Error('Unexpected API '+uri);
  });
  if(preparePage)await preparePage(page);
  await page.goto(base);await page.waitForSelector('#compose');
  if(long)await page.waitForSelector('pre code.hljs');
  return {page,chats,sent,errors,assets,generationCalls:()=>generationCalls,setDetail:fn=>{onDetail=fn},setSend:fn=>{onSend=fn},setStats:fn=>{onStats=fn}};
}

test('drafts survive model changes, page switches, conversation changes and reloads',async t=>{
  const {page,errors}=await fixture(t);
  await page.locator('#compose').fill('  尚未送出的草稿\n第二行  ');
  await page.locator('#modelSelect').selectOption('model-1');
  await page.waitForFunction(()=>document.querySelector('#modelSelect')?.value==='model-1'&&document.querySelector('#compose')?.value.includes('第二行'));
  await page.locator('[data-tab="admin"]').click();await page.waitForSelector('#providerForm');
  await page.locator('[data-tab="chat"]').click();
  assert.equal(await page.locator('#compose').inputValue(),'  尚未送出的草稿\n第二行  ');
  await page.locator('[data-convo="b"]').click();await page.waitForFunction(()=>document.querySelector('#compose')?.dataset.conversationId==='b');
  await page.locator('#compose').fill('B 的草稿');
  await page.locator('[data-convo="a"]').click();await page.waitForFunction(()=>document.querySelector('#compose')?.dataset.conversationId==='a');
  assert.equal(await page.locator('#compose').inputValue(),'  尚未送出的草稿\n第二行  ');
  await page.reload();await page.waitForSelector('#compose');
  assert.equal(await page.locator('#compose').inputValue(),'  尚未送出的草稿\n第二行  ');
  await page.locator('[data-convo="b"]').click();await page.waitForFunction(()=>document.querySelector('#compose')?.dataset.conversationId==='b');
  assert.equal(await page.locator('#compose').inputValue(),'B 的草稿');assert.deepEqual(errors,[]);
});

test('a delayed send acknowledgement preserves newer typing and prevents duplicate submissions',async t=>{
  const {page,sent,setSend,errors}=await fixture(t);
  let release;const gate=new Promise(resolve=>release=resolve);setSend(()=>gate);
  await page.locator('#compose').fill('第一則');await page.locator('#send').click();
  await page.waitForFunction(()=>document.querySelector('#send').disabled);
  await page.locator('#compose').fill('下一則，還沒送出');await page.locator('#compose').press('Enter');
  assert.equal(sent.length,1);
  release();await page.waitForFunction(()=>!document.querySelector('#send').disabled);
  assert.equal(await page.locator('#compose').inputValue(),'下一則，還沒送出');
  assert.equal(sent[0].content,'第一則');
  await page.reload();await page.waitForSelector('#compose');
  assert.equal(await page.locator('#compose').inputValue(),'下一則，還沒送出');assert.deepEqual(errors,[]);
});

test('a late response cannot replace the last selected conversation',async t=>{
  const {page,setDetail,sent,errors}=await fixture(t);
  let release;const gate=new Promise(resolve=>release=resolve);
  setDetail(cid=>cid==='b'?gate:undefined);
  await page.locator('[data-convo="b"]').click();await page.locator('[data-convo="a"]').click();
  await page.waitForFunction(()=>document.querySelector('#compose')?.dataset.conversationId==='a');
  release();await page.waitForTimeout(150);
  assert.equal(await page.locator('.chat-top h2').innerText(),'對話 A');
  await page.locator('#compose').fill('留在 A');await page.locator('#send').click();
  await page.waitForFunction(()=>!document.querySelector('#send').disabled);
  assert.equal(sent[0].cid,'a');assert.deepEqual(errors,[]);
});

test('stream updates retain historical DOM and reading position, with an explicit jump to latest',async t=>{
  const {page,chats,setSend,errors}=await fixture(t,{long:true});
  setSend(body=>{
    chats.a.queue.jobs=[{id:body.idempotency_key,state:'running',content:body.content}];
    chats.a.messages.push({id:'answer',role:'assistant',status:'running',content:'',thinking_content:''});
    chats.a.requests.push({id:'r',assistant_message_id:'answer',status:'running'});
  });
  await page.locator('#compose').fill('請回答');await page.locator('#send').click();
  await page.waitForSelector('[data-message-id="answer"]');
  await page.evaluate(()=>{
    window.__historical=document.querySelector('[data-message-id="m1"]');
    const el=document.querySelector('#messages');el.scrollTop=120;el.dispatchEvent(new Event('scroll'));
  });
  const jobId=chats.a.queue.jobs[0].id;
  await page.evaluate(({jobId})=>{
    const feed=window.__feeds.at(-1);
    feed.emit('started',{request_id:jobId,assistant_id:'answer'});
    for(let i=0;i<12;i++)feed.emit('delta',{request_id:jobId,assistant_id:'answer',text:'串流回答 '+i+'\n'});
    feed.emit('thinking_delta',{request_id:jobId,assistant_id:'answer',text:'摘要'},42);
  },{jobId});
  await page.waitForFunction(()=>document.querySelector('[data-message-id="answer"] .prose')?.textContent.includes('串流回答'));
  assert.ok(await page.evaluate(()=>window.__historical===document.querySelector('[data-message-id="m1"]')));
  assert.ok(Math.abs(await page.locator('#messages').evaluate(el=>el.scrollTop)-120)<2);
  assert.ok(await page.locator('#jumpLatest').isVisible());
  await page.locator('#jumpLatest').click();
  assert.ok(await page.locator('#messages').evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop<2));
  assert.ok(await page.locator('#jumpLatest').isHidden());assert.deepEqual(errors,[]);
  await page.waitForTimeout(350);
  await page.locator('[data-tab="admin"]').click();await page.waitForSelector('#providerForm');
  await page.locator('[data-tab="chat"]').click();
  assert.equal(await page.evaluate(()=>new URL(window.__feeds.at(-1).url,location.origin).searchParams.get('after')),'42');
  assert.equal(await page.locator('[data-message-id="answer"]').count(),1);
});

test('mobile keeps new conversation accessible without horizontal page overflow',async t=>{
  const {page,errors}=await fixture(t,{mobile:true});
  assert.ok(await page.locator('#new').isVisible());
  const bounds=await page.locator('#new').boundingBox();assert.ok(bounds.width>=44&&bounds.height>=44);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.ok(await page.locator('#compose').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=16));
  assert.ok(await page.locator('#compose').evaluate(el=>el.getBoundingClientRect().bottom<=innerHeight));
  assert.ok(await page.locator('#systemPrompt').evaluate(el=>el.getBoundingClientRect().width>=200));
  if(process.env.UI_ARTIFACT_DIR){
    fs.mkdirSync(process.env.UI_ARTIFACT_DIR,{recursive:true});
    await page.screenshot({path:path.join(process.env.UI_ARTIFACT_DIR,'mobile-390.png')});
  }
  await page.setViewportSize({width:320,height:740});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  assert.ok(await page.locator('#new').isVisible());
  await page.locator('#new').click();await page.waitForFunction(()=>document.querySelector('#compose')?.dataset.conversationId==='new');
  assert.ok(await page.locator('#new').isVisible());assert.deepEqual(errors,[]);
});

test('history edit, delete and rewind still work with keyed message nodes and preserve the returned draft',async t=>{
  const {page,chats,errors}=await fixture(t,{long:true});
  page.removeAllListeners('dialog');page.on('dialog',dialog=>dialog.accept());
  await page.locator('[data-message-id="m1"]').getByRole('button',{name:'編輯',exact:true}).click();
  await page.locator('[data-editing-message] textarea').fill('修改後的回答');
  await page.getByRole('button',{name:'儲存修改',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('[data-message-id="m1"] .prose')?.textContent.includes('修改後的回答'));
  assert.equal(chats.a.messages[1].content,'修改後的回答');
  await page.locator('[data-message-id="m3"]').getByRole('button',{name:'刪除',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('[data-message-id="m3"]'));
  await page.locator('[data-message-id="m2"]').getByRole('button',{name:'回退至此',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#compose')?.value==='歷史問題 2');
  assert.equal(await page.locator('.message').count(),2);
  await page.reload();await page.waitForSelector('#compose');
  assert.equal(await page.locator('#compose').inputValue(),'歷史問題 2');assert.deepEqual(errors,[]);
});

test('only public hashed assets are cached; HTML and private API responses remain no-store',async()=>{
  const html=await fetch(base);assert.equal(html.headers.get('cache-control'),'no-store');
  const asset=(await html.text()).match(/src="([^"]+\.js)"/)[1];
  const js=await fetch(base+asset);assert.equal(js.headers.get('cache-control'),'public, max-age=31536000, immutable');
  const privateResponse=await fetch(base+'/api/me');assert.equal(privateResponse.headers.get('cache-control'),'no-store');
});


test('empty chats avoid renderer downloads; code and math load independently and sanitized markdown stays safe',async t=>{
  const {page,chats,assets,errors}=await fixture(t);
  assert.ok(!assets.some(url=>/\/(markdown|highlight|math)-/.test(url)));
  chats.a.messages=[{id:'rich',role:'assistant',status:'complete',content:'# 標題\n\n**粗體** <img src="x" onerror="window.__unsafe=true">\n\n```javascript\nconst literal = "$code$";\n```\n\n`$inlineCode$`',thinking_content:''}];
  await page.locator('[data-convo="b"]').click();await page.waitForFunction(()=>document.querySelector('#compose')?.dataset.conversationId==='b');
  await page.locator('[data-convo="a"]').click();
  await page.waitForSelector('[data-message-id="rich"] code .hljs-keyword');
  assert.equal(await page.locator('[data-message-id="rich"] strong').textContent(),'粗體');
  assert.ok(assets.some(url=>/\/markdown-/.test(url)));
  assert.ok(assets.some(url=>/\/highlight-/.test(url)));
  assert.ok(!assets.some(url=>/\/math-/.test(url)),'Dollars inside code must not load/render math');
  assert.equal(await page.locator('[data-message-id="rich"] pre code').textContent(),'const literal = "$code$";\n');
  assert.equal(await page.locator('[data-message-id="rich"] [onerror]').count(),0);
  assert.equal(await page.evaluate(()=>window.__unsafe),undefined);
  chats.a.messages[0].content='公式 $x^2$\n\n$$\n\\frac{1}{2}\n$$';
  await page.locator('[data-convo="b"]').click();await page.waitForFunction(()=>document.querySelector('#compose')?.dataset.conversationId==='b');
  await page.locator('[data-convo="a"]').click();await page.waitForSelector('.katex-display');
  assert.equal(await page.locator('.katex').count(),2);
  assert.ok(assets.some(url=>/\/math-/.test(url)));assert.deepEqual(errors,[]);
});

test('late renderer loading keeps plaintext readable and preserves an in-progress history edit',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const {page,errors}=await fixture(t,{messages:[{id:'slow-format',role:'assistant',status:'complete',content:'**原文**',thinking_content:''}],
    preparePage:page=>page.route('**/assets/markdown-*.js',async route=>{await gate;await route.continue()})});
  assert.equal(await page.locator('.plain-message').textContent(),'**原文**');
  await page.locator('[data-message-id="slow-format"]').getByRole('button',{name:'編輯',exact:true}).click();
  await page.locator('[data-editing-message] textarea').fill('還沒儲存的編輯內容');
  const formatted=page.waitForResponse(response=>/\/markdown-.*\.js/.test(response.url()));
  release();await formatted;await sleep(200);
  assert.equal(await page.locator('[data-editing-message] textarea').inputValue(),'還沒儲存的編輯內容');
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.waitForSelector('[data-message-id="slow-format"] strong');assert.deepEqual(errors,[]);
});

test('a delayed admin stats response cannot overwrite the selected chat page',async t=>{
  const {page,setStats,errors}=await fixture(t);
  let release;const gate=new Promise(resolve=>release=resolve);setStats(()=>gate);
  const statsRequest=page.waitForRequest(request=>request.url().endsWith('/api/stats'));
  await page.locator('[data-tab="admin"]').click();await page.waitForSelector('#providerForm');await statsRequest;
  await page.locator('[data-tab="chat"]').click();await page.waitForSelector('#compose');
  const statsResponse=page.waitForResponse(response=>response.url().endsWith('/api/stats'));
  release();await statsResponse;await sleep(100);
  assert.ok(await page.locator('#compose').isVisible());assert.equal(await page.locator('#providerForm').count(),0);assert.deepEqual(errors,[]);
});

test('generation polling pauses while hidden and resumes immediately on return',async t=>{
  const {page,generationCalls,errors}=await fixture(t);
  await page.evaluate(()=>{
    window.__testHidden=true;Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.__testHidden});
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const before=generationCalls();await sleep(2900);assert.equal(generationCalls(),before);
  const resumed=page.waitForResponse(response=>response.url().endsWith('/api/generations'));
  await page.evaluate(()=>{window.__testHidden=false;document.dispatchEvent(new Event('visibilitychange'))});
  await resumed;assert.equal(generationCalls(),before+1);assert.deepEqual(errors,[]);
});

test('Vite dev proxy forwards login, cookies and Origin with the configured backend port',async t=>{
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const devBase='http://127.0.0.1:'+port;
  const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port',String(port),'--strictPort'],{
    cwd:path.resolve(import.meta.dirname,'..'),windowsHide:true,env:{...process.env,DEV_API_TARGET:base},stdio:['ignore','pipe','pipe']});
  let stderr='';vite.stderr.on('data',data=>stderr+=data);vite.stdout.on('data',()=>{});
  t.after(async()=>{vite.kill();if(vite.exitCode===null)await Promise.race([once(vite,'exit'),sleep(3000)])});
  let ready=false;
  for(let i=0;i<100;i++){
    if(vite.exitCode!==null)throw Error(stderr);
    try{if((await fetch(devBase+'/api/me')).status===401){ready=true;break}}catch{}
    await sleep(50);
  }
  assert.ok(ready,stderr);
  const login=await fetch(devBase+'/api/login',{method:'POST',headers:{Origin:devBase,'Content-Type':'application/json'},
    body:JSON.stringify({username:'uitest',password:'ui-test-password-at-least-12'})});
  assert.equal(login.status,200,await login.text());
  const cookie=login.headers.get('set-cookie').split(';')[0];
  assert.match(cookie,/^session=/);
  const me=await fetch(devBase+'/api/me',{headers:{Cookie:cookie}});assert.equal(me.status,200);
  assert.equal((await me.json()).username,'uitest');
});


test('renderer download failures keep text usable and recover on reload without losing the compose draft',async t=>{
  let attempts=0;
  const {page,errors}=await fixture(t,{messages:[{id:'retry-format',role:'assistant',status:'complete',content:'**重要文字**',thinking_content:''}],
    preparePage:page=>page.route('**/assets/markdown-*.js',route=>{attempts++;return attempts===1?route.abort('failed'):route.continue()})});
  await page.waitForSelector('#retryFormat');
  assert.equal(await page.locator('.plain-message').textContent(),'**重要文字**');
  await page.locator('#compose').fill('重新整理仍保留的草稿');
  await page.locator('#retryFormat').click();await page.waitForSelector('[data-message-id="retry-format"] strong',{timeout:5000});
  assert.equal(await page.locator('#compose').inputValue(),'重新整理仍保留的草稿');
  assert.equal(await page.locator('#formatNotice').isVisible(),false);assert.deepEqual(errors,[]);
});
