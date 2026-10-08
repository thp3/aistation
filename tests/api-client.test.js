import test from 'node:test';
import assert from 'node:assert/strict';
import {createApi,ApiError} from '../src/api.js';
test('safe reads retry transient failures and preserve custom headers; writes never automatically retry',async t=>{
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);let calls=0;
 globalThis.fetch=async(url,options)=>{calls++;assert.equal(options.headers['X-Test'],'value');assert.equal('Content-Type' in options.headers,false);return calls===1?new Response(JSON.stringify({error:'unavailable'}),{status:503}):Response.json({ok:true})};
 assert.deepEqual(await createApi()('/read','GET',undefined,{headers:{'X-Test':'value'}}),{ok:true});assert.equal(calls,2);
 calls=0;globalThis.fetch=async()=>{calls++;throw new TypeError('network lost')};
 await assert.rejects(createApi()('/write','POST',{content:'test'}),e=>e instanceof ApiError&&e.status===0);assert.equal(calls,1);
});
test('401 exposes its status and request ID, and login failures do not expire an existing session',async t=>{
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);let expired=0;
 globalThis.fetch=async()=>new Response(JSON.stringify({error:'login required',code:'SESSION_EXPIRED'}),{status:401,headers:{'X-Request-ID':'request-123'}});
 const api=createApi(()=>expired++);
 await assert.rejects(api('/private'),e=>e.status===401&&e.code==='SESSION_EXPIRED'&&e.requestId==='request-123');assert.equal(expired,1);
 await assert.rejects(api('/login','POST',{}));assert.equal(expired,1);
});
test('timeouts and invalid JSON are explicit failures rather than apparent successful responses',async t=>{
 const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
 globalThis.fetch=async()=>new Response('<html>wrong route</html>');
 await assert.rejects(createApi()('/missing'),e=>e.code==='INVALID_RESPONSE');
 globalThis.fetch=async(url,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});setTimeout(resolve,100)});
 await assert.rejects(createApi()('/slow','GET',undefined,{timeout:5,retry:0}),e=>e.code==='TIMEOUT');
});
