import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CairnError } from './errors.mjs';

function noSymlinks(path) {
  for (let p = path; ; p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new CairnError('CAIRN_DATA: symbolic links are not allowed', 2);
    if (dirname(p) === p) break;
  }
}

export class Store {
  constructor(dir, botId) {
    noSymlinks(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.dir = dir;
    this.file = join(dir, 'state.json');
    this.lock = join(dir, 'instance.lock');
    noSymlinks(this.file);
    noSymlinks(this.lock);
    this.acquire();
    try {
      this.state = { version: 1, botId, offset: 0, commands: null };
      if (existsSync(this.file)) {
        const s = JSON.parse(readFileSync(this.file, 'utf8'));
        if (s.version !== 1 || !Number.isSafeInteger(s.offset) || s.offset < 0) throw new Error('invalid state');
        if (s.botId !== botId) throw new CairnError('CAIRN_DATA belongs to another bot; choose a separate data directory', 2);
        this.state = { version: 1, botId, offset: s.offset, commands: s.commands ?? null };
      }
      this.save();
    } catch (error) { this.close(); throw error instanceof CairnError ? error : new CairnError('CAIRN_DATA: state is unreadable or invalid; restore a backup'); }
  }

  acquire() {
    try {
      const fd = openSync(this.lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, String(process.pid)); fsyncSync(fd); } finally { closeSync(fd); }
      this.owned = true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw new CairnError('CAIRN_DATA: cannot acquire instance lock');
      const pid = Number(readFileSync(this.lock, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new CairnError('CAIRN_DATA: invalid instance lock; inspect it before removal');
      try { process.kill(pid, 0); } catch (err) {
        if (err.code === 'ESRCH') { unlinkSync(this.lock); return this.acquire(); }
      }
      throw new CairnError('another instance is running');
    }
  }

  save() {
    const tmp = join(this.dir, 'state.json.tmp');
    noSymlinks(tmp);
    const fd = openSync(tmp, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { chmodSync(tmp, 0o600); writeFileSync(fd, JSON.stringify(this.state) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tmp, this.file);
    const directory = openSync(this.dir, constants.O_RDONLY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }

  claim(id) {
    if (!Number.isSafeInteger(id) || id < this.state.offset) return false;
    this.state.offset = id + 1;
    this.save();
    return true;
  }

  close() { if (this.owned) { unlinkSync(this.lock); this.owned = false; } }
}
