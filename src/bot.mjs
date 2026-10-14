import { CairnError } from './errors.mjs';
import { logger, pause } from './http.mjs';
import { Starknet } from './rpc.mjs';
import { Telegram } from './telegram.mjs';
import { State } from './state.mjs';
import { HeadReader } from './head.mjs';
import { answer, COMMANDS, needsChain, parse } from './commands.mjs';

export async function operate(config) {
  const shutdown = new AbortController();
  const signal = shutdown.signal;
  const stop = () => shutdown.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const log = logger(config);
  const rpc = new Starknet(config, signal, log);
  const telegram = new Telegram(config, signal, log);
  let state;
  let incompatible;
  const heads = new HeadReader(rpc, signal, log, (error) => {
    incompatible = error;
    shutdown.abort(error);
  });
  try {
    const me = await telegram.call('getMe');
    if (!me || !Number.isSafeInteger(me.id) || !/^[A-Za-z0-9_]{1,64}$/.test(me.username)) throw new CairnError('Telegram returned invalid bot information.');
    if (config.mode === 'doctor') {
      const identity = await rpc.validate();
      const block = await rpc.call('starknet_blockNumber');
      if (!Number.isSafeInteger(block) || block < 0) throw new CairnError('Node returned an invalid head block.');
      process.stdout.write(JSON.stringify({ bot: config.clean(me.username), chain: identity.chain, spec: config.clean(identity.spec), block }) + '\n');
      return;
    }
    let head = config.mode === 'tick' ? await heads.read() : null;
    signal.throwIfAborted();
    state = new State(config.data, me.id);
    if (config.mode === 'run') await telegram.call('deleteWebhook', { drop_pending_updates: false });
    const fingerprint = JSON.stringify(COMMANDS);
    if (state.value.commands !== fingerprint) {
      await telegram.call('setMyCommands', { commands: COMMANDS });
      state.commands(fingerprint);
    }
    // Verify the node at startup without making help or input validation depend on its availability.
    if (config.mode === 'run') heads.read();
    let updates = 0, sent = 0;
    while (!signal.aborted) {
      const pending = await telegram.updates(state.offset, config.mode === 'tick' ? 0 : config.tgTimeout);
      if (!Array.isArray(pending)) throw new CairnError('Telegram returned an invalid update list.');
      const batch = pending.sort((a, b) => a.update_id - b.update_id).map((update) => ({ update, command: parse(update.message, me.username) }));
      // Refresh once per batch only when it contains a valid chain lookup. Never serve a stale head
      // after the wait budget expires: those commands receive a busy reply and the read keeps retrying.
      if (config.mode === 'run' && batch.some(({ command }) => needsChain(command))) head = await heads.within(2000);
      for (const { update, command } of batch) {
        signal.throwIfAborted();
        if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new CairnError('Telegram returned an invalid update id.');
        if (update.update_id < state.offset) continue;
        const replies = command ? await answer(command, { config, rpc, username: me.username, head, log }) : [];
        // Reserve this update durably before any send: SIGKILL after acceptance cannot replay its reply.
        state.handled(update.update_id);
        updates++;
        for (const html of replies) {
          const accepted = await telegram.send(update.message, config.clean(html));
          if (accepted === null) { log('debug', 'chat_blocked'); break; }
          sent++;
        }
      }
      if (config.mode === 'tick' && pending.length === 0) {
        await telegram.updates(state.offset, 0, 1);
        process.stdout.write(JSON.stringify({ updates, sent, head: head?.block_number ?? null }) + '\n');
        return;
      }
      // A completed long poll already waited for updates. Short polling still yields, with a bounded
      // delay so a large chain-poll interval cannot leave Telegram commands waiting for ten seconds.
      if (config.mode === 'run' && config.tgTimeout === 0 && !pending.length) await pause(Math.min(config.pollMs, 1000), signal);
    }
  } catch (error) {
    if (incompatible) throw incompatible;
    if (!signal.aborted) throw error;
    log('info', 'shutdown');
  } finally {
    shutdown.abort();
    state?.close();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}
