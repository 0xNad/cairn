// The bot's loop. `tick` makes one pass and prints its summary; `run` makes a pass every CAIRN_POLL_MS and, in
// between, long-polls Telegram and answers at once. A pass:
//   1. reads the head (the latest block header);
//   2. answers the pending updates (updates.mjs), each claimed durably before its reply;
//   3. scans the blocks after the cursor, at most CAIRN_MAX_BLOCKS (scanner.mjs), turns their events into alerts
//      (alerts.mjs) and records them in the ledger in the same write as the new cursor (ledger.mjs);
//   4. follows the tracked transactions (tracks.mjs), recording their posts the same way;
//   5. delivers the pending alerts in the order they were recorded, each marked sent once Telegram accepts it.
import { performance } from 'node:perf_hooks';
import { alertsOf } from './alerts.mjs';
import { migrate, pause } from './chats.mjs';
import { COMMANDS } from './commands.mjs';
import { CairnError, log, NodeBusy, RpcError } from './errors.mjs';
import { decodeChain, NodeValueError } from './felt.mjs';
import { linker, messages, redactor } from './format.mjs';
import { markFailed, markSent, pending, prune, record } from './ledger.mjs';
import { forgetIdle } from './limits.mjs';
import { expire } from './offers.mjs';
import { byTransaction, readRange } from './scanner.mjs';
import { Store } from './store.mjs';
import { Tokens } from './tokens.mjs';
import { followTracks } from './tracks.mjs';
import { Rpc, sleep, Telegram, TelegramLimited, TelegramRefusal } from './transport.mjs';
import { ALLOWED_UPDATES, effects } from './updates.mjs';

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
    const bot = new Bot({ config, signal, clean, rpc, tg, store, username, identity });
    return config.mode === 'tick' ? await bot.tick() : await bot.run();
  } finally { store.close(); }
}

// The node failing (busy, an error, an answer of the wrong shape) postpones a scan or a track to the next pass.
const nodeFailure = (error) => error instanceof NodeBusy || error instanceof RpcError || error instanceof NodeValueError;

/** A reply as the messages that carry it: [{ text, keyboard }], each part's keyboard under its last message. */
function pages(reply) {
  const out = [];
  for (const { lines, keyboard } of [reply].flat()) {
    const texts = messages(lines);
    texts.forEach((text, i) => out.push({ text, keyboard: i === texts.length - 1 ? keyboard : undefined }));
  }
  return out;
}
const markup = (keyboard) => (keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {});

class Bot {
  constructor({ config, signal, clean, rpc, tg, store, username, identity }) {
    Object.assign(this, { config, signal, clean, rpc, tg, store, username, identity });
    this.state = store.state;
    this.tokens = new Tokens(config, rpc, this.state.tokens);
    this.link = linker(config, clean);
    this.head = null;
    this.counts = { updates: 0, sent: 0, alerts: 0 };
  }

  get context() {
    const { state, config, rpc, tg, tokens, head, username, clean, link, signal } = this;
    return { state, config, rpc, tg, tokens, head, username, clean, link, signal, spec: this.identity?.spec };
  }

  async tick() {
    await this.readHead();
    for (let batch; (batch = await this.poll(0)).length;) await this.answer(batch);
    await this.pass();
    await this.poll(0, 1); // confirms the offset; an update that came meanwhile is the next tick's
    return { ...this.counts, head: this.head?.block_number ?? null, cursor: this.state.cursor };
  }

  async run() {
    for (let due = 0; !this.signal.aborted;) {
      if (performance.now() >= due) {
        await this.readHead();
        const behind = await this.pass();
        due = performance.now() + (behind ? 0 : this.config.pollMs); // a backlog is scanned pass after pass
      }
      const left = due - performance.now();
      const timeout = left <= 0 ? 0 : Math.min(this.config.tgTimeout, Math.max(1, Math.ceil(left / 1000)));
      const batch = await this.poll(timeout);
      if (batch.length) {
        await this.readHead();
        await this.answer(batch);
        await this.deliver();
      } else if (timeout === 0 && left > 0) await sleep(left, this.signal);
    }
  }

  async readHead() {
    try {
      this.identity ??= await handshake(this.rpc, this.config, this.clean);
      const block = await this.rpc.call('starknet_getBlockWithTxHashes', { block_id: 'latest' });
      if (!Number.isSafeInteger(block?.block_number) || block.block_number < 0 || !Number.isSafeInteger(block.timestamp)) throw new Error('invalid header');
      this.head = block;
    } catch (error) {
      if (this.signal.aborted || (error instanceof CairnError && error.exitCode === 2)) throw error;
      this.head = null;
      log('warn', 'node busy: latest header unavailable.');
    }
  }

  async poll(timeout, limit = 100) {
    const batch = await this.tg.call('getUpdates', { offset: this.state.offset, limit, timeout, allowed_updates: ALLOWED_UPDATES });
    if (!Array.isArray(batch)) throw new CairnError('Telegram returned invalid updates.');
    return batch;
  }

