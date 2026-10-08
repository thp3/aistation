import test from 'node:test';
import assert from 'node:assert/strict';
import {DraftStore,LatestRequest} from '../src/chat-state.js';

function memoryStorage(){
  const values=new Map();
  return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
}
test('drafts keep exact text independently across conversations and reloads',()=>{
  const storage=memoryStorage(),drafts=new DraftStore(()=>storage);
  drafts.set('a','  第一段\n第二段  ');drafts.set('b','另一個草稿');drafts.flush();
  const restored=new DraftStore(()=>storage);
  assert.equal(restored.get('a'),'  第一段\n第二段  ');
  assert.equal(restored.get('b'),'另一個草稿');
  restored.remove('a');assert.equal(restored.get('a'),'');
  assert.equal(restored.get('b'),'另一個草稿');
});
test('a late send acknowledgement cannot erase new text or text edited back to the same value',()=>{
  const drafts=new DraftStore(()=>memoryStorage());
  drafts.set('a','送出的訊息');const submitted=drafts.snapshot('a');
  drafts.set('a','送出期間新輸入的草稿');
  assert.equal(drafts.clearSubmitted('a',submitted),false);
  assert.equal(drafts.get('a'),'送出期間新輸入的草稿');
  drafts.set('a','送出的訊息');
  assert.equal(drafts.clearSubmitted('a',submitted),false);
  assert.equal(drafts.clearSubmitted('a',drafts.snapshot('a')),true);
  assert.equal(drafts.get('a'),'');drafts.flush();
});
test('drafts remain usable when browser storage is unavailable',()=>{
  const drafts=new DraftStore(()=>{throw Error('storage blocked')});
  drafts.set('a','保留內容');drafts.flush();
  assert.equal(drafts.get('a'),'保留內容');
  drafts.remove('a');assert.equal(drafts.get('a'),'');
});
test('conversation request guards ignore late responses, including an A-B-A switch',()=>{
  const requests=new LatestRequest();
  const first=requests.start('a'),second=requests.start('b'),latest=requests.start('a');
  assert.equal(first.signal.aborted,true);assert.equal(second.signal.aborted,true);
  assert.equal(requests.isCurrent(first),false);assert.equal(requests.isCurrent(second),false);
  assert.equal(requests.isCurrent(latest),true);
  requests.cancel();assert.equal(requests.isCurrent(latest),false);
});
