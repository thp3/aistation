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
  id TEXT PRIMARY KEY, name TEXT NOT NULL, protocol TEXT NOT NULL CHECK(protocol IN ('openai','claude')),
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
  content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'complete',
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
