import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveThinking,isLegacyClaudeModel} from '../server/thinking.js';

test('default omits all thinking parameters for both API types',()=>{
 for(const protocol of ['openai','claude']) {
   const result=resolveThinking(protocol,'any-model',{mode:'default'});
   assert.deepEqual(result.params,{});
   assert.equal(result.mode,'default');
 }
});

test('OpenAI effort becomes Chat Completions reasoning_effort',()=>{
 assert.deepEqual(resolveThinking('openai','o3',{mode:'effort',effort:'medium'}).params,{reasoning_effort:'medium'});
 assert.deepEqual(resolveThinking('openai','gpt-6',{mode:'effort',effort:'max'}).params,{reasoning_effort:'max'});
 assert.deepEqual(resolveThinking('openai','gpt-6',{mode:'effort',effort:'none'}).params,{reasoning_effort:'none'});
});

test('current Claude models use adaptive thinking with output_config effort',()=>{
 assert.equal(isLegacyClaudeModel('claude-sonnet-4-6'),false);
 assert.equal(isLegacyClaudeModel('claude-opus-5-5'),false);
 const {params,budget_tokens}=resolveThinking('claude','claude-sonnet-4-6',{mode:'effort',effort:'high'});
 assert.deepEqual(params,{thinking:{type:'adaptive',display:'summarized'},output_config:{effort:'high'},max_tokens:16384});
 assert.equal(budget_tokens,null);
});

test('older Claude models map effort to explicit thinking tokens',()=>{
 assert.equal(isLegacyClaudeModel('claude-sonnet-4-5-20250929'),true);
 assert.equal(isLegacyClaudeModel('claude-3-7-sonnet-latest'),true);
 const v=resolveThinking('claude','claude-sonnet-4-5-20250929',{mode:'effort',effort:'medium'});
 assert.deepEqual(v.params,{thinking:{type:'enabled',display:'summarized',budget_tokens:4096},max_tokens:6144});
 assert.equal(v.budget_tokens,4096);
});

test('manual budget is only accepted for Claude, validated strictly, with response room',()=>{
 const config=resolveThinking('claude','custom-proxy-model',{mode:'budget',budget_tokens:8192});
 assert.deepEqual(config.params,{thinking:{type:'enabled',display:'summarized',budget_tokens:8192},max_tokens:10240});
 for(const tokens of [0,1023,32769,3.5,'4096',null,{},NaN]){
   assert.throws(()=>resolveThinking('claude','test',{mode:'budget',budget_tokens:tokens}));
 }
 assert.throws(()=>resolveThinking('openai','o3',{mode:'budget',budget_tokens:4096}));
});

test('invalid options are rejected rather than silently discarded',()=>{
 assert.throws(()=>resolveThinking('claude','claude-4-6',{mode:'effort',effort:'none'}));
 assert.throws(()=>resolveThinking('openai','gpt-5',{mode:'effort',effort:'ultra'}));
 assert.throws(()=>resolveThinking('openai','gpt-5','high'));
 assert.throws(()=>resolveThinking('openai','gpt-5',{mode:'hidden'}));
});
