import { mkdirSync, openSync, readFileSync, writeSync, fsyncSync, closeSync, renameSync, chmodSync, existsSync, lstatSync, unlinkSync, constants } from 'node:fs';
import { join } from 'node:path';

export function openStore(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error('Invalid data directory');
  chmodSync(dir, 0o700);
  const file = join(dir, 'state.json');
  let state = { offset: 0, commands: '' };
  if (existsSync(file) || isLink(file)) {
    if (!lstatSync(file).isFile()) throw new Error('Invalid stored state');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(saved.offset) || saved.offset < 0 || typeof saved.commands !== 'string') throw new Error('Invalid stored state');
    state = saved;
  }
  const save = () => {
    const tmp = join(dir, 'state.tmp');
    // A previous crash may leave a regular temp file. Never follow a planted symlink.
    if (existsSync(tmp) || isLink(tmp)) {
      if (!lstatSync(tmp).isFile()) throw new Error('Invalid temporary state');
      unlinkSync(tmp);
    }
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, JSON.stringify(state)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
    const dfd = openSync(dir, 'r');
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  };
  return { state, save };
}
function isLink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
