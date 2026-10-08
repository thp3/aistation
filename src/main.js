import './style.css';
import {DraftStore,LatestRequest} from './chat-state.js';
import {createApi} from './api.js';
import {notify,confirmAction,inputDialog,formError,validateForm,dismissDialogs} from './feedback.js';
const root=document.querySelector('#app');
const drafts=new DraftStore(),detailRequests=new LatestRequest(),submissions=new Map();
const messagePositions=new Map();
let renderedContainer=null,messageNodes=new Map();
const state={me:null,tab:'chat',providers:[],models:[],conversations:[],selected:null,detail:null,stats:null,settings:null,busy:new Set(),remoteRunning:new Set(),queues:new Map(),errors:new Map(),paused:new Set(),thinkingSelections:new Map(),thinkingExpanded:new Map(),editingMessage:null,liveJobs:new Map(),liveAssistantIds:new Map()};
const isGenerating=cid=>state.busy.has(cid)||state.remoteRunning.has(cid)||(state.selected===cid&&!!state.detail?.queue?.jobs?.length);
let generationPoll=null,pollBusy=false;
const $=(s,scope=document)=>scope.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api=createApi(()=>{if(state.me)expireSession()});
const actions=new Map(),systemDrafts=new Map(),formDrafts=new Map();
const finishedJobs=new Map();
let statusFeed=null,statusConnected=false,statusRetry=null,adminLoading=null,listCursor=null,listQuery='',listSequence=0,statsAt=0,statsRevision=0;
function expireSession(){
 captureView();state.me=null;state.stats=null;adminLoading=null;statsLoading=null;state.adminLoaded=false;state.providers=[];formDrafts.clear();actions.clear();submissions.clear();
 state.liveJobs.clear();state.liveAssistantIds.clear();finishedJobs.clear();
 detailRequests.cancel();liveFeed?.close();liveConversationId=null;closeStatusFeed();dismissDialogs();updateGenerationPolling();login('登入已過期，請重新登入；聊天草稿已保留。');
}
async function runAction(key,button,fn,{form,success}={}){
 if(actions.has(key))return;
 if(form&&!validateForm(form))return;
 const session=state.me,token=Symbol(key);
 actions.set(key,token);markActionButton(button,key);
 if(form)formError(form,'');
 try{const result=await fn();if(state.me===session&&success)notify(success);return result}
 catch(e){if(state.me===session){if(form?.isConnected)formError(form,e.message);else notify(e.message,{kind:'error'})}}
 finally{if(actions.get(key)===token){actions.delete(key);for(const b of $$('[data-action-key]'))if(b.dataset.actionKey===key){b.disabled=false;if(b.dataset.actionLabel!==undefined)b.textContent=b.dataset.actionLabel;delete b.dataset.actionLabel}}}
}
function markActionButton(button,key){if(!button)return;button.dataset.actionKey=key;if(actions.has(key)){button.disabled=true;if(button.tagName==='BUTTON'){button.dataset.actionLabel??=button.textContent;button.textContent='處理中…'}}}
function saveFormDrafts(){
 for(const id of ['providerForm','modelForm']){const form=$('#'+id);if(form)formDrafts.set(id,Object.fromEntries(new FormData(form)))}
 for(const id of ['defaultSystem','namingModelSelect']){const input=$('#'+id);if(input)formDrafts.set(id,input.value)}
}
function restoreFormDrafts(){
 for(const form of $$('form'))form.noValidate=true;
 for(const id of ['providerForm','modelForm']){const form=$('#'+id),draft=formDrafts.get(id);if(form&&draft)for(const [key,value] of Object.entries(draft)){if(form.elements[key])form.elements[key].value=value}}
 for(const id of ['defaultSystem','namingModelSelect']){const input=$('#'+id);if(input&&formDrafts.has(id))input.value=formDrafts.get(id)}
}
function updateConnection(){
 const el=$('#connectionState');if(!el)return;
 el.textContent=!navigator.onLine?'離線':statusConnected?'已連線':'重新連線中';el.dataset.connected=String(statusConnected&&navigator.onLine);
}
function closeStatusFeed(){statusFeed?.close();statusFeed=null;statusConnected=false;clearTimeout(statusRetry);statusRetry=null}
function connectStatusFeed(){
 if(!state.me||document.hidden||statusFeed)return;
 const session=state.me,feed=new EventSource('/api/events');statusFeed=feed;
 feed.addEventListener('open',()=>{if(statusFeed!==feed||state.me!==session)return;statusConnected=true;updateConnection();updateGenerationPolling()});
 feed.addEventListener('status',e=>{
  if(statusFeed!==feed||state.me!==session)return;
  statusConnected=true;updateConnection();updateGenerationPolling();
  let data;try{data=JSON.parse(e.data)}catch{return}
  if(['started','complete','error','stopped','title'].includes(data.changed)){statsRevision++;statsAt=0;if(state.tab==='admin')void adminRefreshOnce()}
  state.remoteRunning=new Set((data.active||[]).map(j=>j.conversation_id));
  if(data.conversation)updateConversation(data.conversation);
  if(data.conversation_id===state.selected&&data.queue&&state.detail){state.detail.queue=data.queue;renderQueue();renderMessages()}
  if(['complete','error','stopped'].includes(data.changed)&&data.request_id&&data.conversation_id===state.selected&&state.tab==='chat'){
   // The global stream may stay connected while the selected conversation stream reconnects.
   const cid=data.conversation_id;
   setTimeout(()=>{if(state.me===session&&state.selected===cid&&state.tab==='chat'&&finishedJobs.get(cid)!==data.request_id)refreshDetail(cid).then(()=>finishedJobs.set(cid,data.request_id)).catch(e=>notify(e.message,{kind:'error'}))},150);
  }
  renderSidebar();
 });
 feed.addEventListener('error',()=>{
  if(statusFeed!==feed||state.me!==session)return;
  statusConnected=false;updateConnection();updateGenerationPolling();
  // Probe authentication once per disconnect; EventSource itself owns reconnection.
  if(!statusRetry)statusRetry=setTimeout(()=>{statusRetry=null;api('/me','GET',undefined,{retry:0}).catch(()=>{})},2000);
 });
}
window.addEventListener('offline',()=>{statusConnected=false;updateConnection();updateGenerationPolling()});
window.addEventListener('online',()=>{updateConnection();connectStatusFeed();syncGenerations().catch(()=>{})});
const fmt=v=>v==null?'未知':Number(v).toLocaleString('zh-TW');
let markdownRenderer=null,markdownLoading=null,markdownFailed=false,formatVersion=0;
function updateFormatNotice(){
 const notice=$('#formatNotice');
 if(!notice)return;
 notice.hidden=!markdownFailed;
 notice.innerHTML=markdownFailed?'訊息已載入，格式暫時無法載入。 <button class="subtle" id="retryFormat">重新整理</button>':'';
 if(markdownFailed)$('#retryFormat').onclick=()=>{captureView();location.reload()};
}
function refreshFormatting(){formatVersion++;renderMessages()}
function loadMarkdown(){
 if(markdownLoading||markdownFailed)return;
 markdownLoading=import('./markdown.js').then(module=>{
   markdownRenderer=module.createMarkdownRenderer(refreshFormatting,()=>{markdownFailed=true;updateFormatNotice()});
   refreshFormatting();
 }).catch(()=>{markdownFailed=true;formatVersion++;renderMessages()});
}
function renderMarkdown(raw){
 const text=String(raw||'');
 if(!text)return '';
 if(markdownRenderer)return markdownRenderer.render(text);
 loadMarkdown();
 return '<div class="plain-message">'+esc(text)+'</div>';
}
function updateGenerationPolling(){
 clearInterval(generationPoll);generationPoll=null;
 if(state.me&&!document.hidden&&!statusConnected)generationPoll=setInterval(()=>syncGenerations().catch(()=>{}),10000);
}
function shell(){root.innerHTML=`<header class="top"><div class="brand"><span class="spark">✳</span> AI Station <span class="brand-sub">PRIVATE WORKSPACE</span></div><nav><button data-tab="chat" class="${state.tab==='chat'?'on':''}"><span class="desktop-label">聊天工作區</span><span class="mobile-label">聊天</span></button><button data-tab="admin" class="${state.tab==='admin'?'on':''}"><span class="desktop-label">管理中心</span><span class="mobile-label">管理</span></button></nav><span id="connectionState" class="connection-state" role="status"></span><button class="subtle" id="logout">登出 ↗</button></header><main id="main"></main>`;
 $$('[data-tab]').forEach(b=>b.onclick=()=>{state.tab=b.dataset.tab;render()});
 $('#logout').onclick=()=>runAction('logout',$('#logout'),async()=>{
   captureView();const session=state.me;await api('/logout','POST');if(state.me!==session)return;captureView();detailRequests.cancel();
   clearInterval(generationPoll);generationPoll=null;liveFeed?.close();liveConversationId=null;closeStatusFeed();dismissDialogs();
   state.me=null;state.selected=null;state.detail=null;state.stats=null;statsLoading=null;state.adminLoaded=false;adminLoading=null;formDrafts.clear();actions.clear();submissions.clear();state.providers=[];state.remoteRunning.clear();
   state.liveJobs.clear();state.liveAssistantIds.clear();finishedJobs.clear();login();
 });updateConnection();
}
const $$=(s,scope=document)=>[...scope.querySelectorAll(s)];
function login(message=''){root.innerHTML=`<div class="login-layout"><div class="login-intro"><div class="eyebrow">PRIVATE AI WORKSPACE</div><div class="spark hero-mark">✳</div><h1>讓每個想法，<br>都有個好去處。</h1><p>一個私人的 AI 對話與模型管理空間。<br>安全整理你的對話、模型與使用紀錄。</p><div class="dark-note">DESIGNED FOR FOCUSED THINKING　↗</div></div><form class="login-card" id="login"><span class="eyebrow">WELCOME BACK</span><h2>歡迎回來。</h2><p class="muted">登入以繼續你的工作。</p><label>管理員帳號<input name="username" autocomplete="username" required autofocus></label><label>管理員密碼<input name="password" type="password" autocomplete="current-password" required></label><p class="form-error" id="loginError" role="alert">${esc(message)}</p><button class="primary" type="submit">登入工作空間　↗</button><p class="small-muted">單一管理員 · 不開放公開註冊</p></form></div>`;
 $('#login').noValidate=true;
 $('#login').onsubmit=e=>{e.preventDefault();const form=e.target,payload=Object.fromEntries(new FormData(form));return runAction('login',form.querySelector('button'),async()=>{await api('/login','POST',payload);await load();render()},{form})};
}
async function load(){
 let last='';try{last=localStorage.getItem('ai-station-last-conversation')||''}catch{}
 const data=await api('/bootstrap'+(last?'?conversation='+encodeURIComponent(last):''));
 closeStatusFeed();state.me=data.me;state.models=data.models;state.settings=data.settings;state.conversations=data.conversations.items;listCursor=data.conversations.next_cursor;listQuery='';
 state.remoteRunning=new Set(data.active.map(x=>x.conversation_id));state.detail=data.detail;state.selected=data.detail?.id||null;state.adminLoaded=false;
 if(data.detail&&!state.conversations.some(c=>c.id===data.detail.id))state.conversations.unshift(data.detail);
 connectStatusFeed();updateGenerationPolling();
}
async function syncGenerations(){
 if(!state.me||document.hidden||pollBusy)return;
 const session=state.me;
 pollBusy=true;
 try{
   const running=await api('/generations');
   if(state.me!==session)return;
   const previous=state.remoteRunning;
   state.remoteRunning=new Set(running.active.map(x=>x.conversation_id));
   const finished=[...previous].filter(cid=>!state.remoteRunning.has(cid));
   for(const cid of finished){
     if(state.selected===cid){await refreshDetail(cid);await loadConvos();if(state.tab==='chat')renderQueue()}
     // The server owns FIFO; do not resend from this browser.
   }
   if(state.selected&&state.tab==='chat')renderQueue();
 }finally{pollBusy=false}
}
document.addEventListener('visibilitychange',()=>{
 if(document.hidden){closeStatusFeed();liveFeed?.close();liveConversationId=null}
 else{connectStatusFeed();if(state.me&&state.detail&&state.tab==='chat')subscribeConversation(state.selected,state.detail.event_cursor)}
 updateGenerationPolling();if(!document.hidden&&!statusConnected)syncGenerations().catch(()=>{});
});
const loadProviders=async()=>{const session=state.me,data=await api('/providers');if(state.me===session)state.providers=data};
const loadModels=async()=>{const session=state.me,data=await api('/models');if(state.me===session)state.models=data};
async function loadConvos({append=false}={}){
 const sequence=++listSequence,session=state.me;
 const params=new URLSearchParams({limit:'50',...(listQuery?{q:listQuery}:{}),...(append&&listCursor?{cursor:listCursor}:{})});
 try{
  const data=await api('/conversations?'+params);
  if(sequence!==listSequence||state.me!==session)return;
  state.conversations=append?[...state.conversations,...data.items.filter(c=>!state.conversations.some(x=>x.id===c.id))]:data.items;listCursor=data.next_cursor;renderSidebar();
 }finally{if(sequence===listSequence){const button=$('#moreConversations');if(button)button.disabled=false}}
}
function updateConversation(c){
 c=Object.fromEntries(['id','title','provider_id','model_id','created_at','updated_at'].filter(k=>Object.hasOwn(c,k)).map(k=>[k,c[k]]));
 const index=state.conversations.findIndex(x=>x.id===c.id);
 if(index>=0)state.conversations[index]={...state.conversations[index],...c};
 else if(!listQuery)state.conversations.unshift(c);
 state.conversations.sort((a,b)=>String(b.updated_at||'').localeCompare(String(a.updated_at||''))||b.id.localeCompare(a.id));renderSidebar();
}
function renderSidebar(){
 const el=$('.history');if(!el)return;
 el.innerHTML=state.conversations.map(x=>`<button class="history-item ${state.selected===x.id?'active':''}" data-convo="${esc(x.id)}"><span>${state.remoteRunning.has(x.id)?'◌':'◫'}</span><span class="history-title">${esc(x.title)}</span></button>`).join('')||'<p class="muted empty-side">'+(listQuery?'找不到符合的對話':'還沒有對話紀錄。')+'</p>';
 if(listCursor)el.insertAdjacentHTML('beforeend','<button class="secondary" id="moreConversations">載入更多對話</button>');
 $$('[data-convo]',el).forEach(b=>b.onclick=()=>openConvo(b.dataset.convo));
 if($('#moreConversations'))$('#moreConversations').onclick=()=>runAction('more-conversations',$('#moreConversations'),()=>loadConvos({append:true}));
}
const usable=()=>state.models.filter(m=>m.enabled);
let modelQuery='';
const modelOptions=(pid,mid)=>'<option value="">選擇模型...</option>'+usable().filter(m=>m.provider_id===pid&&m.model_id===mid||!modelQuery||(m.provider_name+' '+m.model_id).toLowerCase().includes(modelQuery.toLowerCase())).map(m=>`<option value="${esc(m.id)}" ${m.provider_id===pid&&m.model_id===mid?'selected':''}>${esc(m.provider_name)} / ${esc(m.model_id)}</option>`).join('');
// A selection belongs to the message when queued; future changes do not rewrite the queue.
const thinkingLevels = {
 openai: [['default','API 預設'],['none','關閉（none）'],['minimal','最低（minimal）'],['low','低'],['medium','中'],['high','高'],['xhigh','極高'],['max','最大']],
 claude: [['default','API 預設'],['low','低'],['medium','中'],['high','高'],['xhigh','極高'],['max','最大'],['budget','自訂 Token 預算']],
 gemini: [['default','API 預設'],['minimal','最低（minimal）'],['low','低'],['medium','中'],['high','高']]
};
const getProtocol = c => state.models.find(m => m.provider_id === c.provider_id && m.model_id === c.model_id)?.protocol || 'openai';
const describeThinking = t => !t || t.mode === 'default' ? 'API 預設'
 : t.mode === 'budget' ? String(t.budget_tokens) + ' thinking tokens'
 : ({none:'關閉',minimal:'最低',low:'低',medium:'中',high:'高',xhigh:'極高',max:'最大'}[t.effort] || t.effort);
