import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';

test('Gemini migration preserves legacy providers and all dependent records across restarts',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aistation-gemini-migration-'));
  process.env.DATA_DIR=dir;
  process.env.DATA_ENCRYPTION_KEY='migration-test-key-at-least-32-characters';
  let db;
  try{
    const legacy=new DatabaseSync(path.join(dir,'aistation.sqlite'));
    legacy.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE providers (
        id TEXT PRIMARY KEY,name TEXT NOT NULL,protocol TEXT NOT NULL CHECK(protocol IN ('openai','claude')),
        endpoint TEXT NOT NULL UNIQUE,encrypted_key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE models (
        id TEXT PRIMARY KEY,provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,source TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(provider_id,model_id)
      );
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,title TEXT NOT NULL,system_prompt TEXT NOT NULL DEFAULT '',
        provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,model_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE requests (
        id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,started_at TEXT
      );
      CREATE TABLE queue_jobs (
        id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,state TEXT,created_at TEXT
      );
      INSERT INTO providers(id,name,protocol,endpoint,encrypted_key) VALUES
        ('p','既有端點','openai','https://legacy.invalid/v1/chat/completions','keep-encrypted-key'),
        ('claude','Claude','claude','https://legacy.invalid/v1/messages','keep-claude-key');
      INSERT INTO models(id,provider_id,model_id,source) VALUES('m','p','legacy-model','manual');
      INSERT INTO conversations(id,title,provider_id,model_id) VALUES('c','既有對話','p','legacy-model');
      INSERT INTO requests(id,conversation_id,provider_id) VALUES('r','c','p');
      INSERT INTO queue_jobs(id,conversation_id,provider_id,state) VALUES('j','c','p','queued');`);
    legacy.close();
    ({db}=await import('../server/db.js'));
    assert.equal(db.prepare("SELECT encrypted_key FROM providers WHERE id='p'").get().encrypted_key,'keep-encrypted-key');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM providers').get().n,2);
    for(const table of ['models','conversations','requests','queue_jobs']){
      assert.equal(db.prepare(`SELECT provider_id FROM ${table}`).get().provider_id,'p',table);
      assert.equal(db.prepare(`PRAGMA foreign_key_list(${table})`).all().find(fk=>fk.from==='provider_id').table,'providers');
    }
    assert.equal(db.prepare("SELECT title FROM conversations WHERE id='c'").get().title,'既有對話');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    db.prepare('INSERT INTO providers(id,name,protocol,endpoint,encrypted_key) VALUES(?,?,?,?,?)')
      .run('g','Gemini','gemini','https://gemini.invalid/v1beta','encrypted');
    assert.throws(()=>db.prepare('INSERT INTO providers(id,name,protocol,endpoint,encrypted_key) VALUES(?,?,?,?,?)')
      .run('bad','bad','unknown','https://bad.invalid','encrypted'));
    assert.throws(()=>db.prepare('INSERT INTO providers(id,name,protocol,endpoint,encrypted_key) VALUES(?,?,?,?,?)')
      .run('duplicate','duplicate','gemini','https://gemini.invalid/v1beta','encrypted'));
    db.close();db=null;
    const restarted=spawnSync(process.execPath,['--input-type=module','-e',
      "const {db}=await import('./server/db.js');if(db.prepare('SELECT COUNT(*) n FROM providers').get().n!==3)process.exit(1);db.close();"
    ],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env},encoding:'utf8',windowsHide:true});
    assert.equal(restarted.status,0,restarted.stderr);
    db=new DatabaseSync(path.join(dir,'aistation.sqlite'));
    db.exec("PRAGMA foreign_keys=ON; DELETE FROM providers WHERE id='p';");
    assert.equal(db.prepare('SELECT COUNT(*) n FROM models').get().n,0);
    for(const table of ['conversations','requests','queue_jobs'])
      assert.equal(db.prepare(`SELECT provider_id FROM ${table}`).get().provider_id,null,table);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{
    db?.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
});
