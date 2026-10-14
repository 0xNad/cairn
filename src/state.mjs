import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CairnError } from './errors.mjs';

export class State {
  constructor(directory, botId) {
    this.directory = directory;
    this.file = join(directory, 'state.json');
    this.temp = join(directory, 'state.next');
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error();
      chmodSync(directory, 0o700);
      for (const path of [this.file, this.temp]) if (existsSync(path)) {
        if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error();
        chmodSync(path, 0o600);
      }
      if (existsSync(this.temp)) unlinkSync(this.temp);
      this.value = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { version: 1, botId, offset: 0, commands: null };
      if (this.value.version !== 1 || this.value.botId !== botId || !Number.isSafeInteger(this.value.offset) || this.value.offset < 0) throw new Error();
      this.save();
    } catch {
      throw new CairnError('CAIRN_DATA: state is unreadable, unsafe or belongs to another bot. Use a private directory for this bot.');
    }
  }

  get offset() { return this.value.offset; }

  save() {
    let fd;
    try {
      fd = openSync(this.temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, JSON.stringify(this.value) + '\n');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(this.temp, this.file);
      // Persist the rename too: a power failure must not roll the update offset back.
      fd = openSync(this.directory, constants.O_RDONLY);
      fsyncSync(fd);
    } catch { throw new CairnError('CAIRN_DATA: could not durably save state. Check directory permissions and free space.'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }

  handled(updateId) {
    this.value.offset = Math.max(this.value.offset, updateId + 1);
    this.save();
  }

  commands(fingerprint) { this.value.commands = fingerprint; this.save(); }
}