  async answer(batch) {
    for (const update of batch) {
      if (this.signal.aborted) break;
      if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) throw new CairnError('Telegram returned an invalid update id.');
      if (update.update_id < this.state.offset) continue;
      let todo = [];
      try { todo = await effects(update, this.context); }
      catch (error) {
        if (this.signal.aborted || error instanceof CairnError) throw error;
        log('warn', `An update could not be handled and is skipped (${this.clean(error?.message ?? error)}).`);
        // Every button press is answered, once.
        if (typeof update.callback_query?.id === 'string') todo = [{ answer: { id: update.callback_query.id, text: 'Something went wrong; try again.' } }];
      }
      // Claimed durably before any reply, in the same write as the changes it made: Telegram has no
      // idempotency key, so a crash can lose a reply but never sends one twice.
      this.state.offset = update.update_id + 1;
      this.store.save();
      this.counts.updates++;
      await this.perform(todo);
    }
  }

  async perform(todo) {
    for (const { answer, edit, send } of todo) {
      if (answer) await this.quietly(() => this.tg.call('answerCallbackQuery', { callback_query_id: answer.id, ...(answer.text ? { text: answer.text } : {}) }));
      if (edit) {
        const [page] = pages(edit.reply);
        await this.quietly(() => this.tg.call('editMessageText', { chat_id: edit.chat, message_id: edit.message, text: page.text,
          parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...markup(page.keyboard) }));
      }
      if (send) await this.reply(send);
    }
  }

  /** A call Telegram may refuse without consequence: an expired button, an edit that changes nothing. */
  async quietly(call) {
    try { await call(); } catch (error) {
      if (!(error instanceof TelegramRefusal)) throw error;
      log('debug', `Telegram refused a button answer or an edit (${error.code}).`);
    }
  }

  /** Sends a message: { accepted, message_id }, or why not: { blocked }, { migrated: the new chat id }, { refused }. */
  async send(chat, text, extra = {}) {
    try {
      const sent = await this.tg.call('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
      return sent === null ? { blocked: true } : { accepted: true, message_id: sent?.message_id };
    } catch (error) {
      if (!(error instanceof TelegramRefusal)) throw error;
      const to = error.parameters?.migrate_to_chat_id;
      if (Number.isSafeInteger(to) && to !== chat) return { migrated: to };
      if (/chat not found/i.test(error.description)) return { blocked: true };
      return { refused: error.description || `error ${error.code}` };
    }
  }

  async reply({ chat, reply, thread }) {
    let target = chat;
    for (const page of pages(reply)) {
      for (let hops = 0; ; hops++) {
        const result = await this.send(target, page.text, { ...markup(page.keyboard), ...(target === chat && thread !== undefined ? { message_thread_id: thread } : {}) });
        if (result.migrated && hops < 3) {
          migrate(this.state, target, result.migrated);
          this.store.save();
          target = result.migrated;
          continue;
        }
        if (result.blocked) {
          pause(this.state, target); // a 403: the chat's alerts wait until it writes again
          this.store.save();
          return;
        }
        if (result.accepted) this.counts.sent++;
        else log('warn', `Telegram refused a reply: ${this.clean(result.refused ?? 'migrated again')}.`);
        break;
      }
    }
  }

  /** Steps 3 and 4 when the head is known, then 5. Whether the scan is still behind the head. */
  async pass() {
    let behind = false;
    if (this.head) {
      behind = await this.scan();
      await this.follow();
      prune(this.state, this.head.timestamp);
      this.tokens.prune(this.head.timestamp);
      expire(this.state, this.head.timestamp);
      forgetIdle(this.state, this.head.timestamp);
      this.store.save();
    }
    await this.deliver();
    return behind;
  }

  async scan() {
    const { state, head } = this;
    if (state.cursor === null || !Object.values(state.chats).some((c) => c.watches.length || c.whales.length)) {
      state.cursor = Math.max(state.cursor ?? 0, head.block_number); // the first start, or nothing to scan for: no backfill
      return false;
    }
    if (state.cursor >= head.block_number) return false;
    const from = state.cursor + 1, to = Math.min(head.block_number, state.cursor + this.config.maxBlocks);
    try {
      const alerts = await alertsOf(byTransaction(await readRange(this.rpc, from, to)), this.context);
      for (const alert of alerts) record(state, alert);
      state.cursor = to;
      this.store.save();
      return to < head.block_number;
    } catch (error) {
      if (this.signal.aborted || !nodeFailure(error)) throw error;
      log('warn', `node busy: blocks ${from} to ${to} will be scanned again on the next pass.`);
      return false;
    }
  }

  async follow() {
    if (!Object.values(this.state.chats).some((c) => c.tracks.length)) return;
    try { await followTracks(this.state, this.context); }
    catch (error) {
      if (this.signal.aborted || !nodeFailure(error)) throw error;
      log('warn', 'node busy: tracked transactions will be checked again on the next pass.');
    }
    this.store.save();
  }

  async deliver() {
    const { state } = this;
    for (let hops = 0; ;) {
      const next = pending(state).find((message) => !state.chats[message.chat]?.paused);
      if (!next) return;
      let result;
      try { result = await this.send(Number(next.chat), next.text); }
      catch (error) {
        if (!(error instanceof TelegramLimited)) throw error;
        log('warn', 'Telegram rate limit: the pending alerts wait for the next pass.');
        return;
      }
      if (result.accepted) {
        markSent(state, next, result.message_id);
        this.counts.sent++;
        this.counts.alerts++;
      } else if (result.blocked) pause(state, next.chat);
      else if (result.migrated && hops++ < 10) migrate(state, next.chat, result.migrated); // sent again, to the new id
      else {
        markFailed(state, next);
        log('warn', `Telegram refused an alert: ${this.clean(result.refused ?? 'migrated again')}.`);
      }
      this.store.save();
    }
  }
}
