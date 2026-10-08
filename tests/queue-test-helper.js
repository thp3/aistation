import {randomUUID} from 'node:crypto';

export async function readEvents(base,cookie,cid,after,predicate,{timeout=5000}={}){
 const response=await fetch(base+'/api/conversations/'+cid+'/events?after='+after,{
  headers:{Cookie:cookie},signal:AbortSignal.timeout(timeout)
 });
 if(response.status!==200)throw Error('SSE HTTP '+response.status);
 const reader=response.body.getReader(),decoder=new TextDecoder();
 let output='',pending='',matched=false;
 try{
  while(!matched){
   const {done,value}=await reader.read();
   if(done)throw Error('SSE closed without expected event');
   pending+=decoder.decode(value,{stream:true});
   let pos;
   while((pos=pending.indexOf('\n\n'))>=0){
    const frame=pending.slice(0,pos);pending=pending.slice(pos+2);
    output+=frame+'\n\n';
    const event=frame.match(/^event: (.+)$/m)?.[1];
    const data=frame.match(/^data: (.+)$/m)?.[1];
    if(event&&data){let obj={};try{obj=JSON.parse(data)}catch{}
      if(predicate(event,obj,frame)){matched=true;break;}
    }
   }
  }
 }finally{await reader.cancel().catch(()=>{})}
 return output;
}
export async function sendAndWait(base,cookie,request,cid,body,{timeout=22000}={}){
 const before=await request('/conversations/'+cid);
 const after=before.data.event_cursor||0;
 const response=await fetch(base+'/api/conversations/'+cid+'/send',{
  method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},
  body:JSON.stringify({idempotency_key:randomUUID(),...body})
 });
 const data=await response.json();
 if(response.status>=400)return {status:response.status,data};
 const jobId=data.request_id;
 let job;
 const began=Date.now();
 while(Date.now()-began<timeout){
  const state=await request('/conversations/'+cid+'/jobs/'+jobId);
  job=state.data;
  if(['complete','error','stopped','cancelled'].includes(job.state))break;
  await new Promise(r=>setTimeout(r,45));
 }
 if(!job||!['complete','error','stopped','cancelled'].includes(job.state))throw Error('Queue job did not finish: '+jobId);
 const events=await readEvents(base,cookie,cid,after,(event,payload)=>['complete','error','stopped','cancelled'].includes(event)&&payload.request_id===jobId);
 return {status:200,data:events,job};
}
