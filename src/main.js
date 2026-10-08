import './style.css';
import {SSEParser} from './sse.js';
import {marked} from 'marked';import DOMPurify from 'dompurify';import hljs from 'highlight.js';import katex from 'katex';import 'katex/dist/katex.min.css';import 'highlight.js/styles/github-dark.css';
const root=document.querySelector('#app');
const state={me:null,tab:'chat',providers:[],models:[],conversations:[],selected:null,detail:null,stats:null,settings:null,busy:new Set(),remoteRunning:new Set(),queues:new Map(),errors:new Map(),paused:new Set(),thinkingSelections:new Map(),thinkingExpanded:new Map(),editingMessage:null};
const isGenerating=cid=>state.busy.has(cid)||state.remoteRunning.has(cid);
let generationPoll=null,pollBusy=false;
const $=(s,scope=document)=>scope.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api=async(path,method='GET',body)=>{const r=await fetch('/api'+path,{method,headers:{'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});let j=await r.json().catch(()=>({error:r.statusText}));if(!r.ok)throw Error(j.error||String(r.status));return j};
const request=async(fn)=>{try{return await fn()}catch(e){alert(e.message);throw e}};
const fmt=v=>v==null?'未知':Number(v).toLocaleString('zh-TW');
function renderMarkdown(raw){
 let str=String(raw||'');
 const math=[];
 str=str.replace(/\$\$([\s\S]+?)\$\$|\$([^\n$]+?)\$/g,(match,block,inline)=>{const token='MATHPLACEHOLDER'+math.length+'END';try{math.push(katex.renderToString(block||inline,{displayMode:!!block,throwOnError:false,trust:false,strict:'ignore'}))}catch{math.push(esc(match))}return token});
 const html=marked.parse(str,{breaks:true,gfm:true});
 return DOMPurify.sanitize(html,{ADD_ATTR:['class']}).replace(/MATHPLACEHOLDER(\d+)END/g,(_,i)=>math[Number(i)]||'');
}
function shell(){root.innerHTML=`<header class="top"><div class="brand"><span class="spark">✳</span> AI Station <span class="brand-sub">PRIVATE WORKSPACE</span></div><nav><button data-tab="chat" class="${state.tab==='chat'?'on':''}">聊天工作區</button><button data-tab="admin" class="${state.tab==='admin'?'on':''}">管理中心</button></nav><button class="subtle" id="logout">登出 ↗</button></header><main id="main"></main>`;
 $$('[data-tab]').forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;render()});$('#logout').onclick=async()=>{await api('/logout','POST');clearInterval(generationPoll);generationPoll=null;state.me=null;state.remoteRunning.clear();login()};}
const $$=(s,scope=document)=>[...scope.querySelectorAll(s)];
function login(){root.innerHTML=`<div class="login-layout"><div class="login-intro"><div class="eyebrow">PRIVATE AI WORKSPACE</div><div class="spark hero-mark">✳</div><h1>讓每個想法，<br>都有個好去處。</h1><p>一個私人的 AI 對話與模型管理空間。<br>安全整理你的對話、模型與使用紀錄。</p><div class="dark-note">DESIGNED FOR FOCUSED THINKING　↗</div></div><form class="login-card" id="login"><span class="eyebrow">WELCOME BACK</span><h2>歡迎回來。</h2><p class="muted">登入以繼續你的工作。</p><label>管理員帳號<input name="username" autocomplete="username" required autofocus></label><label>管理員密碼<input name="password" type="password" autocomplete="current-password" required></label><p class="form-error" id="loginError"></p><button class="primary" type="submit">登入工作空間　↗</button><p class="small-muted">單一管理員 · 不開放公開註冊</p></form></div>`;
 $('#login').onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{await api('/login','POST',Object.fromEntries(f));await load();render()}catch(err){$('#loginError').textContent=err.message}}}
async function load(){
 state.me=await api('/me');
 await Promise.all([loadProviders(),loadModels(),loadConvos(),loadSettings()]);
 const running=await api('/generations');
 state.remoteRunning=new Set(running.active.map(x=>x.conversation_id));
 try{
   const cid=localStorage.getItem('ai-station-last-conversation');
   if(cid&&state.conversations.some(c=>c.id===cid)){state.selected=cid;state.detail=await api('/conversations/'+cid)}
 }catch{}
 if(!generationPoll)generationPoll=setInterval(()=>syncGenerations().catch(()=>{}),2500);
}
async function syncGenerations(){
 if(!state.me||pollBusy)return;
 pollBusy=true;
 try{
   const running=await api('/generations');
   const previous=state.remoteRunning;
   state.remoteRunning=new Set(running.active.map(x=>x.conversation_id));
   const finished=[...previous].filter(cid=>!state.remoteRunning.has(cid));
   for(const cid of finished){
     if(state.selected===cid){await refreshDetail(cid);await loadConvos();if(state.tab==='chat')renderQueue()}
     if(!state.busy.has(cid))drain(cid);
   }
   if(state.selected&&state.tab==='chat')renderQueue();
 }finally{pollBusy=false}
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)syncGenerations().catch(()=>{})});
const loadProviders=async()=>state.providers=await api('/providers');
const loadModels=async()=>state.models=await api('/models');
const loadConvos=async()=>state.conversations=await api('/conversations');
const loadSettings=async()=>state.settings=await api('/settings');
const usable=()=>state.models.filter(m=>m.enabled);
const modelOptions=(pid,mid)=>'<option value="">選擇模型...</option>'+usable().map(m=>`<option value="${esc(m.id)}" ${m.provider_id===pid&&m.model_id===mid?'selected':''}>${esc(m.provider_name)} / ${esc(m.model_id)}</option>`).join('');
// A selection belongs to the message when queued; future changes do not rewrite the queue.
const thinkingLevels = {
 openai: [['default','API 預設'],['none','關閉（none）'],['minimal','最低（minimal）'],['low','低'],['medium','中'],['high','高'],['xhigh','極高'],['max','最大']],
 claude: [['default','API 預設'],['low','低'],['medium','中'],['high','高'],['xhigh','極高'],['max','最大'],['budget','自訂 Token 預算']]
};
const getProtocol = c => state.models.find(m => m.provider_id === c.provider_id && m.model_id === c.model_id)?.protocol || 'openai';
const describeThinking = t => !t || t.mode === 'default' ? 'API 預設'
 : t.mode === 'budget' ? String(t.budget_tokens) + ' thinking tokens'
 : ({none:'關閉',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'極高',max:'最大'}[t.effort] || t.effort);
