import { performance } from 'node:perf_hooks';
import { Names } from './names.mjs';
import { Prices } from './prices.mjs';
import { tradeAlerts, VENUES } from './trades.mjs';
import { TOKEN_EVENTS } from './scanner.mjs';
import { walletAlerts } from './alerts.mjs';
import { callback, COMMANDS, parseCommand, parsePaste, respond } from './commands.mjs';
import { CairnError, log, NodeBusy, RpcError, TelegramRefused } from './errors.mjs';
import { decodeChain, NodeValueError } from './felt.mjs';
import { links, messages, redactor, textLines } from './format.mjs';
import { Ledger } from './ledger.mjs';
import { RateLimit } from './rate.mjs';
import { Scanner } from './scanner.mjs';
import { Store } from './store.mjs';
import { Subscriptions } from './subscriptions.mjs';
import { Tokens } from './tokens.mjs';
import { trackStep } from './tracks.mjs';
import { Rpc, Telegram, sleep } from './transport.mjs';

const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'];

const ADMINS = new Set(['creator', 'administrator']);
const LOUD_ALERTS = 3; // alerts per chat and pass with a notification; later ones in the same pass arrive silently
/** A 400 that means the bot may not write to the chat for now, rather than that one message was bad. */
const NO_WRITE = /not enough rights|have no rights|chat not found/i;
const SLOW_DOWN = 'Slow down: Cairn answers at most 10 commands a minute from one person, and ignores the rest until that minute has passed.';
/** Chain failures that leave the work for the next pass. */
const retriable = (error) => error instanceof NodeBusy || error instanceof RpcError || error instanceof NodeValueError;

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
    if (store.get('commands') !== commandList) {
      await tg.call('setMyCommands', { commands: COMMANDS });
      store.transaction(() => store.set('commands', commandList));
    }
    const bot = new Bot({ config, store, rpc, tg, clean, username, me, signal, identity });
    return config.mode === 'tick' ? await bot.tick() : await bot.run();
  } finally { store.close(); }
}

/**
 * One bot process. A pass: read the head; handle updates (a subscription covers the blocks after that head);
 * scan the next range for alerts and step the tracked transactions, saving what they find as pending; then
 * deliver the pending alerts, each marked sent only once Telegram accepts it.
 */
class Bot {
  constructor(o) {
    Object.assign(this, o);
    this.subs = new Subscriptions(o.store, o.config);
    this.ledger = new Ledger(o.store);
    this.tokens = new Tokens(o.config, o.store, o.rpc);
    this.names = new Names(o.config, o.rpc);
    this.prices = new Prices(o.config, o.rpc);
    this.tokens.names = this.names;
    this.rate = new RateLimit(o.store);
    this.scanner = new Scanner(o.rpc, o.config);
    this.fmt = links(o.config, o.clean);
    this.head = null;
    this.behind = false; // the last scan stopped below the head: the next pass comes at once
    this.wake = false; // a new track wants its first stage without waiting for the next pass
    this.counts = { updates: 0, sent: 0, alerts: 0 };
  }

  async tick() {
    await this.readHead();
    for (;;) {
      const batch = await this.poll(0);
      if (!batch.length) break;
      for (const update of batch) await this.handle(update);
    }
    await this.background();
    await this.deliver();
    await this.tg.call('getUpdates', { offset: this.store.offset, limit: 1, timeout: 0, allowed_updates: ALLOWED_UPDATES });
    return { updates: this.counts.updates, sent: this.counts.sent, head: this.head?.block_number ?? null,
      alerts: this.counts.alerts, cursor: this.store.cursor ?? 0 };
  }
  /** A pass every CAIRN_POLL_MS, long-polling Telegram in between; back to back while catching up. */
  async run() {
    let due = 0;
    while (!this.signal.aborted) {
      if (this.wake || performance.now() >= due) {
        this.wake = false;
        await this.readHead();
        await this.background();
        await this.deliver();
        due = performance.now() + (this.behind ? 0 : this.config.pollMs);
      }
      const wait = Math.max(0, due - performance.now());
      const timeout = this.config.tgTimeout === 0 || this.behind ? 0 : Math.min(this.config.tgTimeout, Math.max(1, Math.ceil(wait / 1000)));
      const batch = await this.poll(timeout);
      if (batch.length) {
        await this.readHead();
        for (const update of batch) {
          if (this.signal.aborted) break;
          await this.handle(update);
        }
        await this.deliver();
      } else if (timeout === 0 && !this.behind) await sleep(Math.max(1, wait), this.signal);
    }
  }