function thinkingControl(c) {
 const protocol=getProtocol(c),current=state.thinkingSelections.get(c.id)||{mode:'default'};
 const selected=current.mode==='budget'?'budget':current.mode==='effort'?current.effort:'default';
 const legacyGemini=protocol==='gemini'&&/^gemini-2\.5(?:[-.]|$)/.test(String(c.model_id).replace(/^models\//,''));
 const opts=[...thinkingLevels[protocol]];
 if(legacyGemini){
   if(!c.model_id.includes('pro'))opts.splice(1,0,['none','關閉（0 Token）']);
   opts.push(['budget','自訂 Token 預算']);
 }
 const min=protocol==='gemini'?0:1024,max=legacyGemini&&c.model_id.includes('flash')?24576:32768;
 return `<div class="thinking-control"><label for="thinkingSelect">思考額度</label><select id="thinkingSelect" title="每次傳送的思考等級；支援程度取決於供應商與模型">${opts.map(([value,text])=>`<option value="${value}" ${value===selected?'selected':''}>${text}</option>`).join('')}</select><input id="thinkingBudget" aria-label="自訂 thinking tokens" title="思考 Token 範圍依模型而定" type="number" min="${min}" max="${max}" step="1" value="${esc(current.budget_tokens??4096)}" ${selected==='budget'?'':'hidden'}></div>`;
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
function chatPage(){const c=state.detail,ready=!!c;$('#main').innerHTML=`<div class="workspace"><aside class="sidebar"><div class="side-head"><span class="eyebrow">YOUR CONVERSATIONS</span><button id="new" class="square" aria-label="新增對話" title="新增對話">＋</button></div><input id="conversationSearch" class="conversation-search" aria-label="搜尋對話" placeholder="搜尋對話" value="${esc(listQuery)}"><div class="history">${state.conversations.map(x=>`<button class="history-item ${state.selected===x.id?'active':''}" data-convo="${x.id}"><span>◫</span> <span class="history-title">${esc(x.title)}</span></button>`).join('')||'<p class="muted empty-side">還沒有對話紀錄。</p>'}</div><div class="side-foot"><span>✳</span> 私人專屬的思考空間</div></aside><section class="chat-section">${ready?`<div class="chat-top"><div><div class="eyebrow">CONVERSATION</div><h2>${esc(c.title)}</h2></div><div class="chat-actions"><button id="rename" class="subtle">重新命名</button><button id="deleteChat" class="subtle danger">刪除</button></div></div><div class="conversation-settings"><label>使用模型<input id="modelSearch" type="search" aria-label="搜尋模型" placeholder="搜尋模型" value="${esc(modelQuery)}"><select id="modelSelect">${modelOptions(c.provider_id,c.model_id)}</select></label><label class="system-label">System Prompt<textarea data-conversation-id="${esc(c.id)}" id="systemPrompt" rows="2" placeholder="設定本次對話的系統指令">${esc(systemDrafts.get(c.id)??c.system_prompt)}</textarea></label><button class="secondary" id="saveSystem">儲存設定</button></div><div id="formatNotice" class="format-notice" role="status" hidden></div><button id="loadOlder" class="secondary older-messages" ${c.messages_cursor?'':'hidden'}>載入更早訊息</button><div class="messages" id="messages" data-conversation-id="${esc(c.id)}"></div><div class="latest-bar"><button id="jumpLatest" class="secondary" hidden>↓ 回到最新訊息</button></div><div class="composer-wrap"><div id="queue" class="queue"></div><div class="composer"><textarea id="compose" data-conversation-id="${esc(c.id)}" enterkeyhint="send" rows="2" placeholder="輸入你的想法… Enter 傳送，Shift + Enter 換行"></textarea><div class="composer-foot"><div class="composer-tools">${thinkingControl(c)}<span class="composer-caption">MARKDOWN · LATEX · CODE</span></div><div><button id="stop" class="secondary" ${isGenerating(c.id)?'':'hidden'}>■ 停止</button><button id="send" class="primary">傳送 ↗</button></div></div></div><p class="hint">每次請求完整傳送對話上下文 · 不包含圖片或附件</p></div>`:state.selected?`<div class="empty-chat" role="status"><p>${state.detailError?esc(state.detailError):'正在載入對話…'}</p>${state.detailError?'<button id="retryConversation" class="secondary">重試載入</button>':''}</div>`:`<div class="empty-chat"><span class="hero-mark spark">✳</span><div class="eyebrow">A SPACE FOR YOUR IDEAS</div><h1>今天，有什麼新想法？</h1><p>開啟一段對話，讓思路自由延伸。</p><button class="primary" id="startNew">建立新對話　↗</button></div>`}</section></div>`;
 $('#new').onclick=makeConvo;if($('#startNew'))$('#startNew').onclick=makeConvo;
 renderSidebar();
 const search=$('#conversationSearch');search.oninput=()=>{listQuery=search.value;clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadConvos().catch(e=>notify(e.message,{kind:'error'})),300)};
 if($('#retryConversation'))$('#retryConversation').onclick=()=>openConvo(state.selected);
 if(!ready)return;
 $('#rename').onclick=()=>runAction('rename-'+c.id,$('#rename'),async()=>{const title=await inputDialog('重新命名對話',c.title);if(title)await patchConvo({title})});
 $('#deleteChat').onclick=()=>runAction('delete-'+c.id,$('#deleteChat'),async()=>{
   if(!await confirmAction('確定永久刪除此對話？',{label:'刪除對話'}))return;
   await api('/conversations/'+c.id,'DELETE');captureView();
   if(state.selected===c.id){detailRequests.cancel();state.selected=null;state.detail=null}
   try{if(localStorage.getItem('ai-station-last-conversation')===c.id)localStorage.removeItem('ai-station-last-conversation')}catch{}
   state.conversations=state.conversations.filter(x=>x.id!==c.id);if(state.tab==='chat')render();drafts.remove(c.id);systemDrafts.delete(c.id);messagePositions.delete(c.id);
 });
 $('#modelSelect').onchange=e=>{const m=state.models.find(x=>x.id===e.target.value);if(m)return runAction('model-'+c.id,e.target,async()=>{await patchConvo({provider_id:m.provider_id,model_id:m.model_id});state.thinkingSelections.delete(c.id);try{localStorage.setItem('aistation-last-model',m.id)}catch{}if(state.selected===c.id&&state.tab==='chat'){captureView();chatPage()}})};
 $('#modelSearch').oninput=e=>{modelQuery=e.target.value;$('#modelSelect').innerHTML=modelOptions(c.provider_id,c.model_id)};
 $('#systemPrompt').oninput=e=>systemDrafts.set(c.id,e.target.value);
 $('#saveSystem').onclick=()=>{const value=$('#systemPrompt').value;return runAction('system-'+c.id,$('#saveSystem'),async()=>{await patchConvo({system_prompt:value});if(systemDrafts.get(c.id)===value)systemDrafts.delete(c.id)},{success:'已儲存對話設定'})};
 $('#loadOlder').onclick=()=>runAction('older-'+c.id,$('#loadOlder'),()=>loadOlder(c.id));
 bindThinkingControl(c.id);
 $('#send').onclick=queueMessage;
 const compose=$('#compose');compose.value=drafts.get(c.id);
 compose.oninput=()=>drafts.set(c.id,compose.value);
 $('#jumpLatest').onclick=()=>{const el=$('#messages');el.scrollTop=el.scrollHeight;messagePositions.set(c.id,{top:el.scrollTop,follow:true});updateJumpButton(el)};
 updateSendButton();
 $('#compose').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();queueMessage()}};
 $('#stop').textContent='停止本次';$('#stop').onclick=()=>runAction('stop-'+c.id,$('#stop'),()=>api('/conversations/'+c.id+'/stop','POST'));
 renderMessages();renderQueue();
}
let searchTimer=null;
function captureView(){
 saveFormDrafts();const system=$('#systemPrompt');if(system)systemDrafts.set(system.dataset.conversationId,system.value);
 const editor=$('[data-editing-message] textarea');if(editor)editDrafts.set(state.editingMessage,editor.value);
 const input=$('#compose');
 if(input?.dataset.conversationId)drafts.set(input.dataset.conversationId,input.value);
 drafts.flush();
 const el=$('#messages');
 if(el?.dataset.conversationId)messagePositions.set(el.dataset.conversationId,{top:el.scrollTop,follow:el.scrollHeight-el.clientHeight-el.scrollTop<=80});
}
window.addEventListener('pagehide',captureView);
document.addEventListener('visibilitychange',()=>{if(document.hidden)captureView()});

