import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { CairnError } from './errors.mjs';

export function acquireInstance(directory) {
  const file = join(directory, 'instance.db');
  let database;
  try {
    if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) throw new Error();
    database = new DatabaseSync(file);
    chmodSync(file, 0o600);
    // A held SQLite write lock prevents overlapping ticks as well as overlapping pollers. It carries
    // no application data and the OS releases it after SIGKILL; no stale PID file needs deleting.
    database.exec('PRAGMA journal_mode = MEMORY; BEGIN IMMEDIATE;');
    return database;
  } catch (error) {
    database?.close();
    if ([5, 6].includes(Number(error.errcode) & 255)) {
      throw new CairnError('Another Cairn instance is running with this CAIRN_DATA directory. Stop it before starting another.');
    }
    throw new CairnError('CAIRN_DATA: could not acquire the instance lock. Check directory permissions and free space.');
  }
}
