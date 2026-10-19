import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { CairnError } from './errors.mjs';

// The state, version 2. Round 1 kept the update offset and the command list; round 2 adds the chats and their
// subscriptions, the scanner's cursor, the token metadata cache, the delivery ledger, the buttons offered for
// pasted inputs and, for the rate limit, the dates of each user's commands of the last minute. Never a name, a
// username or message text.
export const emptyState = () => ({
  version: 2, offset: 0, commands: null,
  cursor: null, // the last block scanned; null until the first pass that reads a head
  nextId: 1, // server ids of subscriptions, carried by the Remove buttons
  chats: {}, // chat id → { paused, watches, whales, minimums, muted, tracks } (chats.mjs)
  tokens: {}, // token address → { symbol, decimals, at } or { coin: false, at }, at in chain time (tokens.mjs)
  ledger: {}, // chat|tx|event_index → { chat, tx, seq, at, status, text?, message_id? } (ledger.mjs)
  seq: 0, // the order in which alerts were recorded: chain order
  offers: {}, // button id → { chat, kind: 'watch' | 'track', value, at }: a pasted input's button, for a day (offers.mjs)
  users: {}, // user id → { dates, noticed } (limits.mjs)
});
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
// A saved state as version 2: version 1 keeps its offset and command list. Anything malformed is refused,
// never reset, so that old updates cannot be replayed.
function upgrade(saved) {
  if (!isObject(saved) || ![1, 2].includes(saved.version) || !count(saved.offset) ||
      !(saved.commands === null || typeof saved.commands === 'string')) throw new Error('invalid state');
  const state = { ...emptyState(), ...(saved.version === 2 ? saved : { offset: saved.offset, commands: saved.commands }), version: 2 };
  if (!(state.cursor === null || count(state.cursor)) || !count(state.nextId) || !count(state.seq) ||
      !['chats', 'tokens', 'ledger', 'offers', 'users'].every((k) => isObject(state[k]))) throw new Error('invalid state');
  for (const chat of Object.values(state.chats)) {
    if (!isObject(chat) || !['watches', 'whales', 'minimums', 'muted', 'tracks'].every((k) => Array.isArray(chat[k]))) throw new Error('invalid state');
  }
  return state;
}

export class Store {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new CairnError('CAIRN_DATA must be a real directory.');
    chmodSync(directory, 0o700);
    this.file = join(directory, 'state.json');
    this.lock = join(directory, 'instance.sqlite');
    this.owner = null;
    this.state = emptyState();
    this.acquire();
    try {
      if (existsSync(this.file)) {
        const info = lstatSync(this.file);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('unsafe state');
        chmodSync(this.file, 0o600);
        this.state = upgrade(JSON.parse(readFileSync(this.file, 'utf8')));
      }
    } catch {
      this.close();
      throw new CairnError('CAIRN_DATA/state.json is invalid; restore a consistent state backup.');
    }
  }
  acquire() {
    // A separate SQLite transaction holds the OS lock for this process's lifetime. Unlike PID files,
    // it has no stale-owner deletion race, and the kernel releases it immediately after SIGKILL.
    if (existsSync(this.lock)) {
      const info = lstatSync(this.lock);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new CairnError('Unsafe CAIRN_DATA instance lock.');
    }
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
  save() {
    const temporary = join(this.directory, 'state.next');
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1) throw new CairnError('Unsafe CAIRN_DATA/state.next; restore a consistent state backup.');
      fchmodSync(fd, 0o600);
      ftruncateSync(fd, 0);
      writeFileSync(fd, JSON.stringify(this.state));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, this.file);
    const dir = openSync(this.directory, constants.O_RDONLY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  close() { if (this.owner) { this.owner.close(); this.owner = null; } }
}
