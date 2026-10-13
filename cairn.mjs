#!/usr/bin/env node
import { loadConfig } from './src/config.mjs';
import { CairnError, log } from './src/errors.mjs';
import { serve } from './src/bot.mjs';

const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown.abort());
try {
  const config = loadConfig(process.argv.slice(2));
  const result = await serve(config, shutdown.signal);
  if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  if (!shutdown.signal.aborted) {
    log('error', error instanceof CairnError ? error.message : 'Unexpected failure; check the data directory and configuration.');
    process.exitCode = error instanceof CairnError ? error.exitCode : 1;
  }
}
