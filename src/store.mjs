import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync,
  unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { CairnError } from './errors.mjs';

// Round 2's state, in one SQLite file. Rollback journal (not WAL) with secure_delete, so that a deleted
// label or alert leaves no copy in CAIRN_DATA once its transaction commits; temp_store in memory, so that
// nothing is written outside CAIRN_DATA.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS chats (chat_id INTEGER PRIMARY KEY, type TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE IF NOT EXISTS watches (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, address TEXT NOT NULL,
  label TEXT, since_block INTEGER NOT NULL, UNIQUE (chat_id, address)) STRICT;
CREATE TABLE IF NOT EXISTS seen (chat_id INTEGER NOT NULL, address TEXT NOT NULL, token TEXT NOT NULL,
  PRIMARY KEY (chat_id, address, token)) STRICT;
CREATE TABLE IF NOT EXISTS whales (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, token TEXT NOT NULL,
  symbol TEXT NOT NULL, min TEXT NOT NULL, units TEXT NOT NULL, since_block INTEGER NOT NULL, UNIQUE (chat_id, token)) STRICT;
CREATE TABLE IF NOT EXISTS minimums (chat_id INTEGER NOT NULL, token TEXT NOT NULL, amount TEXT NOT NULL, units TEXT NOT NULL,
  PRIMARY KEY (chat_id, token)) STRICT;
CREATE TABLE IF NOT EXISTS muted (chat_id INTEGER NOT NULL, token TEXT NOT NULL, PRIMARY KEY (chat_id, token)) STRICT;
CREATE TABLE IF NOT EXISTS tracks (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, hash TEXT NOT NULL,
  since_block INTEGER NOT NULL, since_time INTEGER NOT NULL, stage INTEGER NOT NULL DEFAULT 0, UNIQUE (chat_id, hash)) STRICT;
CREATE TABLE IF NOT EXISTS offers (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, kind TEXT NOT NULL,
  value TEXT NOT NULL, chain_time INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS tokens (address TEXT PRIMARY KEY, symbol TEXT, decimals INTEGER, checked_at INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS rate (sender INTEGER PRIMARY KEY, dates TEXT NOT NULL, noticed INTEGER NOT NULL DEFAULT 0,
  last INTEGER NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS deliveries (seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, tx_hash TEXT NOT NULL,
  event_index INTEGER NOT NULL, kind TEXT NOT NULL, events TEXT NOT NULL, block INTEGER, chain_time INTEGER NOT NULL,
  state TEXT NOT NULL, message_id INTEGER, body TEXT, UNIQUE (chat_id, tx_hash, event_index)) STRICT;
CREATE INDEX IF NOT EXISTS deliveries_state ON deliveries (state, seq);
CREATE TABLE IF NOT EXISTS feeds (chat_id INTEGER PRIMARY KEY, token TEXT NOT NULL, symbol TEXT NOT NULL, floor TEXT,
  units TEXT NOT NULL, usd_cents TEXT, sides TEXT NOT NULL, thread INTEGER, since_block INTEGER NOT NULL) STRICT;
`;
const SCHEMA_VERSION = '2';
/** Round 3 adds the forum topic a subscription was set up in, which its deliveries post into. */
const THREAD_TABLES = ['watches', 'whales', 'deliveries'];

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
      this.db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON; PRAGMA temp_store = MEMORY;');
      this.db.exec(SCHEMA);
      for (const table of THREAD_TABLES) {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
        if (!columns.some((c) => c.name === 'thread')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN thread INTEGER`);
      }
      const version = this.get('schema');
      if (version !== null && version !== SCHEMA_VERSION) throw new Error('unknown schema');
      this.transaction(() => this.set('schema', SCHEMA_VERSION));
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
