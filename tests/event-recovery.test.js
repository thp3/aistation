import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {eventStream} from '../server/event-stream.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aistation-event-recovery-'));
process.env.DATA_DIR=dir;process.env.DATA_ENCRYPTION_KEY='event-test-secret-at-least-32-characters';
const {db,run,one}=await import('../server/db.js');
const {subscribe,pruneEvents}=await import('../server/queue.js');
test.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})});
test('large replay and expired cursors explicitly request a snapshot instead of silent event loss',()=>{
 run("INSERT INTO conversations(id) VALUES('replay')");
 for(let i=0;i<1001;i++)run("INSERT INTO queue_events(conversation_id,event,payload,created_at) VALUES('replay','delta','{}','2020-01-01')");
 const events=[];subscribe('replay',0,e=>events.push(e))();assert.equal(events.length,1);assert.equal(events[0].event,'reset');
 pruneEvents();assert.equal(one('SELECT COUNT(*) AS n FROM queue_events').n,0);
 const expired=[];subscribe('replay',500,e=>expired.push(e))();assert.equal(expired[0].event,'reset');assert.equal(one("SELECT seq FROM event_floors WHERE conversation_id='replay'").seq,1001);
});
test('slow SSE clients are bounded, drained in order and detached on buffer overflow',()=>{
 class Response extends EventEmitter{
  status(){return this}set(){return this}flushHeaders(){}write(frame){this.frames.push(frame);return this.accept}destroy(){this.destroyed=true;this.emit('close')}
  frames=[];accept=true;
 }
 const res=new Response(),write=eventStream(res,{maxBuffer:180});
 res.accept=false;write({event:'first',payload:{n:1}});write({event:'second',payload:{n:2}});
 assert.equal(res.frames.length,2);res.accept=true;res.emit('drain');assert.match(res.frames.at(-1),/second/);
 res.accept=false;write({event:'blocked',payload:{}});write({event:'large',payload:{text:'x'.repeat(200)}});assert.equal(res.destroyed,true);
});
