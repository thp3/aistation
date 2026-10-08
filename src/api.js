export class ApiError extends Error{
 constructor(message,{status=0,code='NETWORK_ERROR',requestId=null}={}){super(message);this.status=status;this.code=code;this.requestId=requestId}
}
export function createApi(onUnauthorized){
 return async function api(path,method='GET',body,options={}){
  const {timeout=15000,retry=method==='GET'?1:0,signal,headers={},...rest}=options;
  for(let attempt=0;;attempt++){
   try{
    const response=await fetch('/api'+path,{...rest,method,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout),
     headers:{Accept:'application/json',...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const requestId=response.headers.get('X-Request-ID');
    let data;
    try{data=await response.json()}catch{throw new ApiError('伺服器回應格式異常，請稍後重試',{status:response.status,code:'INVALID_RESPONSE',requestId})}
    if(!response.ok){
     const error=new ApiError(data.error||'請求失敗',{status:response.status,code:data.code||'HTTP_'+response.status,requestId});
     if(response.status===401&&path!=='/login')onUnauthorized?.();
     throw error;
    }
    return data;
   }catch(error){
    if(signal?.aborted)throw error;
    const e=error instanceof ApiError?error:new ApiError(error.name==='TimeoutError'?'連線逾時，請稍後重試':'網路連線中斷，請檢查連線',{code:error.name==='TimeoutError'?'TIMEOUT':'NETWORK_ERROR'});
    if(attempt>=retry||!(e.status===0||[502,503,504].includes(e.status)))throw e;
    await new Promise(resolve=>setTimeout(resolve,300*(attempt+1)+Math.random()*200));
   }
  }
 };
}
