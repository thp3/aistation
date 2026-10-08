// Feedback lives outside the page root, so navigation cannot destroy a pending dialog.
let host, current, pending=[];
function mount(){
 if(host)return;
 host=document.createElement('div');host.id='feedback';
 host.innerHTML='<div class="notifications" aria-live="polite" aria-atomic="false"></div><div class="dialog-backdrop" hidden></div>';
 document.body.append(host);
}
export function notify(message,{kind='success',duration=6000}={}){
 mount();const list=host.querySelector('.notifications'),item=document.createElement('div');
 item.className='notification '+kind;
 const text=document.createElement('span');text.textContent=message;
 const close=document.createElement('button');close.type='button';close.className='subtle';close.textContent='×';close.setAttribute('aria-label','關閉提示');
 const remove=()=>{clearTimeout(timer);item.remove()};close.onclick=remove;
 item.append(text,close);list.append(item);
 const timer=setTimeout(remove,kind==='error'?Math.max(duration,10000):duration);
 while(list.children.length>4)list.firstElementChild.remove();
}
export function formError(form,message){
 if(!form){notify(message,{kind:'error'});return}
 let el=form.querySelector('.inline-error');
 if(!el){el=document.createElement('p');el.className='inline-error wide';el.setAttribute('role','alert');form.append(el)}
 el.textContent=message;el.hidden=!message;
}
export function validateForm(form){
 const fields=[...form.elements].filter(el=>el.willValidate);
 for(const field of fields)field.removeAttribute('aria-invalid');
 const invalid=fields.find(field=>!field.validity.valid);if(!invalid)return true;
 const label=invalid.labels?.[0]?.firstChild?.textContent.trim()||invalid.name||'欄位';
 formError(form,invalid.validity.valueMissing?'請填寫'+label:invalid.validity.typeMismatch?'請輸入有效的'+label:invalid.validationMessage);
 invalid.setAttribute('aria-invalid','true');invalid.focus();return false;
}
function showNext(){
 if(current||!pending.length)return;
 mount();const task=pending.shift(),backdrop=host.querySelector('.dialog-backdrop'),previous=document.activeElement,root=document.querySelector('#app');
 current=task;backdrop.hidden=false;backdrop.replaceChildren();
 const panel=document.createElement('section');panel.className='app-dialog';panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby','dialogTitle');panel.setAttribute('aria-describedby','dialogDescription');
 const title=document.createElement('h2');title.id='dialogTitle';title.textContent=task.title;
 const description=document.createElement('p');description.id='dialogDescription';description.textContent=task.message;
 panel.append(title,description);
 let input;
 if(task.input!==undefined){input=document.createElement('input');input.value=task.input;input.maxLength=120;input.setAttribute('aria-label',task.title);panel.append(input)}
 const actions=document.createElement('div');actions.className='actions';
 const cancel=document.createElement('button');cancel.type='button';cancel.className='secondary';cancel.textContent='取消';
 const ok=document.createElement('button');ok.type='button';ok.className=task.danger?'primary danger':'primary';ok.textContent=task.label||'確認';
 actions.append(cancel,ok);panel.append(actions);backdrop.append(panel);
 const wasInert=root?.inert,overflow=document.body.style.overflow;if(root)root.inert=true;document.body.style.overflow='hidden';
 const finish=value=>{
  document.removeEventListener('keydown',keydown,true);backdrop.hidden=true;backdrop.onclick=null;
  if(root)root.inert=wasInert;
  document.body.style.overflow=overflow;
  current=null;task.resolve(value);if(previous?.isConnected)previous.focus();showNext();
 };
 task.close=()=>finish(null);cancel.onclick=task.close;
 ok.onclick=()=>{if(input&&!input.value.trim()){input.focus();return}finish(input?input.value.trim():true)};
 backdrop.onclick=e=>{if(e.target===backdrop)task.close()};
 function keydown(e){
  if(e.key==='Escape'){e.preventDefault();task.close()}
  if(e.key==='Enter'&&e.target===input){e.preventDefault();ok.click()}
  if(e.key==='Tab'){
   const nodes=[...(input?[input]:[]),cancel,ok],index=nodes.indexOf(document.activeElement);
   e.preventDefault();nodes[(index+(e.shiftKey?-1:1)+nodes.length)%nodes.length].focus();
  }
 }
 document.addEventListener('keydown',keydown,true);(input||cancel).focus();input?.select();
}
function dialog(options){return new Promise(resolve=>{pending.push({...options,resolve});showNext()})}
export const confirmAction=(message,options={})=>dialog({title:'確認操作',message,danger:true,...options});
export const inputDialog=(title,input='')=>dialog({title,message:'輸入新的名稱。',input,label:'儲存'});
export function dismissDialogs(){for(const task of pending)task.resolve(null);pending=[];current?.close()}