function thinkingControl(c) {
 const protocol=getProtocol(c),current=state.thinkingSelections.get(c.id)||{mode:'default'};
 const selected=current.mode==='budget'?'budget':current.mode==='effort'?current.effort:'default';
 const opts=thinkingLevels[protocol];
 return `<div class="thinking-control"><label for="thinkingSelect">思考額度</label><select id="thinkingSelect" title="每次傳送的思考等級；支援程度取決於供應商與模型">${opts.map(([value,text])=>`<option value="${value}" ${value===selected?'selected':''}>${text}</option>`).join('')}</select><input id="thinkingBudget" aria-label="自訂 thinking tokens" title="Claude 舊版 extended thinking；1024–32768 Token" type="number" min="1024" max="32768" step="1" value="${esc(current.budget_tokens??4096)}" ${selected==='budget'?'':'hidden'}></div>`;
}
function readThinkingUI() {
 const v=$('#thinkingSelect')?.value||'default';
 if(v==='default')return {mode:'default'};
 if(v==='budget')return {mode:'budget',budget_tokens:Number($('#thinkingBudget').value)};
 return {mode:'effort',effort:v};
}
function bindThinkingControl(cid){
 const select=$('#thinkingSelect'),budget=$('#thinkingBudget');
 if(!select)return;
 const change=()=>{budget.hidden=select.value!=='budget';state.thinkingSelections.set(cid,readThinkingUI())};
 select.onchange=change;
 budget.onchange=change;
}
function chatPage(){const c=state.detail,ready=!!c;$('#main').innerHTML=`<div class="workspace"><aside class="sidebar"><div class="side-head"><span class="eyebrow">YOUR CONVERSATIONS</span><button id="new" class="square">＋</button></div><div class="history">${state.conversations.map(x=>`<button class="history-item ${c?.id===x.id?'active':''}" data-convo="${x.id}"><span>◫</span> <span class="history-title">${esc(x.title)}</span></button>`).join('')||'<p class="muted empty-side">還沒有對話紀錄。</p>'}</div><div class="side-foot"><span>✳</span> 私人專屬的思考空間</div></aside><section class="chat-section">${ready?`<div class="chat-top"><div><div class="eyebrow">CONVERSATION</div><h2>${esc(c.title)}</h2></div><div class="chat-actions"><button id="rename" class="subtle">重新命名</button><button id="deleteChat" class="subtle danger">刪除</button></div></div><div class="conversation-settings"><label>使用模型<select id="modelSelect">${modelOptions(c.provider_id,c.model_id)}</select></label><label class="system-label">System Prompt<textarea id="systemPrompt" rows="2" placeholder="設定本次對話的系統指令">${esc(c.system_prompt)}</textarea></label><button class="secondary" id="saveSystem">儲存設定</button></div><div class="messages" id="messages"></div><div class="composer-wrap"><div id="queue" class="queue"></div><div class="composer"><textarea id="compose" rows="2" placeholder="輸入你的想法… Enter 傳送，Shift + Enter 換行"></textarea><div class="composer-foot"><div class="composer-tools">${thinkingControl(c)}<span class="composer-caption">MARKDOWN · LATEX · CODE</span></div><div><button id="stop" class="secondary" ${isGenerating(c.id)?'':'hidden'}>■ 停止</button><button id="send" class="primary">傳送 ↗</button></div></div></div><p class="hint">每次請求完整傳送對話上下文 · 不包含圖片或附件</p></div>`:`<div class="empty-chat"><span class="hero-mark spark">✳</span><div class="eyebrow">A SPACE FOR YOUR IDEAS</div><h1>今天，有什麼新想法？</h1><p>開啟一段對話，讓思路自由延伸。</p><button class="primary" id="startNew">建立新對話　↗</button></div>`}</section></div>`;
 $('#new').onclick=makeConvo;if($('#startNew'))$('#startNew').onclick=makeConvo;
 $$('[data-convo]').forEach(b=>b.onclick=()=>openConvo(b.dataset.convo));
 if(!ready)return;
 $('#rename').onclick=async()=>{const title=prompt('新的對話標題',c.title);if(title?.trim()){await patchConvo({title:title.trim()})}};
 $('#deleteChat').onclick=async()=>{if(confirm('確定永久刪除此對話？')){await api('/conversations/'+c.id,'DELETE');state.selected=null;state.detail=null;try{localStorage.removeItem('ai-station-last-conversation')}catch{}await loadConvos();render()}};
 $('#modelSelect').onchange=async e=>{const m=state.models.find(x=>x.id===e.target.value);if(m){state.thinkingSelections.delete(c.id);await patchConvo({provider_id:m.provider_id,model_id:m.model_id})}};
 $('#saveSystem').onclick=async()=>{await patchConvo({system_prompt:$('#systemPrompt').value});alert('已儲存')};
 bindThinkingControl(c.id);
 $('#send').onclick=queueMessage;
 $('#compose').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();queueMessage()}};
 $('#stop').onclick=()=>api('/conversations/'+c.id+'/stop','POST').catch(e=>alert(e.message));
 renderMessages();renderQueue();
}
function renderMessages(){const el=$('#messages');if(!el||!state.detail)return;const c=state.detail;el.innerHTML=(c.messages||[]).map(m=>{const req=c.requests?.find(x=>x.assistant_message_id===m.id);return `<article class="message ${m.role}"><div class="avatar">${m.role==='user'?'你':'✳'}</div><div class="message-body"><div class="message-name">${m.role==='user'?'YOU':'AI STATION'} ${m.status==='running'?'<span class="working">正在生成…</span>':''}</div>${m.role==='assistant'&&m.thinking_content?`<details class="thinking-panel" data-thinking-id="${esc(m.id)}" ${(state.thinkingExpanded.get(m.id)??(m.status==='running'))?'open':''}><summary><span>✳ 模型提供的思考內容／摘要</span><span class="thinking-chevron">⌄</span></summary><div class="thinking-body">${renderMarkdown(m.thinking_content)}</div></details>`:''}<div class="prose">${renderMarkdown(m.content)}</div>${req?.status==='error'?`<details class="error-detail"><summary>錯誤 ${esc(req.http_status??'未知')} · ${esc(req.provider_error_code||'unknown')} — 展開詳情</summary><div>請求時間：${esc(req.started_at)}</div><pre>${esc(req.error_body)}</pre></details>`:''}${req&&req.status!=='running'?`<div class="usage">思考額度：${esc(describeThinking({mode:req.thinking_mode,effort:req.thinking_effort,budget_tokens:req.thinking_budget_tokens}))} · 輸入 ${fmt(req.input_tokens)} · 輸出 ${fmt(req.output_tokens)} · 快取讀取 ${fmt(req.cache_read_tokens)} · 推理 ${fmt(req.reasoning_tokens)} · ${esc(req.status)}</div>`:''}</div></article>`}).join('')||'<div class="messages-empty">把腦中的疑問與靈感，放在這裡。</div>';$$('pre code',el).forEach(code=>{hljs.highlightElement(code);const b=document.createElement('button');b.className='copy';b.textContent='複製';b.onclick=()=>navigator.clipboard.writeText(code.textContent);code.parentNode.prepend(b)});$$('.thinking-panel',el).forEach(panel=>panel.addEventListener('toggle',()=>state.thinkingExpanded.set(panel.dataset.thinkingId,panel.open)));bindMessageActions(el,c);el.scrollTop=el.scrollHeight;}
function bindMessageActions(container, conversation){
 [...container.querySelectorAll('.message')].forEach((node,index)=>{
   const m=conversation.messages[index];
   if(!m)return;
   // After a browser returns to a running job, do not reveal an incomplete
   // persisted checkpoint. Live SSE updates still display to the original tab.
   if(m.status==='running'&&!m.live){
     const body=node.querySelector('.prose');
     if(body)body.textContent='背景生成中，完成後會自動顯示完整回覆。';
     const thinking=node.querySelector('.thinking-panel');
     if(thinking)thinking.hidden=true;
   }
   if(isGenerating(conversation.id)||m.status==='running')return;
   const tools=document.createElement('div');
   tools.className='message-actions';
   const add=(label,action,extra='')=>{
     const b=document.createElement('button');
     b.type='button';b.textContent=label;b.className='subtle message-action '+extra;
     b.onclick=action;tools.append(b);return b;
   };
   const msgPath='/conversations/'+conversation.id+'/messages/'+m.id;
   add('編輯',()=>{
     state.editingMessage=state.editingMessage===m.id?null:m.id;
     renderMessages();
     container.querySelector('[data-editing-message] textarea')?.focus();
   });
   add('刪除',async()=>{
     if(!confirm('確定刪除這則訊息？後續 API 將不再收到此段上下文。過去的 Token 統計會保留。'))return;
     try{
       await api(msgPath,'DELETE');
       state.editingMessage=null;
       await refreshDetail(conversation.id);
       await loadConvos();
     }catch(e){alert(e.message)}
   },'danger');
   if(m.role==='user')add('回退至此',async()=>{
     if(!confirm('確定回退？此則使用者訊息與其後所有訊息將刪除，並放回輸入框重新編輯。尚未送出的排隊訊息也會清空。'))return;
     try{
       const result=await api('/conversations/'+conversation.id+'/rewind','POST',{message_id:m.id});
       state.queues.set(conversation.id,[]);
       state.paused.delete(conversation.id);
       state.editingMessage=null;
       await refreshDetail(conversation.id);
       renderQueue();
       const input=$('#compose');
       if(input){input.value=result.rewound_text;input.focus()}
       await loadConvos();
     }catch(e){alert(e.message)}
   });
   node.querySelector('.message-name')?.after(tools);
   if(state.editingMessage!==m.id)return;
   const editor=document.createElement('div');
   editor.className='message-editor';editor.dataset.editingMessage=m.id;
   const area=document.createElement('textarea');
   area.value=m.content;area.rows=5;area.maxLength=100000;
   editor.append(area);
   const buttons=document.createElement('div');buttons.className='actions';
   const save=document.createElement('button');save.className='primary';save.textContent='儲存修改';
   save.onclick=async()=>{
     if(!area.value.trim()){alert('訊息不得為空白');return}
     save.disabled=true;
     try{
       await api(msgPath,'PATCH',{content:area.value});
       state.editingMessage=null;
       await refreshDetail(conversation.id);
       await loadConvos();
     }catch(e){alert(e.message);save.disabled=false}
   };
   const cancel=document.createElement('button');cancel.className='secondary';cancel.textContent='取消';
   cancel.onclick=()=>{state.editingMessage=null;renderMessages()};
   buttons.append(save,cancel);editor.append(buttons);
   node.querySelector('.prose')?.before(editor);
   const original=node.querySelector('.prose');
   if(original)original.hidden=true;
 });
}
let messageRenderScheduled=false;
function scheduleMessageRender(){
 if(messageRenderScheduled)return;
 messageRenderScheduled=true;
 requestAnimationFrame(()=>{messageRenderScheduled=false;renderMessages()});
}
async function openConvo(cid){state.selected=cid;state.editingMessage=null;state.detail=await api('/conversations/'+cid);try{localStorage.setItem('ai-station-last-conversation',cid)}catch{}render();}
async function makeConvo(){const m=usable()[0];const c=await api('/conversations','POST',{provider_id:m?.provider_id||null,model_id:m?.model_id||null});await loadConvos();await openConvo(c.id)}
async function patchConvo(patch){state.detail=await api('/conversations/'+state.selected,'PATCH',patch).then(async()=>api('/conversations/'+state.selected));await loadConvos();render()}
function renderQueue(){const q=state.queues.get(state.selected)||[];const el=$('#queue');if(!el)return;el.innerHTML=(state.paused.has(state.selected)?'<div class="queued"><span>佇列已因 API 錯誤暫停</span><button id="resumeQueue" class="secondary">繼續傳送</button></div>':'')+q.map((item,i)=>`<div class="queued"><span>預約 ${i+1} · 思考：${esc(describeThinking(item.thinking))} · ${esc(item.content.slice(0,100))}</span><button data-cancel="${item.id}" class="subtle">取消</button></div>`).join('');$$('[data-cancel]',el).forEach(b=>b.onclick=()=>{state.queues.set(state.selected,(state.queues.get(state.selected)||[]).filter(x=>x.id!==b.dataset.cancel));renderQueue()});if($('#resumeQueue'))$('#resumeQueue').onclick=()=>{const cid=state.selected;state.paused.delete(cid);renderQueue();drain(cid)};const stop=$('#stop');if(stop)stop.hidden=!isGenerating(state.selected);}
function queueMessage(){const c=state.detail;if(!c)return;const input=$('#compose'),content=input.value.trim();if(!content)return;if(!c.model_id){alert('請先設定模型');return}const thinking=readThinkingUI();if(thinking.mode==='budget'&&(!Number.isSafeInteger(thinking.budget_tokens)||thinking.budget_tokens<1024||thinking.budget_tokens>32768)){alert('Claude 思考 Token 必須是 1,024 至 32,768 的整數');return}input.value='';const q=state.queues.get(c.id)||[];q.push({id:Date.now().toString(36)+'-'+Math.random().toString(36).slice(2),content,thinking});state.queues.set(c.id,q);renderQueue();drain(c.id);}
async function drain(cid){if(isGenerating(cid)||state.paused.has(cid))return;const q=state.queues.get(cid)||[];if(!q.length)return;state.busy.add(cid);if(state.selected===cid)renderQueue();const item=q.shift();if(state.selected===cid)renderQueue();let terminal=false,failed=false,detached=false;
 try{
 const r=await fetch('/api/conversations/'+cid+'/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:item.content,thinking:item.thinking})});
 if(!r.ok){let j=await r.json();throw Error(j.error||r.statusText)}
 if(!r.body)throw Error('伺服器未提供 SSE 串流');
 const reader=r.body.getReader();
 let assistantId=null;
 const parser=new SSEParser(({event,data:raw})=>{
   let data;try{data=JSON.parse(raw)}catch{return}
   if(['complete','stopped','error'].includes(event)){
     terminal=true;failed=event==='error';
     if(failed)state.errors.set(cid,data.error);
   }
   if(state.selected!==cid||!state.detail)return;
   if(event==='started'){
     assistantId=data.assistant_id;
     state.detail.messages.push({id:data.user_id,role:'user',content:item.content,thinking_content:'',status:'complete'});
     state.detail.messages.push({id:assistantId,role:'assistant',content:'',thinking_content:'',status:'running',live:true});
     renderMessages();
   }else if(event==='delta'||event==='thinking_delta'){
     const m=state.detail.messages.find(x=>x.id===assistantId);
     if(m){
       if(event==='delta')m.content+=data.text||'';
       else m.thinking_content+=data.text||'';
       scheduleMessageRender();
     }
   }
 });
 while(true){
   const {done,value}=await reader.read();
   if(done)break;
   parser.feed(value);
 }
 parser.end();
 if(!terminal)throw Error('串流中斷，可能仍在伺服器背景生成');
 }catch(e){
   if(String(e.message).includes('串流中斷，可能仍在伺服器背景生成')){
     detached=true;state.remoteRunning.add(cid);
   }else{failed=true;state.errors.set(cid,e.message);if(state.selected===cid)alert('請求失敗，佇列已暫停：'+e.message)}
 }finally{
   state.busy.delete(cid);
   if(terminal)state.remoteRunning.delete(cid);
   if(failed)state.paused.add(cid);
   if(state.selected===cid){await refreshDetail(cid).catch(()=>{});renderQueue()}
   if(detached)syncGenerations().catch(()=>{});
   else if(!failed)drain(cid);
 }
}
async function refreshDetail(cid){if(state.selected!==cid)return;state.detail=await api('/conversations/'+cid);renderMessages();}
function adminPage(){const s=state.stats||{requests:{count:0},usage:{},recent:[]};$('#main').innerHTML=`<div class="admin"><div class="admin-header"><div><div class="eyebrow">SETTINGS & INSIGHTS</div><h1>管理中心.</h1><p class="section-note">模型設定、供應商與實際 API 用量。</p></div><button class="secondary" id="exportChats">匯出對話 JSON</button></div><div class="admin-grid">${[['TOTAL REQUESTS',s.requests.count],['INPUT TOKENS',s.usage.input_tokens],['OUTPUT TOKENS',s.usage.output_tokens]].map(([k,v])=>`<div class="metric"><span class="eyebrow">${k}</span><strong>${fmt(v)}</strong></div>`).join('')}</div><section class="panel"><h2>API Endpoints</h2><p class="section-note">完整 URL：OpenAI 使用 /chat/completions；Claude 使用 /messages。</p><form id="providerForm" class="form-grid"><input type="hidden" name="id"><label>名稱<input name="name" required></label><label>協定<select name="protocol"><option value="openai">OpenAI 相容</option><option value="claude">Claude 相容</option></select></label><label class="wide">完整 Endpoint<input type="url" name="endpoint" required></label><label class="wide">API Key（留空保留舊金鑰）<input type="password" autocomplete="off" name="api_key"></label><div class="wide actions"><button class="primary">儲存 Endpoint</button><button type="reset" class="secondary">清除</button></div></form><table class="data-table"><thead><tr><th>名稱</th><th>路徑</th><th>操作</th></tr></thead><tbody>${state.providers.map(p=>`<tr><td>${esc(p.name)}<div class="muted">${esc(p.protocol)} · Key 已遮蔽</div></td><td class="truncate">${esc(p.endpoint)}</td><td class="actions"><button class="secondary" data-ptest="${p.id}">測試</button><button class="secondary" data-pscan="${p.id}">偵測</button><button class="subtle" data-pedit="${p.id}">編輯</button><button class="subtle danger" data-pdel="${p.id}">刪除</button></td></tr>`).join('')}</tbody></table></section><section class="panel"><h2>模型列表</h2><form id="modelForm" class="form-grid"><label>Endpoint<select name="provider_id">${state.providers.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label><label>Model ID<input name="model_id" required></label><div class="wide"><button class="primary">手動新增模型</button></div></form><table class="data-table"><thead><tr><th>Endpoint</th><th>Model ID</th><th>來源</th><th>操作</th></tr></thead><tbody>${state.models.map(m=>`<tr><td>${esc(m.provider_name)}</td><td>${esc(m.model_id)}</td><td>${esc(m.source)}</td><td><button data-mtoggle="${m.id}" class="secondary">${m.enabled?'停用':'啟用'}</button><button data-mdel="${m.id}" class="subtle danger">刪除</button></td></tr>`).join('')}</tbody></table></section><section class="panel panel-dark"><h2>預設 System Prompt</h2><textarea id="defaultSystem" rows="3">${esc(state.settings?.default_system_prompt)}</textarea><div class="actions" style="margin-top:16px"><button class="primary" id="saveDefault">儲存預設</button><button class="secondary" id="exportSettings">匯出設定（不含 Key）</button></div></section><section class="panel"><h2>用量與錯誤紀錄</h2><div class="admin-grid">${[['快取讀取',s.usage.cache_read_tokens],['快取建立',s.usage.cache_creation_tokens],['推理 Token',s.usage.reasoning_tokens]].map(([k,v])=>`<div class="metric"><span class="eyebrow">${k}</span><strong>${fmt(v)}</strong></div>`).join('')}</div><table class="data-table"><tr><th>時間</th><th>供應商 / 模型</th><th>狀態</th><th>輸入</th><th>輸出</th><th>錯誤</th></tr>${s.recent.map(r=>`<tr><td>${esc(r.started_at)}</td><td>${esc(r.provider_name)} / ${esc(r.model_id)}</td><td>${esc(r.status)}</td><td>${fmt(r.input_tokens)}</td><td>${fmt(r.output_tokens)}</td><td>${r.error_body?`<details><summary>查看</summary><pre>${esc(r.http_status)} · ${esc(r.provider_error_code)}\n${esc(r.error_body)}</pre></details>`:'—'}</td></tr>`).join('')}</table></section></div>`;
 $('#providerForm').onsubmit=async e=>{e.preventDefault();const f=Object.fromEntries(new FormData(e.target));try{await api(f.id?'/providers/'+f.id:'/providers',f.id?'PATCH':'POST',f);await loadProviders();await loadModels();await adminRefresh()}catch(err){alert(err.message)}};
 $$('[data-pedit]').forEach(b=>b.onclick=()=>{const p=state.providers.find(x=>x.id===b.dataset.pedit),f=$('#providerForm').elements;for(const k of ['id','name','protocol','endpoint'])f[k].value=p[k];f.api_key.value='';f.name.focus()});
 $$('[data-ptest]').forEach(b=>b.onclick=async()=>{try{const r=await api('/providers/'+b.dataset.ptest+'/test','POST');alert('連線成功 · '+r.models_found+' 個模型')}catch(e){alert(e.message)}});
 $$('[data-pscan]').forEach(b=>b.onclick=async()=>{try{const r=await api('/providers/'+b.dataset.pscan+'/scan','POST');await loadModels();await adminRefresh();alert('已偵測 '+r.count+' 個模型')}catch(e){alert(e.message)}});
 $$('[data-pdel]').forEach(b=>b.onclick=async()=>{if(confirm('確定刪除此 Endpoint 與其模型？')){await api('/providers/'+b.dataset.pdel,'DELETE');await loadProviders();await loadModels();await adminRefresh()}});
 $('#modelForm').onsubmit=async e=>{e.preventDefault();try{await api('/models','POST',Object.fromEntries(new FormData(e.target)));await loadModels();await adminRefresh()}catch(e){alert(e.message)}};
 $$('[data-mtoggle]').forEach(b=>b.onclick=async()=>{const m=state.models.find(x=>x.id===b.dataset.mtoggle);await api('/models/'+m.id,'PATCH',{enabled:!m.enabled});await loadModels();adminPage()});
 $$('[data-mdel]').forEach(b=>b.onclick=async()=>{if(confirm('刪除模型？')){await api('/models/'+b.dataset.mdel,'DELETE');await loadModels();adminPage()}});
 $('#saveDefault').onclick=async()=>{await api('/settings','PATCH',{default_system_prompt:$('#defaultSystem').value});alert('已儲存')};
 $('#exportChats').onclick=()=>location.href='/api/export?type=chats';$('#exportSettings').onclick=()=>location.href='/api/export?type=settings';
}
async function adminRefresh(){state.stats=await api('/stats');render()}
function render(){shell();if(state.tab==='chat')chatPage();else {adminPage();adminRefreshOnce()}}
async function adminRefreshOnce(){if(!state.stats){state.stats=await api('/stats');adminPage()}}
(async()=>{try{await load();render()}catch{login()}})();
