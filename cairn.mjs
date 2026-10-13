#!/usr/bin/env node
import { config, Failure, redactor } from './src/config.mjs';
import { store } from './src/store.mjs';
import { rpcClient, telegramClient, sleep } from './src/transport.mjs';
import { COMMANDS, reply } from './src/commands.mjs';
import { messages } from './src/format.mjs';

const shutdown = new AbortController();
const { signal } = shutdown;
const stop = () => shutdown.abort();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
const redact = redactor(process.env);

try {
  const c = config(process.env, process.argv.slice(2));
  const telegram = telegramClient(c, signal), rpc = rpcClient(c, signal);
  const me = await telegram('getMe');
  if (typeof me?.username !== 'string' || !/^[A-Za-z0-9_]{1,32}$/.test(me.username)) throw new Failure('Telegram returned an invalid bot username');
  if (c.command === 'doctor') {
    const node = await rpc.handshake();
    const block = await rpc.call('starknet_blockNumber');
    if (!Number.isSafeInteger(block) || block < 0) throw new Failure('Node returned an invalid block number');
    console.log(JSON.stringify({ bot: redact(me.username), chain: redact(node.chain), block, spec: redact(node.spec) }));
  } else {
    const { state, save } = store(c.data);
    if (c.command === 'run') await telegram('deleteWebhook', { drop_pending_updates: false });
    if (JSON.stringify(state.commands) !== JSON.stringify(COMMANDS)) {
      await telegram('setMyCommands', { commands: COMMANDS });
      state.commands = COMMANDS; save();
    }
    let head = null, headAt = -Infinity, updates = 0, sent = 0;
    const refresh = async () => {
      try {
        head = await rpc.call('starknet_getBlockWithTxHashes', { block_id: 'latest' });
        if (!Number.isSafeInteger(head?.block_number) || head.block_number < 0) head = null;
      } catch (e) {
        if (e.exit === 2 || signal.aborted) throw e;
        head = null;
      }
      headAt = performance.now();
    };
    await refresh();
    for (;;) {
      const batch = await telegram('getUpdates', { offset: state.offset, limit: 100,
        timeout: c.command === 'tick' ? 0 : c.tgTimeout, allowed_updates: ['message'] });
      if (!Array.isArray(batch)) throw new Failure('Telegram returned invalid updates');
      if (c.command === 'run' && performance.now() - headAt >= c.pollMs) await refresh();
      for (const update of batch) {
        signal.throwIfAborted();
        if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) throw new Failure('Telegram returned an invalid update id');
        if (update.update_id < state.offset) continue;
        const lines = await reply(update.message, { c, bot: me.username, rpc, head });
        state.offset = update.update_id + 1;
        save();
        updates++;
        for (const text of messages(lines, redact)) {
          const accepted = await telegram('sendMessage', { chat_id: update.message.chat.id, text,
            parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
          if (!accepted) break;
          sent++;
        }
      }
      if (c.command === 'tick' && batch.length === 0) {
        const pending = await telegram('getUpdates', { offset: state.offset, limit: 1, timeout: 0, allowed_updates: ['message'] });
        if (!Array.isArray(pending)) throw new Failure('Telegram returned invalid updates');
        if (pending.length) continue;
        console.log(JSON.stringify({ updates, sent, head: head?.block_number ?? null }));
        break;
      }
      if (c.command === 'run' && batch.length === 0 && c.tgTimeout === 0) await sleep(c.pollMs, signal);
    }
  }
} catch (e) {
  if (!signal.aborted) {
    process.stderr.write(JSON.stringify({ level: 'error', event: 'stopped', reason: redact(e instanceof Failure ? e.message : 'Operation failed; check node availability and private data directory permissions') }) + '\n');
    process.exitCode = e instanceof Failure ? e.exit : 1;
  }
} finally {
  process.removeListener('SIGTERM', stop);
  process.removeListener('SIGINT', stop);
}
