import { CairnError, log } from './errors.mjs';
import { decodeChain } from './felt.mjs';
import { messages, redactor } from './format.mjs';
import { COMMANDS } from './commands.mjs';
import { Tokens } from './tokens.mjs';
import { scan } from './scanner.mjs';
import { trackTransactions } from './tracking.mjs';
import { chatState, deliver, messageParams, prune, sendReply } from './ledger.mjs';
import { handleMessage, handleCallback } from './subscriptions.mjs';
import { Store } from './store.mjs';
import { Rpc, Telegram, sleep } from './transport.mjs';

async function handshake(rpc, config, clean) {
  const chain = decodeChain(await rpc.call('starknet_chainId'));
  if (chain !== config.chain) throw new CairnError(`Node reports ${clean(chain)}; expected ${config.chain}.`, 2);
  const spec = await rpc.call('starknet_specVersion');
  const version = typeof spec === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(spec) : null;
  if (!version || !(Number(version[1]) > 0 || Number(version[2]) >= 10)) {
    throw new CairnError(`Node spec ${clean(String(spec).slice(0, 100))} is below 0.10.0 or malformed.`, 2);
  }
  return { chain, spec: clean(spec) };
}
export async function serve(config, signal) {
  const clean = redactor(config), rpc = new Rpc(config, signal), tg = new Telegram(config, signal);
  const me = await tg.call('getMe');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(me?.username ?? '')) throw new CairnError('Telegram returned an invalid bot username.');
  const username = clean(me.username);
  let identity = null;
  try { identity = await handshake(rpc, config, clean); }
  catch (error) {
    if (signal.aborted || config.mode === 'doctor' || (error instanceof CairnError && error.exitCode === 2)) throw error;
    log('warn', 'node busy: chain identity will be checked again before chain reads.');
  }
  if (config.mode === 'doctor') {
    const block = await rpc.call('starknet_blockNumber');
    if (!Number.isSafeInteger(block) || block < 0) throw new CairnError('Node returned an invalid block number.');
    return { bot: username, ...identity, block };
  }
  const store = new Store(config.data);
  try {
    if (config.mode === 'run') await tg.call('deleteWebhook', { drop_pending_updates: false });
    const commandList = JSON.stringify(COMMANDS);
    if (store.state.commands !== commandList) {
      await tg.call('setMyCommands', { commands: COMMANDS });
      store.state.commands = commandList;
      store.save();
    }
    let updates = 0, sent = 0, alerts = 0, head = null;
    const context = { config, rpc, tg, username, clean, head, spec: identity?.spec, signal, store };
    context.tokens = new Tokens(context);
    const allowed_updates = ['message', 'callback_query', 'my_chat_member'];
    const readHead = async () => {
      try {
        identity ??= await handshake(rpc, config, clean);
        const block = await rpc.call('starknet_getBlockWithTxHashes', { block_id: 'latest' });
        if (!Number.isSafeInteger(block?.block_number) || block.block_number < 0 || !Number.isSafeInteger(block.timestamp) ||
            block.timestamp < 0 || block.timestamp > 8640000000000) throw new Error('invalid header');
        head = block;
        if (store.state.cursor === null) { store.state.cursor = head.block_number; store.save(); }
      } catch (error) {
        if (signal.aborted || (error instanceof CairnError && error.exitCode === 2)) throw error;
        head = null;
        log('warn', 'node busy: latest header unavailable.');
      }
      context.head = head;
      context.spec = identity?.spec;
    };
    const periodic = async () => {
      if (head) prune(store, head.timestamp);
      try { await scan(context); }
      catch (error) {
        if (signal.aborted) throw error;
        log('warn', 'Scan deferred; cursor unchanged. The full range will be retried.');
      }
      await trackTransactions(context);
      const accepted = await deliver(context);
      sent += accepted;
      alerts += accepted;
      store.save();
    };
    await readHead();
    let first = true;
    while (!signal.aborted) {
      // A zero-timeout initial pass recovers pending alerts before holding a long poll.
      const timeout = config.mode === 'tick' || first ? 0 : Math.min(config.tgTimeout, Math.max(1, Math.floor(config.pollMs / 1000)));
      const batch = await tg.call('getUpdates', { offset: store.state.offset, limit: 100, timeout, allowed_updates });
      first = false;
      if (!Array.isArray(batch)) throw new CairnError('Telegram returned invalid updates.');
      if (config.mode === 'run') await readHead();
      for (const update of batch) {
        if (signal.aborted) break;
        if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new CairnError('Telegram returned an invalid update id.');
        if (update.update_id < store.state.offset) continue;
        let reply, target;
        context.callbackAnswer = null;
        if (update.message) {
          target = update.message;
          reply = await handleMessage(target, context);
        } else if (update.callback_query) {
          target = update.callback_query.message;
          reply = await handleCallback(update.callback_query, context);
        } else if (update.my_chat_member) {
          const member = update.my_chat_member;
          if (Number.isSafeInteger(member.chat?.id)) {
            const status = member.new_chat_member?.status;
            if (['left', 'kicked'].includes(status)) chatState(store, member.chat.id).paused = true;
            else if (['member', 'administrator', 'creator'].includes(status)) chatState(store, member.chat.id).paused = false;
          }
        }
        // Subscription changes and update offset form one durable snapshot before replying.
        // Ordinary command replies retain Round 1's at-most-once policy.
        store.state.offset = update.update_id + 1;
        store.save();
        updates++;
        if (context.callbackAnswer) await tg.call('answerCallbackQuery', context.callbackAnswer);
        if (reply && Number.isSafeInteger(target?.chat?.id)) {
          if (reply.edit) {
            const parts = messages(reply.lines);
            await tg.call('editMessageText', { ...messageParams(target.chat.id, parts[0]),
              message_id: target.message_id, ...reply.extra });
          } else {
            for (const part of reply.batches ?? [reply]) {
              const chunks = part.separate ? part.lines.map(line => [line]) : [part.lines];
              for (const lines of chunks) sent += await sendReply(context, target.chat.id, lines, {
                ...(Number.isSafeInteger(target.message_thread_id) ? { message_thread_id: target.message_thread_id } : {}),
                ...part.extra,
              });
            }
          }
        }
      }
      if (config.mode === 'tick') {
        if (batch.length) continue;
        await periodic();
        await tg.call('getUpdates', { offset: store.state.offset, limit: 1, timeout: 0, allowed_updates });
        return { updates, sent, head: head?.block_number ?? null, alerts, cursor: store.state.cursor ?? 0 };
      }
      await periodic();
      if (config.tgTimeout === 0 && !batch.length) await sleep(config.pollMs, signal);
    }
  } finally { store.close(); }
}