  async readHead() {
    this.names.reset(); this.prices.reset();
    try {
      this.identity ??= await handshake(this.rpc, this.config, this.clean);
      const block = await this.rpc.call('starknet_getBlockWithTxHashes', { block_id: 'latest' });
      if (!Number.isSafeInteger(block?.block_number) || block.block_number < 0 || !Number.isSafeInteger(block.timestamp)) throw new Error('invalid header');
      this.head = block;
      // The first head ever read becomes the cursor: Cairn never backfills.
      if (this.store.cursor === null) this.store.transaction(() => { this.store.cursor = block.block_number; });
    } catch (error) {
      if (this.signal.aborted || (error instanceof CairnError && error.exitCode === 2)) throw error;
      this.head = null;
      log('warn', 'node busy: latest header unavailable.');
    }
  }
  async poll(timeout) {
    const batch = await this.tg.call('getUpdates', { offset: this.store.offset, limit: 100, timeout, allowed_updates: ALLOWED_UPDATES });
    if (!Array.isArray(batch)) throw new CairnError('Telegram returned invalid updates.');
    return batch;
  }

  // ---- updates ---------------------------------------------------------------------------------------

  async handle(update) {
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) throw new CairnError('Telegram returned an invalid update id.');
    if (update.update_id < this.store.offset) return;
    let commit = () => null;
    if (update.message) commit = await this.onMessage(update.message);
    else if (update.callback_query) commit = await this.onCallback(update.callback_query);
    else if (update.my_chat_member) commit = this.onMembership(update.my_chat_member);
    // Claim durably before replying: Telegram has no idempotency key, so a crash can lose a reply but never
    // replays an accepted one. Whatever the update changed is saved in the same transaction. No chat text,
    // name or username is persisted.
    let out = null;
    this.store.transaction(() => { out = commit(); this.store.offset = update.update_id + 1; });
    this.counts.updates++;
    if (out) await this.respond(out);
  }
  async onMessage(message) {
    const chat = message?.chat;
    if (!Number.isSafeInteger(chat?.id)) return () => null;
    if (Number.isSafeInteger(message.migrate_to_chat_id)) return () => { this.subs.migrate(chat.id, message.migrate_to_chat_id); return null; };
    if (Number.isSafeInteger(message.migrate_from_chat_id)) return () => { this.subs.migrate(message.migrate_from_chat_id, chat.id); return null; };
    // A chat that writes again gets its pending alerts.
    const resume = () => this.subs.resume(chat.id);
    const command = parseCommand(message, this.username) ?? parsePaste(message);
    if (!command) return () => { resume(); return null; };
    const target = { chat_id: chat.id, ...(Number.isSafeInteger(message.message_thread_id) ? { message_thread_id: message.message_thread_id } : {}) };
    const sender = message.sender_chat?.id ?? message.from?.id;
    const verdict = this.rate.verdict(sender, message.date);
    if (verdict !== 'ok') {
      return () => {
        resume();
        this.rate.note(sender, message.date, verdict);
        return verdict === 'notice' ? { ...target, lines: textLines(SLOW_DOWN, this.clean) } : null;
      };
    }
    if (command.name === 'track') this.wake = true;
    const reply = await respond(command, this.context(chat, message));
    return () => {
      resume();
      this.rate.note(sender, message.date, 'ok');
      const r = reply();
      return r && { ...target, ...r };
    };
  }
  async onCallback(query) {
    const chat = query?.message?.chat;
    const commit = await callback(query, this.context(chat ?? {}, null));
    if (/^ot:/.test(String(query?.data ?? ''))) this.wake = true;
    return () => {
      if (Number.isSafeInteger(chat?.id)) this.subs.resume(chat.id);
      const r = commit();
      return { callback: query.id, ...r, ...(r.reply ? { reply: { chat_id: chat.id, ...r.reply } } : {}) };
    };
  }
  /** Kicked, left or barred from writing: the chat's alerts wait; added back or allowed again: they resume. */
  onMembership(update) {
    const chat = update.chat, member = update.new_chat_member;
    if (!Number.isSafeInteger(chat?.id) || member?.user?.id !== this.me.id) return () => null;
    const barred = member.status === 'restricted' && (member.is_member === false || member.can_send_messages === false);
    if (['kicked', 'left'].includes(member.status) || barred) return () => { this.subs.pause(chat.id); return null; };
    if (['member', 'administrator', 'creator', 'restricted'].includes(member.status)) return () => { this.subs.resume(chat.id); return null; };
    return () => null;
  }
  context(chat, message) {
    let admin;
    return {
      config: this.config, rpc: this.rpc, username: this.username, clean: this.clean, head: this.head, spec: this.identity?.spec,
      names: this.names, prices: this.prices, topic: Number.isSafeInteger(message?.message_thread_id) ? message.message_thread_id : 0,
      signal: this.signal, subs: this.subs, tokens: this.tokens, fmt: this.fmt, chat,
      admin: (user) => (admin ??= this.isAdmin(chat, message, user)),
    };
  }
  /** Admin means getChatMember says creator or administrator; a message posted as the group itself counts too. */
  async isAdmin(chat, message, user) {
    if (chat.type === 'private') return true;
    if (!user && message?.sender_chat?.id === chat.id) return true;
    const id = (user ?? message?.from)?.id;
    if (!Number.isSafeInteger(id)) return false;
    try {
      const member = await this.tg.call('getChatMember', { chat_id: chat.id, user_id: id });
      return ADMINS.has(member?.status);
    } catch (error) {
      if (error instanceof TelegramRefused) return false;
      throw error;
    }
  }

  // ---- replies -------------------------------------------------------------------------------------------

  async respond(out) {
    if (out.callback === undefined) return this.reply(out);
    if (typeof out.callback === 'string') {
      try { await this.tg.call('answerCallbackQuery', { callback_query_id: out.callback, ...(out.answer ? { text: String(out.answer).slice(0, 200) } : {}) }); }
      catch (error) { if (!(error instanceof TelegramRefused)) throw error; } // too old to answer
    }
    if (out.edit && Number.isSafeInteger(out.edit.message_id)) {
      try {
        await this.tg.call('editMessageText', { chat_id: out.edit.chat_id, message_id: out.edit.message_id, text: messages(out.edit.lines)[0],
          parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: out.edit.keyboard ?? [] } });
      } catch (error) { if (!(error instanceof TelegramRefused)) throw error; } // "message is not modified", or gone
    }
    if (out.reply) await this.reply(out.reply);
  }
  async reply({ chat_id, message_thread_id, lines = [], messages: parts = messages(lines), keyboard }) {
    for (const [i, text] of parts.entries()) {
      const markup = i === parts.length - 1 && keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {};
      if (!(await this.send(chat_id, text, { message_thread_id, ...markup })).message) break;
    }
  }
  /**
   * sendMessage with round 2's rules: a 403 pauses the chat, and so does a 400 saying the bot may not write
   * there (restricted, or the chat is gone), so that its alerts wait instead of being dropped; a migration
   * moves the chat's data and resends to the new id; any other refusal is logged and skipped. Returns
   * { message, chatId }, { blocked } or { refused }.
   */
  async send(chatId, text, extra = {}) {
    const block = () => {
      this.store.transaction(() => this.subs.pause(chatId));
      return { blocked: true };
    };
    for (let hop = 0; hop < 2; hop++) {
      try {
        const message = await this.tg.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
        if (message === null) return block();
        this.counts.sent++;
        return { message, chatId };
      } catch (error) {
        if (!(error instanceof TelegramRefused)) throw error;
        const to = error.migratedTo;
        if (to !== null && to !== chatId && hop === 0) {
          this.store.transaction(() => this.subs.migrate(chatId, to));
          chatId = to;
          continue;
        }
        if (error.code === 400 && NO_WRITE.test(error.description)) return block();
        log('warn', `Telegram refused a message (${error.code}).`);
        return { refused: true };
      }
    }
    return { refused: true };
  }

  // ---- alerts --------------------------------------------------------------------------------------------

  async background() {
    if (!this.head) return;
    await this.scan();
    await this.trackPass();
    const now = this.head.timestamp;
    this.store.transaction(() => { this.ledger.prune(now); this.subs.prune(now); this.tokens.prune(now); this.rate.prune(now); });
  }
  /** The next range: alerts found in it are saved as pending in the transaction that moves the cursor. */
  async scan() {
    const cursor = this.store.cursor;
    const range = cursor === null ? null : this.scanner.next(cursor, this.head.block_number);
    this.behind = false;
    if (!range) return;
    const interests = this.subs.interests();
    const context = { config: this.config, head: this.head, names: this.names, prices: this.prices, interests, tokens: this.tokens, rpc: this.rpc, now: this.head.timestamp, fmt: this.fmt };
    const found = { deliveries: [], seen: [] };
    try {
      const feeds = this.subs.feeds();
      const rawTokens = !interests.empty || feeds.length ? await this.scanner.events(range, TOKEN_EVENTS) : [];
      if (!interests.empty) {
        const result = await walletAlerts.find(rawTokens, context);
        found.deliveries.push(...result.deliveries);
        found.seen.push(...result.seen);
      }
      if (feeds.length) {
        const swaps = [];
        for (const v of VENUES) if (this.config.contracts[v.key]) {
          swaps.push(...await this.scanner.events(range, { address: this.config.contracts[v.key], keys: [[v.selector]] }));
        }
        found.deliveries.push(...await tradeAlerts(swaps, rawTokens, feeds, context));
      }
      found.deliveries.sort((a, b) => a.block - b.block);
    } catch (error) {
      if (this.signal.aborted || !retriable(error)) throw error;
      log('warn', `node busy: blocks ${range.from} to ${range.to} will be scanned again.`);
      return;
    }
    this.store.transaction(() => {
      for (const delivery of found.deliveries) this.ledger.add(delivery);
      for (const [chatId, address, token] of found.seen) this.subs.noteSeen(chatId, address, token);
      this.store.cursor = range.to;
    });
    this.behind = range.to < this.head.block_number;
  }
  async trackPass() {
    for (const track of this.subs.allTracks()) {
      let step;
      try { step = await trackStep(track, { rpc: this.rpc, head: this.head, fmt: this.fmt }); }
      catch (error) {
        if (this.signal.aborted || !retriable(error)) throw error;
        log('warn', 'node busy: tracked transactions will be checked again.');
        return;
      }
      if (!step) continue;
      this.store.transaction(() => {
        if (step.delivery) this.ledger.add(step.delivery);
        if (step.stage === 'done') this.subs.trackDone(track.id);
        else this.subs.trackStage(track.id, step.stage);
      });
    }
  }
  /** Pending alerts, oldest first, skipping chats that are paused or were blocked during this pass. */
  async deliver() {
    this.store.transaction(() => this.ledger.summarize(this.fmt));
    const sentTo = new Map(), blocked = new Set(), moved = new Map();
    for (const row of this.ledger.pending()) {
      if (this.signal.aborted) return;
      const chatId = moved.get(row.chat_id) ?? row.chat_id;
      if (blocked.has(chatId)) continue;
      const count = sentTo.get(chatId) ?? 0;
      sentTo.set(chatId, count + 1);
      const r = await this.send(chatId, row.body, { ...(row.topic ? { message_thread_id: row.topic } : {}), ...(count >= LOUD_ALERTS ? { disable_notification: true } : {}) });
      if (r.message) {
        if (r.chatId !== chatId) moved.set(row.chat_id, r.chatId);
        this.store.transaction(() => this.ledger.sent(row.seq, r.message.message_id));
        this.counts.alerts++;
      } else if (r.refused) this.store.transaction(() => this.ledger.dropped(row.seq));
      else blocked.add(chatId);
    }
  }
}
