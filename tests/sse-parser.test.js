import test from 'node:test';
import assert from 'node:assert/strict';
import {SSEParser} from '../src/sse.js';

const encode=str=>new TextEncoder().encode(str);

test('SSE parser keeps UTF-8 characters whole across every byte boundary',()=>{
 const actual=[];
 const parser=new SSEParser(e=>actual.push(e));
 const data=encode('event: thinking_delta\r\ndata: {"text":"中文測試😊"}\r\n\r\n');
 for(const b of data)parser.feed(Uint8Array.of(b));
 parser.end();
 assert.deepEqual(actual,[{event:'thinking_delta',data:'{"text":"中文測試😊"}'}]);
});

test('SSE parser respects comments, ping, multiline data and bare CR',()=>{
 const actual=[];
 const p=new SSEParser(e=>actual.push(e));
 for(const chunk of ['event: ping\r\ndata: {}\r\n\r\n',': heartbeat\r\n\r\n','event: delta\rdata: line1\rdata: line2\r\r'])p.feed(encode(chunk));
 p.end();
 assert.deepEqual(actual,[{event:'ping',data:'{}'},{event:'delta',data:['line1','line2'].join(String.fromCharCode(10))}]);
});

test('SSE parser ignores incomplete last frame and rejects oversize',()=>{
 const data=[];
 const p=new SSEParser(e=>data.push(e),{maxFrameSize:120});
 p.feed(encode('event: message\\ndata: partial payload'));
 p.end();
 assert.deepEqual(data,[]);
 const huge=new SSEParser(()=>{}, {maxFrameSize:5});
 assert.throws(()=>huge.feed(encode('data: longer than five bytes\\n\\n')),/exceeds limit/);
});
