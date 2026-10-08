import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

test('existing requests migrate without dropping old rows',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aistation-thinking-'));
 process.env.DATA_DIR=dir;
 process.env.DATA_ENCRYPTION_KEY='testing-data-key-which-is-long-enough-for-crypto';
 try {
  const legacy=new DatabaseSync(path.join(dir,'aistation.sqlite'));
  legacy.exec(`CREATE TABLE requests(id TEXT PRIMARY KEY,conversation_id TEXT,started_at TEXT);
    INSERT INTO requests(id) VALUES ('legacy-request');
    CREATE TABLE messages(id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,content TEXT,status TEXT,created_at TEXT);
    INSERT INTO messages(id,conversation_id,role,content,status,created_at)
    VALUES ('old-message','old-chat','assistant','舊回答','complete','2026-01-01');`);
  legacy.close();
  const {db}=await import('../server/db.js');
  const columns=new Set(db.prepare('PRAGMA table_info(requests)').all().map(row=>row.name));
  for(const field of ['thinking_mode','thinking_effort','thinking_budget_tokens'])assert.ok(columns.has(field),field);
  const old=db.prepare("SELECT * FROM requests WHERE id='legacy-request'").get();
  assert.equal(old.thinking_mode,'default');
  assert.equal(old.thinking_effort,null);
  assert.equal(old.thinking_budget_tokens,null);
  const oldMessage=db.prepare("SELECT * FROM messages WHERE id='old-message'").get();
  assert.equal(oldMessage.content,'舊回答');
  assert.equal(oldMessage.thinking_content,'');
  db.close();
 }finally{
   // Windows may retain SQLite WAL/shm handles briefly after closing the DB.
   try{fs.rmSync(dir,{force:true,recursive:true,maxRetries:5,retryDelay:200})}
   catch(e){if(process.platform!=='win32'||e.code!=='EPERM')throw e}
 }
});
