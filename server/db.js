import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const base = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(base, { recursive: true, mode: 0o700 });
export const db = new DatabaseSync(path.join(base, 'aistation.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL CHECK(protocol IN ('openai','claude','gemini')),
  endpoint TEXT NOT NULL UNIQUE, encrypted_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('discovered','manual')),
  enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider_id, model_id)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新的對話',
  system_prompt TEXT NOT NULL DEFAULT '',
  provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL, model_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL, thinking_content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'complete',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  assistant_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL, provider_name TEXT NOT NULL,
  model_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running',
  input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER,
  cache_read_tokens INTEGER, cache_creation_tokens INTEGER, reasoning_tokens INTEGER,
  usage_raw TEXT, finish_reason TEXT, http_status INTEGER, provider_error_code TEXT,
  error_body TEXT, started_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_convo ON messages(conversation_id,created_at);
CREATE INDEX IF NOT EXISTS idx_requests_convo ON requests(conversation_id,started_at);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);
`);
// SQLite cannot alter a CHECK constraint. Rebuild only the parent table with
// foreign keys disabled, preserving every ID and all dependent records.
const providerSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='providers'").get().sql;
if (!providerSchema.includes("'gemini'")) {
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;');
  try {
    db.exec(`CREATE TABLE providers_gemini_migration (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      protocol TEXT NOT NULL CHECK(protocol IN ('openai','claude','gemini')),
      endpoint TEXT NOT NULL UNIQUE, encrypted_key TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO providers_gemini_migration SELECT id,name,protocol,endpoint,encrypted_key,created_at,updated_at FROM providers;
    DROP TABLE providers;
    ALTER TABLE providers_gemini_migration RENAME TO providers;`);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw Error('Provider migration failed foreign key validation');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys=ON');
  }
}
// Add fields without recreating tables or dropping existing conversations.
const requestColumns = new Set(db.prepare('PRAGMA table_info(requests)').all().map(c => c.name));
for (const [name, definition] of [
  ['thinking_mode', "TEXT NOT NULL DEFAULT 'default'"],
  ['thinking_effort', 'TEXT'],
  ['thinking_budget_tokens', 'INTEGER']
]) {
  if (!requestColumns.has(name)) db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${definition}`);
}
const messageColumns = new Set(db.prepare('PRAGMA table_info(messages)').all().map(c => c.name));
if (!messageColumns.has('thinking_content')) {
  db.exec("ALTER TABLE messages ADD COLUMN thinking_content TEXT NOT NULL DEFAULT ''");
}
const convoColumns = new Set(db.prepare('PRAGMA table_info(conversations)').all().map(c=>c.name));
for (const [name,definition] of [
  ['title_customized','INTEGER NOT NULL DEFAULT 0'],
  ['auto_title_attempted','INTEGER NOT NULL DEFAULT 0']
]) if(!convoColumns.has(name))db.exec(`ALTER TABLE conversations ADD COLUMN ${name} ${definition}`);
const requestColumns2 = new Set(db.prepare('PRAGMA table_info(requests)').all().map(c=>c.name));
if(!requestColumns2.has('kind'))db.exec("ALTER TABLE requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'");
db.exec(`
CREATE TABLE IF NOT EXISTS queue_jobs (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 fingerprint TEXT NOT NULL,
 content TEXT NOT NULL,
 provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
 model_id TEXT NOT NULL,
 system_prompt TEXT NOT NULL DEFAULT '',
 thinking_json TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','complete','error','stopped','cancelled')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 started_at TEXT,finished_at TEXT, error_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_queue_jobs_convo ON queue_jobs(conversation_id,state,created_at,id);
CREATE TABLE IF NOT EXISTS queue_pauses (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
 reason TEXT NOT NULL DEFAULT 'error'
);
CREATE TABLE IF NOT EXISTS queue_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 job_id TEXT,
 event TEXT NOT NULL,
 payload TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_queue_events_convo_seq ON queue_events(conversation_id,seq);
CREATE TABLE IF NOT EXISTS event_floors (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_page ON conversations(updated_at DESC,id DESC);
`);
export const id = () => crypto.randomUUID();
const secret = process.env.DATA_ENCRYPTION_KEY;
if (!secret || secret.length < 32) throw new Error('DATA_ENCRYPTION_KEY must be at least 32 characters');
const key = crypto.createHash('sha256').update(secret).digest();
export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const payload = Buffer.concat([cipher.update(String(plain),'utf8'),cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), payload.toString('hex')].join('.');
}
export function decrypt(value) {
  const [iv, tag, text] = value.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'hex'));
  decipher.setAuthTag(Buffer.from(tag,'hex'));
  return Buffer.concat([decipher.update(Buffer.from(text,'hex')),decipher.final()]).toString('utf8');
}
export function query(sql,...params) { return db.prepare(sql).all(...params); }
export function one(sql,...params) { return db.prepare(sql).get(...params); }
export function run(sql,...params) { return db.prepare(sql).run(...params); }
export const publicProvider = p => ({ id:p.id, name:p.name, protocol:p.protocol, endpoint:p.endpoint, has_key:true, created_at:p.created_at,updated_at:p.updated_at });
export function utcNow() { return new Date().toISOString(); }
export function getSetting(key, defaultValue='') { return one('SELECT value FROM settings WHERE key=?',key)?.value ?? defaultValue; }
export function setSetting(key,value) { run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,String(value)); }
