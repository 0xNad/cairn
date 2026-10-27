import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { CairnError } from './errors.mjs';

// The state, in one SQLite file. Rollback journal (not WAL) with secure_delete, so that a deleted label or
// alert leaves no copy in CAIRN_DATA once its transaction commits; temp_store in memory, so that nothing is
// written outside CAIRN_DATA. Round 3 adds the forum topic (thread_id) of each subscription and delivery, the
// trade feed, the name cache, and the digest a group's summary counts.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS protection (chat_id INTEGER PRIMARY KEY, seed INTEGER NOT NULL DEFAULT 1,
 links INTEGER NOT NULL DEFAULT 1) STRICT;
CREATE TABLE IF NOT EXISTS network_subscriptions (chat_id INTEGER PRIMARY KEY, thread_id INTEGER) STRICT;
CREATE TABLE IF NOT EXISTS blocks (number INTEGER PRIMARY KEY, hash TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS chats (chat_id INTEGER PRIMARY KEY, type TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE IF NOT EXISTS watches (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, address TEXT NOT NULL,
  label TEXT, since_block INTEGER NOT NULL, thread_id INTEGER, UNIQUE (chat_id, address)) STRICT;
CREATE TABLE IF NOT EXISTS seen (chat_id INTEGER NOT NULL, address TEXT NOT NULL, token TEXT NOT NULL,
  PRIMARY KEY (chat_id, address, token)) STRICT;
CREATE TABLE IF NOT EXISTS whales (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, token TEXT NOT NULL,
  symbol TEXT NOT NULL, min TEXT NOT NULL, units TEXT NOT NULL, since_block INTEGER NOT NULL, thread_id INTEGER,
  UNIQUE (chat_id, token)) STRICT;
CREATE TABLE IF NOT EXISTS minimums (chat_id INTEGER NOT NULL, token TEXT NOT NULL, amount TEXT NOT NULL, units TEXT NOT NULL,
  PRIMARY KEY (chat_id, token)) STRICT;
CREATE TABLE IF NOT EXISTS muted (chat_id INTEGER NOT NULL, token TEXT NOT NULL, PRIMARY KEY (chat_id, token)) STRICT;
CREATE TABLE IF NOT EXISTS tracks (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, hash TEXT NOT NULL,
  since_block INTEGER NOT NULL, since_time INTEGER NOT NULL, stage INTEGER NOT NULL DEFAULT 0, thread_id INTEGER,
  UNIQUE (chat_id, hash)) STRICT;
CREATE TABLE IF NOT EXISTS offers (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, kind TEXT NOT NULL,
  value TEXT NOT NULL, chain_time INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS tokens (address TEXT PRIMARY KEY, symbol TEXT, decimals INTEGER, checked_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS rate (sender INTEGER PRIMARY KEY, dates TEXT NOT NULL, noticed INTEGER NOT NULL DEFAULT 0,
  last INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS deliveries (seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, tx_hash TEXT NOT NULL,
  event_index INTEGER NOT NULL, kind TEXT NOT NULL, events TEXT NOT NULL, block INTEGER, chain_time INTEGER NOT NULL,
  state TEXT NOT NULL, message_id INTEGER, body TEXT, thread_id INTEGER, digest TEXT, UNIQUE (chat_id, tx_hash, event_index)) STRICT;
CREATE TABLE IF NOT EXISTS reorg_checks (original_seq INTEGER PRIMARY KEY REFERENCES deliveries(seq) ON DELETE CASCADE,
  since_block INTEGER NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('check', 'rebuild', 'corrected')),
  correction_seq INTEGER UNIQUE REFERENCES deliveries(seq) ON DELETE CASCADE, reply_to INTEGER) STRICT;
CREATE INDEX IF NOT EXISTS deliveries_state ON deliveries (state, seq);
CREATE TABLE IF NOT EXISTS feeds (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL UNIQUE, token TEXT NOT NULL,
  symbol TEXT NOT NULL, min TEXT, min_units TEXT, min_usd TEXT, mode TEXT NOT NULL, since_block INTEGER NOT NULL,
  thread_id INTEGER) STRICT;
CREATE TABLE IF NOT EXISTS names (address TEXT PRIMARY KEY, labels TEXT NOT NULL, checked_at INTEGER NOT NULL) STRICT;
`;
/** A round 2 file gains round 3's columns; its new tables come from SCHEMA. One transaction: all or nothing. */
const MIGRATE_2_TO_3 = `
ALTER TABLE watches ADD COLUMN thread_id INTEGER;
ALTER TABLE whales ADD COLUMN thread_id INTEGER;
ALTER TABLE tracks ADD COLUMN thread_id INTEGER;
ALTER TABLE deliveries ADD COLUMN thread_id INTEGER;
ALTER TABLE deliveries ADD COLUMN digest TEXT;
`;
const SCHEMA_VERSION = '3';

function safeFile(path, what) {
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new CairnError(`Unsafe CAIRN_DATA ${what}; restore a consistent state backup.`);
}

export class Store {
  #statements = new Map();
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new CairnError('CAIRN_DATA must be a real directory.');
    chmodSync(directory, 0o700);
    this.file = join(directory, 'state.db');
    this.lock = join(directory, 'instance.sqlite');
    this.owner = null;
    this.db = null;
    this.acquire();
    try {
      safeFile(this.file, 'state.db');
      safeFile(`${this.file}-journal`, 'state.db-journal');
      const oldMask = process.umask(0o077);
      try { this.db = new DatabaseSync(this.file); } finally { process.umask(oldMask); }
      chmodSync(this.file, 0o600);
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; PRAGMA temp_store = MEMORY;');
      const version = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() ? this.get('schema') : null;
      if (version !== null && version !== '2' && version !== SCHEMA_VERSION) throw new Error('unknown schema');
      this.transaction(() => {
        if (version === '2') this.db.exec(MIGRATE_2_TO_3);
        this.db.exec(SCHEMA);
        if (!this.sql('PRAGMA table_info(network_subscriptions)').all().some(column => column.name === 'thread_id'))
          this.db.exec('ALTER TABLE network_subscriptions ADD COLUMN thread_id INTEGER');
        if (this.sql('PRAGMA table_info(protection)').all().some(column => column.name === 'network')) {
          this.db.exec(`INSERT OR IGNORE INTO network_subscriptions (chat_id) SELECT chat_id FROM protection WHERE network = 1;
            ALTER TABLE protection DROP COLUMN network;`);
        }
        if (this.get('reorg_layout') === null) {
          // One-time upgrade of the earlier round-4 digest flags; runtime state now lives only in reorg_checks.
          this.db.exec(`INSERT OR IGNORE INTO reorg_checks (original_seq, since_block, phase)
            SELECT seq, coalesce(json_extract(digest, '$.reorg'), block, 0),
              CASE WHEN json_extract(digest, '$.rebuild') = 1 THEN 'rebuild' ELSE 'check' END FROM deliveries
            WHERE json_extract(digest, '$.reorg') IS NOT NULL OR json_extract(digest, '$.rebuild') = 1;
            INSERT OR IGNORE INTO reorg_checks (original_seq, since_block, phase, correction_seq, reply_to)
            SELECT o.seq, coalesce(c.block, 0), 'corrected', c.seq, o.message_id FROM deliveries c JOIN deliveries o
              ON o.chat_id = c.chat_id AND o.tx_hash = c.tx_hash
              AND o.message_id = coalesce(json_extract(c.digest, '$.reply'), -4 - c.event_index) WHERE c.kind = 'correction';
            UPDATE deliveries SET digest = nullif(json_remove(digest, '$.reorg', '$.rebuild', '$.reply'), '{}')
              WHERE json_extract(digest, '$.reorg') IS NOT NULL OR json_extract(digest, '$.rebuild') IS NOT NULL
                OR (kind = 'correction' AND digest IS NOT NULL);`);
          this.set('reorg_layout', 1);
        }
        this.set('schema', SCHEMA_VERSION);
      });
      this.importRoundOne();
    } catch (error) {
      this.close();
      if (error instanceof CairnError) throw error;
      throw new CairnError('CAIRN_DATA/state.db is invalid; restore a consistent state backup.');
    }
  }
  acquire() {
    // A separate SQLite transaction holds the OS lock for this process's lifetime. Unlike PID files,
    // it has no stale-owner deletion race, and the kernel releases it immediately after SIGKILL.
    safeFile(this.lock, 'instance lock');
    const oldMask = process.umask(0o077);
    try {
      const fd = openSync(this.lock, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        if (fstatSync(fd).nlink !== 1) throw new Error('unsafe lock');
        fchmodSync(fd, 0o600);
      } finally { closeSync(fd); }
      this.owner = new DatabaseSync(this.lock);
      this.owner.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      this.close();
      throw new CairnError(error.errcode === 5 ? 'Another instance is running with this CAIRN_DATA.' : 'Cannot acquire CAIRN_DATA instance lock.');
    } finally { process.umask(oldMask); }
  }
  /** Round 1 kept its offset and command list in state.json: carry them over once, then remove it. */
  importRoundOne() {
    const legacy = join(this.directory, 'state.json');
    if (!existsSync(legacy) && !lstatSync(legacy, { throwIfNoEntry: false })) return;
    let saved;
    try {
      safeFile(legacy, 'state.json');
      saved = JSON.parse(readFileSync(legacy, 'utf8'));
      if (saved.version !== 1 || !Number.isSafeInteger(saved.offset) || saved.offset < 0 ||
          !(saved.commands === null || typeof saved.commands === 'string')) throw new Error('invalid state');
    } catch { throw new CairnError('CAIRN_DATA/state.json is invalid; restore a consistent state backup.'); }
    this.transaction(() => {
      this.offset = Math.max(this.offset, saved.offset);
      if (this.get('commands') === null && saved.commands !== null) this.set('commands', saved.commands);
    });
    for (const file of [legacy, join(this.directory, 'state.next')]) if (existsSync(file)) unlinkSync(file);
  }
  /** A cached prepared statement. */
  sql(text) {
    let statement = this.#statements.get(text);
    if (!statement) this.#statements.set(text, statement = this.db.prepare(text));
    return statement;
  }
  /** Runs `fn` in one durable transaction; nested calls join the outer one. */
  transaction(fn) {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  get(key) { return this.sql('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null; }
  set(key, value) { this.sql('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value)); }
  get offset() { return Number(this.get('offset') ?? 0); }
  set offset(value) { this.set('offset', value); }
  /** The last block scanned, or null before the first pass that read the head. */
  get cursor() { const v = this.get('cursor'); return v === null ? null : Number(v); }
  set cursor(value) { this.set('cursor', value); }
  close() {
    if (this.db) { try { this.db.close(); } catch { /* already closed */ } this.db = null; }
    if (this.owner) { this.owner.close(); this.owner = null; }
  }
}