function messageHTML(m,req,record){
 const background=m.status==='running'&&!m.live;
 const content=background?'背景生成中，完成後會自動顯示完整回覆。':m.content;
 const thinking=background?'':m.thinking_content;
 if(record.formatVersion!==formatVersion){record.content=undefined;record.thinking=undefined;record.formatVersion=formatVersion}
 if(record.content!==content){record.content=content;record.html=renderMarkdown(content)}
 if(record.thinking!==thinking){record.thinking=thinking;record.thinkingHTML=thinking?renderMarkdown(thinking):''}
 return `<article class="message ${m.role}" data-message-id="${esc(m.id)}"><div class="avatar">${m.role==='user'?'你':'✳'}</div><div class="message-body"><div class="message-name">${m.role==='user'?'YOU':'AI STATION'} ${m.status==='running'?'<span class="working">正在生成…</span>':''}</div>${m.role==='assistant'&&thinking?`<details class="thinking-panel" data-thinking-id="${esc(m.id)}" ${(state.thinkingExpanded.get(m.id)??(m.status==='running'))?'open':''}><summary><span>✳ 模型提供的思考內容／摘要</span><span class="thinking-chevron">⌄</span></summary><div class="thinking-body">${record.thinkingHTML}</div></details>`:''}<div class="prose">${record.html}</div>${req?.status==='error'?`<details class="error-detail"><summary>錯誤 ${esc(req.http_status??'未知')} · ${esc(req.provider_error_code||'unknown')} — 展開詳情</summary><div>請求時間：${esc(req.started_at)}</div><pre>${esc(req.error_body)}</pre></details>`:''}${req&&req.status!=='running'?`<div class="usage">思考額度：${esc(describeThinking({mode:req.thinking_mode,effort:req.thinking_effort,budget_tokens:req.thinking_budget_tokens}))} · 輸入 ${fmt(req.input_tokens)} · 輸出 ${fmt(req.output_tokens)} · 快取讀取 ${fmt(req.cache_read_tokens)} · 推理 ${fmt(req.reasoning_tokens)} · ${esc(req.status)}</div>`:''}</div></article>`;
}
function updateJumpButton(el){
 const button=$('#jumpLatest');
 if(button)button.hidden=!state.detail?.messages?.length||el.scrollHeight-el.clientHeight-el.scrollTop<=80;
}
function renderMessages(changedIds=null){
 const el=$('#messages'),c=state.detail;
 if(!el||!c||el.dataset.conversationId!==c.id)return;
 updateFormatNotice();
 const fresh=renderedContainer!==el;
 const position=fresh?(messagePositions.get(c.id)||{top:0,follow:true}):{top:el.scrollTop,follow:messagePositions.get(c.id)?.follow??true};
 if(fresh){
   renderedContainer=el;messageNodes=new Map();changedIds=null;
   el.addEventListener('scroll',()=>{
     messagePositions.set(c.id,{top:el.scrollTop,follow:el.scrollHeight-el.clientHeight-el.scrollTop<=80});
     updateJumpButton(el);
   },{passive:true});
 }
 const requests=new Map((c.requests||[]).map(r=>[r.assistant_message_id,r]));
 const messages=changedIds?c.messages.filter(m=>changedIds.has(m.id)):c.messages;
 const editable=!isGenerating(c.id);
 for(const m of messages){
   const req=requests.get(m.id),record=messageNodes.get(m.id)||{};
   if(record.editing&&state.editingMessage===m.id)continue;
   const signature=JSON.stringify([formatVersion,m.role,m.status,!!m.live,m.content,m.thinking_content,req,state.editingMessage===m.id,editable]);
   if(record.signature===signature)continue;
   const template=document.createElement('template');
   template.innerHTML=messageHTML(m,req,record);
   const node=template.content.firstElementChild;
   $$('pre code',node).forEach(code=>{
     markdownRenderer?.highlight(code);
     const button=document.createElement('button');button.className='copy';button.textContent='複製';
     button.onclick=async()=>{try{await navigator.clipboard.writeText(code.textContent);button.textContent='已複製'}catch(e){notify('複製失敗：'+e.message,{kind:'error'})}};
     code.parentNode.prepend(button);
   });
   $$('.thinking-panel',node).forEach(panel=>panel.addEventListener('toggle',()=>state.thinkingExpanded.set(panel.dataset.thinkingId,panel.open)));
   bindMessageActions(node,c,m);
   if(record.node)record.node.replaceWith(node);
   else{el.querySelector('.messages-empty')?.remove();el.append(node)}
   record.node=node;record.signature=signature;record.editing=state.editingMessage===m.id;messageNodes.set(m.id,record);
 }
 if(!changedIds){
   const ids=new Set(c.messages.map(m=>m.id));
   for(const [id,record] of messageNodes)if(!ids.has(id)){record.node.remove();messageNodes.delete(id)}
   let cursor=el.firstElementChild;
   for(const m of c.messages){
     const node=messageNodes.get(m.id).node;
     if(node!==cursor)el.insertBefore(node,cursor);
     cursor=node.nextElementSibling;
   }
   if(!c.messages.length&&!el.firstElementChild)el.innerHTML='<div class="messages-empty">把腦中的疑問與靈感，放在這裡。</div>';
 }
 el.scrollTop=position.follow?el.scrollHeight:position.top;
 messagePositions.set(c.id,{top:el.scrollTop,follow:position.follow});
 updateJumpButton(el);
}
function bindMessageActions(node, conversation,m){
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
     $('#messages [data-editing-message] textarea')?.focus();
   });
   add('刪除',()=>runAction('delete-message-'+m.id,null,async()=>{
     if(!await confirmAction('確定刪除這則訊息？後續 API 將不再收到此段上下文。過去的 Token 統計會保留。'))return;
     try{
       await api(msgPath,'DELETE');
       if(state.selected===conversation.id&&state.detail){state.detail.messages=state.detail.messages.filter(x=>x.id!==m.id);state.editingMessage=null;renderMessages()}
       editDrafts.delete(m.id);
     }catch(e){notify(e.message,{kind:'error'})}
   }),'danger');
   if(m.role==='user')add('回退至此',()=>runAction('rewind-'+m.id,null,async()=>{
     if(!await confirmAction('確定回退？此則使用者訊息與其後所有訊息將刪除，並放回輸入框重新編輯。請先完成或取消排隊任務再回退。'))return;
     try{
       const result=await api('/conversations/'+conversation.id+'/rewind','POST',{message_id:m.id});
       // Server-side queued jobs must be cancelled before history can be rewound.
       state.paused.delete(conversation.id);
       state.editingMessage=null;
       if(state.selected===conversation.id&&state.detail){const removed=new Set(result.removed_ids||state.detail.messages.slice(state.detail.messages.findIndex(x=>x.id===m.id)).map(x=>x.id));state.detail.messages=state.detail.messages.filter(x=>!removed.has(x.id));renderMessages();renderQueue()}
       const input=$('#compose');
       if(state.selected===conversation.id&&input){input.value=result.rewound_text;drafts.set(conversation.id,input.value);drafts.flush();input.focus()}
       await loadConvos();
     }catch(e){notify(e.message,{kind:'error'})}
   }));
   node.querySelector('.message-name')?.after(tools);
   if(state.editingMessage!==m.id)return;
   const editor=document.createElement('div');
   editor.className='message-editor';editor.dataset.editingMessage=m.id;
   const area=document.createElement('textarea');
   area.value=editDrafts.get(m.id)??m.content;area.oninput=()=>editDrafts.set(m.id,area.value);area.rows=5;area.maxLength=100000;
   editor.append(area);
   const buttons=document.createElement('div');buttons.className='actions';
   const save=document.createElement('button');save.className='primary';save.textContent='儲存修改';
   save.onclick=async()=>{
     if(!area.value.trim()){notify('訊息不得為空白');return}
     save.disabled=true;
     try{
       const result=await api(msgPath,'PATCH',{content:area.value});
       editDrafts.delete(m.id);
       if(state.selected===conversation.id&&state.detail){const target=state.detail.messages.find(x=>x.id===m.id);if(target)Object.assign(target,result.message||{content:area.value,thinking_content:''});state.editingMessage=null;renderMessages()}
       if(result.conversation)updateConversation(result.conversation);
     }catch(e){notify(e.message,{kind:'error'});save.disabled=false}
   };
   const cancel=document.createElement('button');cancel.className='secondary';cancel.textContent='取消';
   cancel.onclick=()=>{editDrafts.delete(m.id);state.editingMessage=null;renderMessages()};
   buttons.append(save,cancel);editor.append(buttons);
   node.querySelector('.prose')?.before(editor);
   const original=node.querySelector('.prose');
   if(original)original.hidden=true;
}
let messageRenderTimer=null,dirtyMessages=new Set();
function scheduleMessageRender(messageId){
 dirtyMessages.add(messageId);
 if(messageRenderTimer)return;
 const cid=state.selected;
 messageRenderTimer=setTimeout(()=>{
   messageRenderTimer=null;
   const changed=dirtyMessages;dirtyMessages=new Set();
   if(state.selected===cid)renderMessages(changed);
 },50);
}
async function readDetail(cid){
 const ticket=detailRequests.start(cid);
 try{
   const detail=await api('/conversations/'+cid+'?limit=50','GET',undefined,{signal:ticket.signal});
   if(!detailRequests.isCurrent(ticket)||state.selected!==cid)return null;
   if(state.detail?.id===cid&&(detail.event_cursor||0)<(state.detail.event_cursor||0))return detail;
   const jobs=state.liveJobs.get(cid);
   for(const id of jobs||[])if(!detail.queue.jobs.some(j=>j.id===id)&&submissions.get(cid)!==id)jobs.delete(id);
   if(jobs&&!jobs.size){state.liveJobs.delete(cid);state.liveAssistantIds.delete(cid)}
   for(const message of detail.messages)if(message.status==='running'&&jobs?.has(message.job_id)){
    if(!state.liveAssistantIds.has(cid))state.liveAssistantIds.set(cid,new Set());state.liveAssistantIds.get(cid).add(message.id);message.live=true;
   }
   return detail;
 }catch(e){if(ticket.signal.aborted||!detailRequests.isCurrent(ticket))return null;throw e}
}
async function openConvo(cid){
 captureView();liveFeed?.close();liveConversationId=null;
 state.selected=cid;state.editingMessage=null;modelQuery='';state.detail=null;state.detailError=null;render();
 try{
   const detail=await readDetail(cid);if(!detail)return;
   state.detail=detail;
   try{localStorage.setItem('ai-station-last-conversation',cid)}catch{}
   render();
 }catch(e){if(state.selected===cid){state.detailError=e.message;render()}}
}
const editDrafts=new Map();
async function makeConvo(){
 if(!usable().length){state.tab='admin';render();notify('請先新增 Endpoint 並啟用至少一個模型',{kind:'info'});return}
 return runAction('new-conversation',$('#new'),async()=>{
  const session=state.me;let preferred;try{preferred=localStorage.getItem('aistation-last-model')}catch{}
  const m=usable().find(x=>x.id===preferred)||usable()[0];
  const c=await api('/conversations','POST',{provider_id:m.provider_id,model_id:m.model_id});if(state.me!==session)return;updateConversation(c);if(state.tab==='chat')await openConvo(c.id);
 });
}
async function patchConvo(patch){
 const cid=state.detail?.id;if(!cid)return;
 const session=state.me,c=await api('/conversations/'+cid,'PATCH',patch);if(state.me!==session)return;
 updateConversation(c);if(state.selected===cid&&state.detail){Object.assign(state.detail,c);const heading=$('.chat-top h2');if(heading)heading.textContent=c.title}
}
async function loadOlder(cid){
 const current=state.detail,session=state.me;if(state.selected!==cid||!current?.messages_cursor)return;
 const page=await api('/conversations/'+cid+'/messages?limit=50&before='+current.messages_cursor);
 if(state.me!==session||state.selected!==cid||state.detail?.id!==cid)return;
 const el=$('#messages'),top=el?.scrollTop||0,height=el?.scrollHeight||0;
 const existing=new Set(state.detail.messages.map(m=>m.id));state.detail.messages.unshift(...page.items.filter(m=>!existing.has(m.id)));
 const requests=new Map(state.detail.requests.map(r=>[r.id,r]));for(const r of page.requests)requests.set(r.id,r);state.detail.requests=[...requests.values()];state.detail.messages_cursor=page.next_cursor;
 messagePositions.set(cid,{top,follow:false});renderMessages();if(el){el.scrollTop=top+el.scrollHeight-height;messagePositions.set(cid,{top:el.scrollTop,follow:false})}
 const button=$('#loadOlder');if(button)button.hidden=!page.next_cursor;
}
let liveFeed=null,liveConversationId=null,refreshScheduled=null;
function newRequestId(){const a=new Uint8Array(16);crypto.getRandomValues(a);a[6]=(a[6]&15)|64;a[8]=(a[8]&63)|128;const hex=[...a].map(x=>x.toString(16).padStart(2,'0')).join('');return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-')}

function subscribeConversation(cid,cursor){
 liveFeed?.close();liveConversationId=cid;
 if(refreshScheduled){clearTimeout(refreshScheduled);refreshScheduled=null}
 const feed=new EventSource('/api/conversations/'+encodeURIComponent(cid)+'/events?after='+encodeURIComponent(cursor||0));liveFeed=feed;
 const refreshSoon=()=>{
  if(refreshScheduled)return;
  refreshScheduled=setTimeout(async()=>{
   // Keep the lock until the request finishes, not only until the timer fires.
   try{if(state.selected===cid)await refreshDetail(cid)}catch(e){notify(e.message,{kind:'error'})}finally{refreshScheduled=null}
  },300);
 };
 feed.addEventListener('reset',async()=>{
  if(liveFeed!==feed)return;
  feed.close();liveConversationId=null;
  try{if(await refreshDetail(cid)&&state.tab==='chat')subscribeConversation(cid,state.detail.event_cursor)}catch(e){notify(e.message,{kind:'error'})}
 });
 for(const type of ['queued','started','delta','thinking_delta','complete','error','stopped','cancelled','resumed','paused','title']){
  feed.addEventListener(type,e=>{
   if(state.selected!==cid||liveFeed!==feed||!state.detail)return;
   // Native EventSource connection errors have no application payload.
   if(!e.data)return;
   const seq=Number(e.lastEventId);if(Number.isSafeInteger(seq)&&seq>0&&seq<=(state.detail.event_cursor||0))return;
   let data;try{data=JSON.parse(e.data)}catch{return}
   if(Number.isSafeInteger(seq)&&seq>0)state.detail.event_cursor=seq;
   if(type==='delta'||type==='thinking_delta'){
    const m=state.detail.messages.find(x=>x.id===data.assistant_id);
    if(m?.status==='running'&&(m.live||state.liveAssistantIds.get(cid)?.has(data.assistant_id))){
     m.live=true;if(type==='delta')m.content+=data.text||'';else m.thinking_content+=data.text||'';scheduleMessageRender(m.id);
    }
    // A background job stays a placeholder; wait for its final message instead of polling per chunk.
    return;
   }
   if(type==='started'&&state.liveJobs.get(cid)?.has(data.request_id)){
    if(!state.liveAssistantIds.has(cid))state.liveAssistantIds.set(cid,new Set());state.liveAssistantIds.get(cid).add(data.assistant_id);
   }
   if(data.conversation)updateConversation(data.conversation);
   if(data.queue)state.detail.queue=data.queue;
   for(const incoming of data.messages||[data.message].filter(Boolean)){
    const m={...incoming};if(m.status==='running'&&state.liveAssistantIds.get(cid)?.has(m.id))m.live=true;
    const index=state.detail.messages.findIndex(x=>x.id===m.id);if(index<0)state.detail.messages.push(m);else state.detail.messages[index]=m;
   }
   if(data.request){const i=state.detail.requests.findIndex(x=>x.id===data.request.id);if(i<0)state.detail.requests.push(data.request);else state.detail.requests[i]=data.request}
   if(['complete','stopped','error'].includes(type)){
    finishedJobs.set(cid,data.request_id);
    state.liveJobs.get(cid)?.delete(data.request_id);
    if(!state.liveJobs.get(cid)?.size){state.liveJobs.delete(cid);state.liveAssistantIds.delete(cid)}
   }
   if(type==='cancelled'){for(const id of data.request_ids||[data.request_id])state.liveJobs.get(cid)?.delete(id);if(!state.liveJobs.get(cid)?.size)state.liveJobs.delete(cid)}
   if(type==='title'&&data.title){state.detail.title=data.title;updateConversation({...state.detail,title:data.title});const h=$('.chat-top h2');if(h)h.textContent=data.title}
   // Compatibility with an older server/event log: coalesce a single snapshot when the event lacks data.
   if((type==='started'&&!data.messages)||(['complete','stopped','error'].includes(type)&&!data.message)||(!data.queue&&type!=='title'))refreshSoon();
   renderMessages();renderQueue();
  });
 }
}
function renderQueue(){
 const cid=state.selected,el=$('#queue'),q=state.detail?.queue;if(!el||!q)return;
 const running=(q.jobs||[]).some(j=>j.state==='running');
 if(running)state.remoteRunning.add(cid);else state.remoteRunning.delete(cid);
 const stopButton=$('#stop');if(stopButton)stopButton.hidden=!running;
 const signature=JSON.stringify([cid,q]);if(el.dataset.signature===signature)return;el.dataset.signature=signature;
 let position=0;
 el.innerHTML=(q.paused?`<div class="queued"><span>${q.reason==='MANUAL'?'佇列已手動暫停':'佇列已因 API 錯誤或重啟暫停'}</span><button id="resumeQueue" class="secondary">繼續傳送</button></div>`:'')+
  (q.jobs||[]).map(job=>`<div class="queued"><span>${job.state==='running'?'生成中':'排隊 '+(++position)} · ${esc(job.content.slice(0,100))}</span>${job.state==='queued'?`<button data-cancel="${esc(job.id)}" class="subtle">取消</button>`:''}</div>`).join('')+
  ((q.jobs||[]).length?`<div class="queue-controls">${running?'<button id="stopPause" class="secondary">停止並暫停佇列</button>':''}${!q.paused?'<button id="pauseQueue" class="subtle">暫停後續傳送</button>':''}${position?'<button id="cancelPending" class="subtle danger">取消全部待送</button>':''}</div>`:'');
 const action=(key,button,path,method,body,confirmation)=>runAction(key,button,async()=>{
  const session=state.me,cursor=state.detail?.event_cursor||0;
  if(confirmation&&!await confirmAction(confirmation,{label:'取消待送訊息'}))return;
  const result=await api('/conversations/'+cid+path,method,body);
  if(state.me===session&&state.selected===cid&&state.detail){if(result.queue){if((state.detail.event_cursor||0)===cursor)state.detail.queue=result.queue;renderQueue();renderMessages()}else await refreshDetail(cid)}
 });
 $$('[data-cancel]',el).forEach(b=>b.onclick=()=>action('cancel-'+b.dataset.cancel,b,'/queue/'+encodeURIComponent(b.dataset.cancel),'DELETE'));
 if($('#resumeQueue'))$('#resumeQueue').onclick=()=>action('resume-'+cid,$('#resumeQueue'),'/queue/resume','POST');
 if($('#stopPause'))$('#stopPause').onclick=()=>action('stop-pause-'+cid,$('#stopPause'),'/stop','POST',{pause:true});
 if($('#pauseQueue'))$('#pauseQueue').onclick=()=>action('pause-'+cid,$('#pauseQueue'),'/queue/pause','POST');
 if($('#cancelPending'))$('#cancelPending').onclick=()=>action('cancel-all-'+cid,$('#cancelPending'),'/queue','DELETE',undefined,'取消此對話全部尚未送出的訊息？目前的生成會繼續。');
}
function updateSendButton(){
 const button=$('#send');if(!button)return;
 const pending=submissions.has(state.selected);
 button.disabled=pending;button.textContent=pending?'送出中…':'傳送 ↗';
}
async function queueMessage(){
 const c=state.detail,session=state.me,acceptedCursor=c?.event_cursor||0;
 if(!c||c.id!==state.selected||submissions.has(c.id))return;
 const input=$('#compose'),content=input?.value.trim();
 if(!content)return;
 if(!c.model_id){notify('請先設定模型');return}
 const thinking=readThinkingUI();
 if(thinking.mode==='budget'&&(!Number.isSafeInteger(thinking.budget_tokens)||thinking.budget_tokens<Number($('#thinkingBudget').min)||thinking.budget_tokens>Number($('#thinkingBudget').max))){
   notify('請輸入此模型支援範圍內的整數思考 Token');return;
 }
 const keyName='aistation-submission-'+c.id;
 drafts.set(c.id,input.value);drafts.flush();
 const submittedDraft=drafts.snapshot(c.id);
 let saved=null;
 try{saved=JSON.parse(localStorage.getItem(keyName)||'null')}catch{}
 const same= saved&&saved.content===content&&JSON.stringify(saved.thinking)===JSON.stringify(thinking);
 const payload={content,thinking,idempotency_key:same?saved.idempotency_key:newRequestId()};
 submissions.set(c.id,payload.idempotency_key);updateSendButton();
 try{localStorage.setItem(keyName,JSON.stringify(payload))}catch{}
 if(!state.liveJobs.has(c.id))state.liveJobs.set(c.id,new Set());
 state.liveJobs.get(c.id).add(payload.idempotency_key);
 let acknowledged=false;
 try{
   let result;
   try{result=await api('/conversations/'+c.id+'/send','POST',payload)}catch(e){
    if(e.status===0||e.status>=500){try{const job=await api('/conversations/'+c.id+'/jobs/'+payload.idempotency_key,'GET',undefined,{retry:0});result={request_id:job.id,state:job.state}}catch{throw e}}else throw e;
   }
    if(state.me!==session)return;
    acknowledged=true;
    if(drafts.clearSubmitted(c.id,submittedDraft)&&state.selected===c.id&&$('#compose')?.dataset.conversationId===c.id)$('#compose').value='';
    try{if(JSON.parse(localStorage.getItem(keyName)||'null')?.idempotency_key===payload.idempotency_key)localStorage.removeItem(keyName)}catch{}
    submissions.delete(c.id);updateSendButton();
   if(state.selected===c.id&&state.detail){if(result.queue){if((state.detail.event_cursor||0)===acceptedCursor)state.detail.queue=result.queue;renderQueue()}else await refreshDetail(c.id)}
  }catch(e){
    if(state.me!==session)return;
    if(acknowledged)notify('訊息已排隊，暫時無法更新狀態，請重新進入對話：'+e.message);
    else{state.liveJobs.get(c.id)?.delete(payload.idempotency_key);notify((e.status===0||e.status>=500?'傳送結果尚未確認':'傳送失敗')+'，草稿已保留；以相同內容重新傳送會沿用請求 ID：'+e.message,{kind:'error'})}
  }finally{
    if(submissions.get(c.id)===payload.idempotency_key)submissions.delete(c.id);
    updateSendButton();
  }
}
async function refreshDetail(cid){
 if(state.selected!==cid||state.detail?.id!==cid)return false;
 const previous=state.detail;
 const updated=await readDetail(cid);
 if(!updated)return false;
 // A final SSE event may arrive while this HTTP snapshot is still in flight.
 if((updated.event_cursor||0)<(state.detail?.event_cursor||0))return true;
 for(const message of updated.messages)if(message.status==='running'&&state.liveJobs.get(cid)?.has(message.job_id)){
  if(!state.liveAssistantIds.has(cid))state.liveAssistantIds.set(cid,new Set());state.liveAssistantIds.get(cid).add(message.id);message.live=true;
 }
 updated.event_cursor=Math.max(updated.event_cursor||0,previous?.event_cursor||0);
 const oldest=updated.messages[0]?.cursor;if(oldest){const older=previous.messages.filter(m=>m.cursor&&m.cursor<oldest);updated.messages=[...older,...updated.messages];if(older.length)updated.messages_cursor=previous.messages_cursor}
 const requestMap=new Map(previous.requests.map(r=>[r.id,r]));for(const r of updated.requests)requestMap.set(r.id,r);updated.requests=[...requestMap.values()];
 for(const liveId of state.liveAssistantIds.get(cid)||[]){
   const newMessage=updated.messages.find(m=>m.id===liveId);
   const oldMessage=previous?.messages?.find(m=>m.id===liveId);
   if(newMessage&&newMessage.status==='running'){
     newMessage.live=true;
     if(oldMessage?.live){
       if(oldMessage.content.length>newMessage.content.length)newMessage.content=oldMessage.content;
       if(oldMessage.thinking_content.length>newMessage.thinking_content.length)newMessage.thinking_content=oldMessage.thinking_content;
     }
   }
 }
 state.detail=updated;updateConversation(updated);renderMessages();renderQueue();const older=$('#loadOlder');if(older)older.hidden=!updated.messages_cursor;
 return true;
}
function adminPage(){
 if(!state.adminLoaded){$('#main').innerHTML='<div class="empty-chat"><p>正在載入設定…</p><button id="retryAdmin" class="secondary" hidden>重試載入</button></div>';void loadAdmin();return}
 saveFormDrafts();const focused=document.activeElement,focusName=focused?.name,focusId=focused?.id,focusForm=focused?.closest('form')?.id;
 const s=state.stats||{requests:{},usage:{},recent:[]};$('#main').innerHTML=`<div class="admin"><div class="admin-header"><div><div class="eyebrow">SETTINGS & INSIGHTS</div><h1>管理中心.</h1><p class="section-note">模型設定、供應商與實際 API 用量。</p></div><div class="actions"><button class="secondary" id="refreshStats">重新整理用量</button><button class="secondary" id="exportChats">匯出對話 JSON</button></div></div><div class="admin-grid">${[['TOTAL REQUESTS',s.requests.count,'count'],['INPUT TOKENS',s.usage.input_tokens,'input_tokens'],['OUTPUT TOKENS',s.usage.output_tokens,'output_tokens']].map(([k,v,key])=>`<div class="metric"><span class="eyebrow">${k}</span><strong data-metric="${key}">${state.stats?fmt(v):'載入中…'}</strong></div>`).join('')}</div><section class="panel"><h2>API Endpoints</h2><p class="section-note">OpenAI：/chat/completions；Claude：/messages；Gemini 原生：API 基底 URL（https://generativelanguage.googleapis.com/v1beta）。</p><form id="providerForm" class="form-grid"><input type="hidden" name="id"><label>名稱<input name="name" required></label><label>協定<select name="protocol"><option value="openai">OpenAI 相容</option><option value="claude">Claude 相容</option><option value="gemini">Gemini 原生</option></select></label><label class="wide">完整 Endpoint<input type="url" name="endpoint" required></label><label class="wide">API Key（留空保留舊金鑰）<input type="password" autocomplete="off" name="api_key"></label><div class="wide actions"><button class="primary">儲存 Endpoint</button><button type="reset" class="secondary">清除</button></div></form><table class="data-table"><thead><tr><th>名稱</th><th>路徑</th><th>操作</th></tr></thead><tbody>${state.providers.map(p=>`<tr><td>${esc(p.name)}<div class="muted">${esc(p.protocol)} · Key 已遮蔽</div></td><td class="truncate">${esc(p.endpoint)}</td><td class="actions"><button class="secondary" data-ptest="${p.id}">測試</button><button class="secondary" data-pscan="${p.id}">偵測</button><button class="subtle" data-pedit="${p.id}">編輯</button><button class="subtle danger" data-pdel="${p.id}">刪除</button></td></tr>`).join('')}</tbody></table></section><section class="panel"><h2>模型列表</h2><form id="modelForm" class="form-grid"><label>Endpoint<select name="provider_id">${state.providers.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label><label>Model ID<input name="model_id" required></label><div class="wide"><button class="primary">手動新增模型</button></div></form><table class="data-table"><thead><tr><th>Endpoint</th><th>Model ID</th><th>來源</th><th>操作</th></tr></thead><tbody>${state.models.map(m=>`<tr><td>${esc(m.provider_name)}</td><td>${esc(m.model_id)}</td><td>${esc(m.source)}</td><td><button data-mtoggle="${m.id}" class="secondary">${m.enabled?'停用':'啟用'}</button><button data-mdel="${m.id}" class="subtle danger">刪除</button></td></tr>`).join('')}</tbody></table></section><section class="panel"><h2>新對話自動命名</h2><p class="section-note">第一輪 AI 完整回覆成功後，會將該輪對話內容傳送給指定的命名模型並產生簡短標題；可選不同供應商模型。手動重新命名不會被覆蓋。命名請求會計入 Token 統計。</p><div class="form-grid"><label>命名模型<select id="namingModelSelect"><option value="">停用自動命名</option>${usable().map(m=>`<option value="${esc(m.id)}" ${m.id===state.settings?.naming_model_id?'selected':''}>${esc(m.provider_name)} / ${esc(m.model_id)}</option>`).join('')}</select></label><div class="actions" style="align-items:end"><button type="button" class="primary" id="saveNaming">儲存命名設定</button></div></div></section><section class="panel panel-dark"><h2>預設 System Prompt</h2><textarea id="defaultSystem" rows="3">${esc(state.settings?.default_system_prompt)}</textarea><div class="actions" style="margin-top:16px"><button class="primary" id="saveDefault">儲存預設</button><button class="secondary" id="exportSettings">匯出設定（不含 Key）</button></div></section><section class="panel"><h2>用量與錯誤紀錄</h2><div class="admin-grid">${[['快取讀取',s.usage.cache_read_tokens,'cache_read_tokens'],['快取建立',s.usage.cache_creation_tokens,'cache_creation_tokens'],['推理 Token',s.usage.reasoning_tokens,'reasoning_tokens']].map(([k,v,key])=>`<div class="metric"><span class="eyebrow">${k}</span><strong data-metric="${key}">${state.stats?fmt(v):'載入中…'}</strong></div>`).join('')}</div><table class="data-table"><thead><tr><th>時間</th><th>供應商 / 模型</th><th>狀態</th><th>輸入</th><th>輸出</th><th>錯誤</th></tr></thead><tbody id="recentRequests">${s.recent.map(r=>`<tr><td>${esc(r.started_at)}</td><td>${esc(r.provider_name)} / ${esc(r.model_id)}</td><td>${esc(r.status)}</td><td>${fmt(r.input_tokens)}</td><td>${fmt(r.output_tokens)}</td><td>${r.error_body?`<details><summary>查看</summary><pre>${esc(r.http_status)} · ${esc(r.provider_error_code)}\n${esc(r.error_body)}</pre></details>`:'—'}</td></tr>`).join('')}</tbody></table></section></div>`;
 restoreFormDrafts();
 const redraw=()=>{if(state.tab==='admin'&&state.me)adminPage()};
 $('#providerForm').onsubmit=e=>{
  e.preventDefault();const form=e.target,f=Object.fromEntries(new FormData(form)),snapshot=JSON.stringify(f),session=state.me;
  return runAction('provider-save',form.querySelector('button'),async()=>{
   const result=await api(f.id?'/providers/'+f.id:'/providers',f.id?'PATCH':'POST',{...f,discover:false});if(state.me!==session)return;
   notify('Endpoint 已儲存');
   if(form.isConnected&&JSON.stringify(Object.fromEntries(new FormData(form)))===snapshot){form.reset();formDrafts.delete('providerForm')}
   await loadProviders();redraw();
   if(!f.id){
    notify('正在偵測可用模型…',{kind:'info'});
    try{const scan=await api('/providers/'+result.id+'/scan','POST',undefined,{timeout:30000});if(state.me!==session)return;await loadModels();redraw();notify('已偵測 '+scan.count+' 個模型')}
    catch(e){if(state.me===session)notify('Endpoint 已儲存，但模型偵測失敗：'+e.message+'。可按「偵測」重試或手動新增模型。',{kind:'error',duration:15000})}
   }else{await loadModels();redraw()}
  },{form});
 };
 $('#providerForm').oninput=saveFormDrafts;
 $('#providerForm').onreset=()=>queueMicrotask(()=>{formDrafts.delete('providerForm');saveFormDrafts()});
 const defaults={openai:'https://api.openai.com/v1/chat/completions',claude:'https://api.anthropic.com/v1/messages',gemini:'https://generativelanguage.googleapis.com/v1beta'};
 $('#providerForm').elements.protocol.onchange=e=>{const input=$('#providerForm').elements.endpoint;input.placeholder=defaults[e.target.value];if(!input.value||Object.values(defaults).includes(input.value))input.value=defaults[e.target.value];saveFormDrafts()};
 $('#providerForm').elements.endpoint.placeholder=defaults[$('#providerForm').elements.protocol.value];
 $$('[data-pedit]').forEach(b=>b.onclick=()=>{const p=state.providers.find(x=>x.id===b.dataset.pedit),f=$('#providerForm').elements;for(const k of ['id','name','protocol','endpoint'])f[k].value=p[k];f.api_key.value='';saveFormDrafts();f.name.focus()});
 $$('[data-ptest]').forEach(b=>b.onclick=()=>runAction('provider-work-'+b.dataset.ptest,b,async()=>{const session=state.me,r=await api('/providers/'+b.dataset.ptest+'/test','POST',undefined,{timeout:30000});if(state.me===session)notify('連線成功 · '+r.models_found+' 個模型')}));
 $$('[data-pscan]').forEach(b=>b.onclick=()=>runAction('provider-work-'+b.dataset.pscan,b,async()=>{const session=state.me,r=await api('/providers/'+b.dataset.pscan+'/scan','POST',undefined,{timeout:30000});if(state.me!==session)return;await loadModels();redraw();notify('已偵測 '+r.count+' 個模型')}));
 $$('[data-pdel]').forEach(b=>b.onclick=()=>runAction('provider-work-'+b.dataset.pdel,b,async()=>{const session=state.me;if(!await confirmAction('確定刪除此 Endpoint 與其模型？',{label:'刪除 Endpoint'}))return;await api('/providers/'+b.dataset.pdel,'DELETE');if(state.me!==session)return;await Promise.all([loadProviders(),loadModels()]);redraw()}));
 $('#modelForm').oninput=saveFormDrafts;
 $('#modelForm').onsubmit=e=>{e.preventDefault();const form=e.target,payload=Object.fromEntries(new FormData(form)),snapshot=JSON.stringify(payload),session=state.me;return runAction('model-save',form.querySelector('button'),async()=>{await api('/models','POST',payload);if(state.me!==session)return;if(form.isConnected&&JSON.stringify(Object.fromEntries(new FormData(form)))===snapshot){form.elements.model_id.value='';saveFormDrafts()}await loadModels();redraw()},{form,success:'模型已新增'})};
 $$('[data-mtoggle]').forEach(b=>b.onclick=()=>runAction('model-'+b.dataset.mtoggle,b,async()=>{const session=state.me,m=state.models.find(x=>x.id===b.dataset.mtoggle);await api('/models/'+m.id,'PATCH',{enabled:!m.enabled});if(state.me!==session)return;await loadModels();redraw()}));
 $$('[data-mdel]').forEach(b=>b.onclick=()=>runAction('model-'+b.dataset.mdel,b,async()=>{const session=state.me;if(!await confirmAction('刪除此模型？',{label:'刪除模型'}))return;await api('/models/'+b.dataset.mdel,'DELETE');if(state.me!==session)return;await loadModels();redraw()}));
 $('#defaultSystem').oninput=saveFormDrafts;$('#namingModelSelect').onchange=saveFormDrafts;
 $('#saveNaming').onclick=()=>{const value=$('#namingModelSelect').value,session=state.me;return runAction('naming-save',$('#saveNaming'),async()=>{const settings=await api('/settings','PATCH',{naming_model_id:value});if(state.me===session)state.settings={...state.settings,...settings}},{success:'已儲存命名模型'})};
 $('#saveDefault').onclick=()=>{const value=$('#defaultSystem').value,session=state.me;return runAction('default-save',$('#saveDefault'),async()=>{const settings=await api('/settings','PATCH',{default_system_prompt:value});if(state.me===session)state.settings={...state.settings,...settings}},{success:'已儲存預設 System Prompt'})};
 $('#refreshStats').onclick=()=>runAction('stats-refresh',$('#refreshStats'),()=>adminRefreshOnce(true));
 $('#exportChats').onclick=()=>location.href='/api/export?type=chats';$('#exportSettings').onclick=()=>location.href='/api/export?type=settings';
 for(const [selector,key] of [['#providerForm button','provider-save'],['#modelForm button','model-save'],['#saveNaming','naming-save'],['#saveDefault','default-save'],['#refreshStats','stats-refresh']]){const button=$(selector);markActionButton(button,key)}
 for(const b of $$('[data-ptest],[data-pscan],[data-pdel]')){const id=b.dataset.ptest||b.dataset.pscan||b.dataset.pdel;markActionButton(b,'provider-work-'+id)}
 for(const b of $$('[data-mtoggle],[data-mdel]')){markActionButton(b,'model-'+(b.dataset.mtoggle||b.dataset.mdel))}
 const focus=focusForm&&focusName?$('#'+focusForm)?.elements[focusName]:focusId?document.getElementById(focusId):null;focus?.focus();
}
async function loadAdmin(){
 if(adminLoading)return;
 const session=state.me,task=api('/admin');adminLoading=task;
 try{const data=await task;if(state.me!==session)return;state.providers=data.providers;state.models=data.models;state.settings=data.settings;state.adminLoaded=true;if(state.tab==='admin'){adminPage();void adminRefreshOnce()}}
 catch(e){if(state.me===session&&state.tab==='admin'){const text=$('#main .empty-chat p');if(text)text.textContent='設定暫時無法載入：'+e.message;const button=$('#retryAdmin');if(button){button.hidden=false;button.onclick=()=>{button.hidden=true;void loadAdmin()}}}}
 finally{if(adminLoading===task)adminLoading=null}
}
function updateStats(){
 if(state.tab!=='admin'||!state.stats)return;
 const s=state.stats;
 for(const node of $$('[data-metric]'))node.textContent=fmt(node.dataset.metric==='count'?s.requests.count:s.usage[node.dataset.metric]);
 const el=$('#recentRequests');if(el)el.innerHTML=s.recent.map(r=>`<tr><td>${esc(r.started_at)}</td><td>${esc(r.provider_name)} / ${esc(r.model_id)}</td><td>${esc(r.status)}</td><td>${fmt(r.input_tokens)}</td><td>${fmt(r.output_tokens)}</td><td>${r.error_body?`<details><summary>查看</summary><pre>${esc(r.http_status)} · ${esc(r.provider_error_code)}\n${esc(r.error_body)}</pre></details>`:'—'}</td></tr>`).join('');
}
function render(){
 captureView();clearTimeout(messageRenderTimer);messageRenderTimer=null;dirtyMessages.clear();
 shell();
 if(state.tab==='chat'){chatPage();if(state.detail&&state.selected!==liveConversationId)subscribeConversation(state.selected,state.detail.event_cursor)}
 else{liveFeed?.close();liveConversationId=null;adminPage();adminRefreshOnce()}
}
let statsLoading=null;
async function adminRefreshOnce(force=false){
 if(statsLoading||!force&&state.stats&&Date.now()-statsAt<15000)return;
 const session=state.me,revision=statsRevision;
 const task=api('/stats');statsLoading=task;
 try{const stats=await task;if(state.me!==session)return;state.stats=stats;statsAt=revision===statsRevision?Date.now():0;updateStats()}
 catch(e){if(state.me===session&&state.tab==='admin')notify('用量暫時無法載入：'+e.message)}
 finally{if(statsLoading===task){statsLoading=null;if(state.me===session&&state.tab==='admin'&&revision!==statsRevision)void adminRefreshOnce()}}
}
async function boot(){try{await load();render()}catch(e){if(e.status===401)login();else{root.innerHTML='<main class="empty-chat"><h1>暫時無法載入</h1><p id="bootError"></p><button id="retryBoot" class="primary">重試連線</button></main>';$('#bootError').textContent=e.message;$('#retryBoot').onclick=boot}}}
void boot();
