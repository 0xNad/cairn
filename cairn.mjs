#!/usr/bin/env node
import { config as readConfig } from './src/config.mjs';
import { rpc, RpcError } from './src/rpc.mjs';
import { telegram, TelegramError } from './src/telegram.mjs';
import { openStore } from './src/store.mjs';
import { respond, commandList, commandFingerprint } from './src/commands.mjs';

const args = process.argv.slice(2);
if (args.length !== 1 || !['doctor', 'tick', 'run'].includes(args[0])) {
  process.stderr.write('Expected: node cairn.mjs run|tick|doctor\n');
  process.exit(2);
}

function exitCode(e) {
  if (e instanceof TelegramError) return e.code === 401 ? 3 : 1;
  if (e instanceof RpcError && e.code === 'config') return 2;
  return 1;
}
function reason(e) {
  if (e instanceof TelegramError || e instanceof RpcError || !(e instanceof Error)) return e.message ?? 'Unreachable';
  if (e instanceof Error && (e.message.includes('.json:') || /^(?:Expected|Invalid stored state|TELEGRAM_|CAIRN_|STARKNET_)/.test(e.message))) return e.message;
  // Never print a library error containing URL paths, tokens or message contents.
  return 'Cairn cannot continue';
}
async function main() {
  const config = readConfig();
  const tg = telegram(config);
  const node = rpc(config);
  const me = await tg.call('getMe');
  let spec = null;
  try { spec = await node.verify(); }
  catch (e) { if (e instanceof RpcError && e.code === 'config') throw e; if (args[0] === 'doctor') throw e; }
  if (args[0] === 'doctor') {
    const block = await node.call('starknet_blockNumber');
    process.stdout.write(JSON.stringify({ bot: me.username, chain: config.chain, block, spec }) + '\n');
    return;
  }
  const store = openStore(config.data);
  if (store.state.commands !== commandFingerprint) {
    await tg.call('setMyCommands', { commands: commandList });
    store.state.commands = commandFingerprint;
    store.save();
  }
  if (args[0] === 'run') await tg.call('deleteWebhook', { drop_pending_updates: false });

  let stopping = false, pollController = null, wake = null;
  const stop = () => { stopping = true; pollController?.abort(); wake?.(); };
  if (args[0] === 'run') {
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
  const blocked = new Set();
  async function pass() {
    let started = Date.now();
    let block = null, updates = 0, sent = 0;
    try {
      if (!spec) spec = await node.verify();
      block = await node.call('starknet_getBlockWithTxHashes', { block_id: 'latest' });
    } catch (e) { if (e instanceof RpcError && e.code === 'config') throw e; }
    for (;;) {
      if (stopping) break;
      pollController = new AbortController();
      let batch;
      try {
        batch = await tg.call('getUpdates', {
          offset: store.state.offset, timeout: args[0] === 'tick' ? 0 : config.tgTimeout, allowed_updates: ['message'],
        }, pollController.signal);
      } catch (e) {
        if (stopping && pollController.signal.aborted) break;
        throw e;
      } finally { pollController = null; }
      if (batch.length === 0) break;
      if (args[0] === 'run' && Date.now() - started >= config.pollMs) {
        started = Date.now();
        try {
          if (!spec) spec = await node.verify();
          block = await node.call('starknet_getBlockWithTxHashes', { block_id: 'latest' });
        } catch (e) { if (e instanceof RpcError && e.code === 'config') throw e; block = null; }
      }
      for (const update of batch) {
        if (update.update_id < store.state.offset) continue;
        // Durable at-most-once claim before any outbound reply; a crash may lose a reply, never duplicate it.
        store.state.offset = update.update_id + 1;
        store.save();
        updates++;
        const msg = update.message;
        if (!msg || typeof msg.text !== 'string' || !msg.chat || blocked.has(msg.chat.id)) continue;
        const replies = await respond(msg.text, me.username, config, node, block, spec);
        for (const html of replies) {
          try { if (await tg.send(msg.chat.id, html)) sent++; }
          catch (e) {
            if (e instanceof TelegramError && e.code === 403) { blocked.add(msg.chat.id); break; }
            if (e instanceof TelegramError && [401, 409].includes(e.code)) throw e;
            break;
          }
        }
      }
      // Keep long-polling; do not leave a 10-second gap after a reply.
    }
    if (args[0] === 'tick') await tg.call('getUpdates', { offset: store.state.offset, limit: 1, timeout: 0, allowed_updates: ['message'] });
    return { updates, sent, head: block?.block_number ?? null };
  }
  if (args[0] === 'tick') {
    process.stdout.write(JSON.stringify(await pass()) + '\n');
  } else {
    while (!stopping) {
      const start = Date.now();
      const result = await pass();
      const remaining = config.pollMs - (Date.now() - start);
      if (!stopping && config.tgTimeout === 0 && result.updates === 0 && remaining > 0) {
        await new Promise(resolve => {
          const timer = setTimeout(resolve, remaining);
          wake = () => { clearTimeout(timer); resolve(); };
        });
        wake = null;
      }
    }
  }
}

main().catch((e) => {
  process.stderr.write(`${reason(e)}\n`);
  process.exitCode = e?.message?.startsWith('TELEGRAM_') || e?.message?.startsWith('CAIRN_') || e?.message?.startsWith('STARKNET_') || e?.message?.includes('.json:') || e?.message?.startsWith('Invalid stored state') ? 2 : exitCode(e);
});
