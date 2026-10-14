#!/usr/bin/env node
import { configure } from './src/config.mjs';
import { operate } from './src/bot.mjs';
import { CairnError } from './src/errors.mjs';

let config;
try {
  config = configure(process.argv.slice(2), process.env);
  process.umask(0o077);
  await operate(config);
} catch (error) {
  const known = error instanceof CairnError;
  const reason = known ? error.message : 'Unexpected failure. Check the data directory and restart Cairn.';
  process.stderr.write(JSON.stringify({ level: 'error', event: 'exit', reason: config ? config.clean(reason) : reason }) + '\n');
  process.exitCode = known ? error.exitCode : 1;
}
