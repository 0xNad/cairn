import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { CairnError } from './errors.mjs';
import { validState } from './state-schema.mjs';

export class Store {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new CairnError('CAIRN_DATA must be a real directory.');
    chmodSync(directory, 0o700);
    this.file = join(directory, 'state.json');
    this.lock = join(directory, 'instance.sqlite');
    this.owner = null;
    this.state = { version: 2, offset: 0, commands: null, cursor: null, chats: {}, metadata: {} };
    this.acquire();
    try {
      if (existsSync(this.file)) {
        const info = lstatSync(this.file);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('unsafe state');
        chmodSync(this.file, 0o600);
        const saved = JSON.parse(readFileSync(this.file, 'utf8'));
        if (![1, 2].includes(saved.version) || !Number.isSafeInteger(saved.offset) || saved.offset < 0 ||
            !(saved.commands === null || typeof saved.commands === 'string')) throw new Error('invalid state');
        if (saved.version === 1) Object.assign(this.state, { offset: saved.offset, commands: saved.commands });
        else {
          if (!validState(saved)) throw new Error('invalid state');
          this.state = saved;
        }
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
