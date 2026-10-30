#!/usr/bin/env node
// launchd owns this supervisor; Cairn owns its SQLite state. Credentials stay in the private env file.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const [envFile, logDirectory] = process.argv.slice(2);
if (!envFile || !logDirectory) throw new Error('Usage: node deploy/launch.mjs <private-env-file> <log-directory>');
const info = statSync(envFile);
if (!info.isFile() || (info.mode & 0o077) || info.uid !== process.getuid()) {
  throw new Error('Cairn env file must be owned by this user and mode 600.');
}
mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
const MAX_BYTES = 5 * 1024 * 1024;
function logger(name) {
  const path = join(logDirectory, name);
  let size = existsSync(path) ? statSync(path).size : 0;
  return (chunk) => {
    if (size + chunk.length > MAX_BYTES) {
      if (existsSync(path)) renameSync(path, `${path}.1`);
      size = 0;
    }
    appendFileSync(path, chunk, { mode: 0o600 });
    size += chunk.length;
  };
}
const root = fileURLToPath(new URL('..', import.meta.url));
const child = spawn(process.execPath, [`--env-file=${resolve(envFile)}`, join(root, 'cairn.mjs'), 'run'], {
  cwd: root,
  env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: homedir(), LANG: 'en_US.UTF-8' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', logger('stdout.log'));
child.stderr.on('data', logger('stderr.log'));
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  stopping = true;
  child.kill(signal);
});
child.on('error', () => { console.error('Cairn process could not start.'); process.exitCode = 1; });
child.on('close', (code) => {
  // Invalid configuration or a rejected token needs repair, not a restart loop. launchd restarts other failures.
  process.exitCode = stopping || code === 2 || code === 3 ? 0 : (code ?? 1);
});
