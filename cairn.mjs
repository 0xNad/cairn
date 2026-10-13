#!/usr/bin/env node
import { loadConfig } from './src/config.mjs';
import { CairnError } from './src/errors.mjs';
import { Commands, COMMANDS } from './src/commands.mjs';
import { Rpc, Telegram, wait } from './src/transport.mjs';
import { Store } from './src/store.mjs';

const controller = new AbortController();
const { signal } = controller;
let stopping = false, store, config;
const stop = () => { stopping = true; controller.abort(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['run', 'tick', 'doctor'].includes(command) || args.length) throw new CairnError('usage: node cairn.mjs run|tick|doctor (no flags)', 2);
  config = loadConfig();
  const tg = new Telegram(config, signal), rpc = new Rpc(config, signal);
  const me = await tg.call('getMe');
  if (!me || !/^[A-Za-z0-9_]{1,64}$/.test(me.username ?? '') || !Number.isSafeInteger(me.id)) throw new CairnError('Telegram getMe returned invalid bot metadata');
  if (command === 'doctor') {
    await rpc.check();
    const block = await rpc.call('starknet_blockNumber');
    if (!Number.isSafeInteger(block) || block < 0) throw new CairnError('node returned an invalid block number');
    process.stdout.write(config.redact(JSON.stringify({ bot: me.username, chain: rpc.chain, block, spec: rpc.spec })) + '\n');
    return;
  }
  store = new Store(config.data, me.id);
  if (command === 'run') await tg.call('deleteWebhook', { drop_pending_updates: false });
  const signature = JSON.stringify(COMMANDS);
  if (store.state.commands !== signature) {
    await tg.call('setMyCommands', { commands: COMMANDS });
    store.state.commands = signature;
    store.save();
  }
  const commands = new Commands(config, rpc, me.username);
  const counts = { updates: 0, sent: 0, head: null };
  let head = null, refreshed = -Infinity;
  async function refresh() {
    try { head = await rpc.head(); }
    catch (e) {
      if (signal.aborted || e.exitCode === 2) throw e;
      head = null;
    }
    refreshed = performance.now();
    counts.head = head?.block_number ?? null;
  }
  await refresh();
  do {
    const updates = await tg.updates(store.state.offset, command === 'tick' ? 0 : config.tgTimeout);
    if (!Array.isArray(updates)) throw new CairnError('Telegram getUpdates returned invalid updates');
    if (command === 'run' && (head === null || performance.now() - refreshed >= config.pollMs)) await refresh();
    for (const update of updates) {
      // Persist the claim before computation or sending. Telegram cannot atomically commit a reply
      // with our state: an interrupted reply is deliberately never resent (at-most-once).
      if (!store.claim(update.update_id)) continue;
      counts.updates++;
      for (const text of await commands.reply(update.message, head)) {
        if (await tg.send(update.message, text)) counts.sent++;
      }
    }
    if (command === 'tick' && !updates.length) {
      await tg.updates(store.state.offset, 0, 1);
      process.stdout.write(JSON.stringify(counts) + '\n');
      return;
    }
    if (command === 'run' && config.tgTimeout === 0 && !updates.length) await wait(config.pollMs, signal);
  } while (!stopping);
}

try { await main(); }
catch (error) {
  if (!stopping) {
    const reason = error instanceof CairnError ? error.message : 'internal error; inspect configuration and data permissions';
    process.stderr.write(JSON.stringify({ level: 'error', event: 'exit', reason: config ? config.redact(reason) : reason }) + '\n');
    process.exitCode = error instanceof CairnError ? error.exitCode : 1;
  }
} finally { store?.close(); }
