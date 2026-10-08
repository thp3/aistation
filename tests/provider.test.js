import test from 'node:test';import assert from 'node:assert/strict';
process.env.DATA_ENCRYPTION_KEY='testing-only-not-for-production-super-secret';
const {validateEndpoint,modelsUrl,normalizedUsage,redact}=await import('../server/provider.js');
test('endpoint format',()=>{assert.equal(validateEndpoint('https://example.com/v1/chat/completions','openai'),'https://example.com/v1/chat/completions');assert.throws(()=>validateEndpoint('https://example.com/v1','openai'));assert.throws(()=>validateEndpoint('file:///etc/passwd','openai'))});
test('models path',()=>assert.equal(modelsUrl({endpoint:'https://a.test/v1/messages',protocol:'claude'}),'https://a.test/v1/models'));
test('partial usage remains unknown',()=>assert.deepEqual(normalizedUsage('openai',{prompt_tokens:4}),{input_tokens:4,output_tokens:null,total_tokens:null,cache_read_tokens:null,cache_creation_tokens:null,reasoning_tokens:null}));
test('redaction',()=>assert.equal(redact('Bearer secret123'), 'Bearer [REDACTED]'));
test('Claude reasoning tokens are only recorded if provider explicitly returns them',()=>{
 const known=normalizedUsage('claude',{input_tokens:12,output_tokens:25,output_tokens_details:{thinking_tokens:9}});
 assert.equal(known.reasoning_tokens,9);
 assert.equal(known.input_tokens,12);
 assert.equal(normalizedUsage('claude',{output_tokens:25}).reasoning_tokens,null);
});
