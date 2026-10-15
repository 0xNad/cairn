import { constants, mkdirSync, lstatSync, chmodSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { Failure } from './config.mjs';

// One small snapshot; both the file and rename are durable before a reply can leave.
export function store(directory) {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory()) throw new Error();
    chmodSync(directory, 0o700);
    const file = join(directory, 'state.json'), temporary = join(directory, 'state.tmp');
    let state = { offset: 0, commands: [] };
    try {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { state = JSON.parse(readFileSync(fd, 'utf8')); } finally { closeSync(fd); }
      chmodSync(file, 0o600);
      if (!Number.isSafeInteger(state.offset) || state.offset < 0 || !Array.isArray(state.commands)) throw new Error();
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const save = () => {
      const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { chmodSync(temporary, 0o600); writeFileSync(fd, JSON.stringify(state) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, file);
      const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(parent); } finally { closeSync(parent); }
    };
    save();
    return { state, save };
  } catch { throw new Failure('CAIRN_DATA: cannot open private durable state; check permissions and state.json'); }
}
