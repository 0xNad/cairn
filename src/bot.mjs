import { performance } from 'node:perf_hooks';
import { walletAlerts } from './alerts.mjs';
import { callback, COMMANDS, parseCommand, parsePaste, respond } from './commands.mjs';
import { CairnError, log, NodeBusy, RpcError, TelegramRefused } from './errors.mjs';
import { decodeChain, NodeValueError } from './felt.mjs';
import { links, messages, redactor, textLines } from './format.mjs';
import { Ledger } from './ledger.mjs';
import { Names } from './names.mjs';
import { Prices } from './prices.mjs';
import { RateLimit } from './rate.mjs';
import { blockHeaders, Scanner } from './scanner.mjs';
import { Store } from './store.mjs';
import { Subscriptions } from './subscriptions.mjs';
import { plan, summarise } from './summary.mjs';
import { Tokens } from './tokens.mjs';
import { trackStep } from './tracks.mjs';
import { tradeFeed } from './trades.mjs';
import { Rpc, Telegram, sleep } from './transport.mjs';
import { venuesOf } from './venues.mjs';

const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'];
const ADMINS = new Set(['creator', 'administrator']);
const LOUD_ALERTS = 3; // alerts per private chat and pass with a notification; later ones in the same pass arrive silently
/** A 400 that means the bot may not write to the chat for now, rather than that one message was bad. */
const NO_WRITE = /not enough rights|have no rights|chat not found/i;
/** A 400 about the forum topic itself (deleted or closed): the message goes to the chat's main thread instead. */
const NO_TOPIC = /thread|topic/i;
/** The network file's contracts as alerts name them, in place of a short address. */
const CONTRACT_NAMES = { avnu_exchange: 'AVNU exchange', ekubo_core: 'Ekubo Core', pragma: 'Pragma oracle', naming: 'Starknet ID naming' };
/** Ledger rows in chain order: block, then transaction, then event. */
const chainOrder = (a, b) => a.position[0] - b.position[0] || a.position[1] - b.position[1] || a.position[2] - b.position[2];
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
 * scan the next range for alerts and trades and step the tracked transactions, saving what they find as
 * pending; then deliver the pending alerts, each marked sent only once Telegram accepts it, within each
 * group's budget.
 */
class Bot {
  constructor(o) {
    Object.assign(this, o);
    this.subs = new Subscriptions(o.store, o.config);
    this.ledger = new Ledger(o.store);
    this.tokens = new Tokens(o.config, o.store, o.rpc);
    this.rate = new RateLimit(o.store);
    this.scanner = new Scanner(o.rpc, o.config);
    this.fmt = links(o.config, o.clean);
    this.venues = venuesOf(o.config);
    /** What the scanner reads from each range: round 2's wallet alerts and round 3's trade feed. */
    this.feeds = [walletAlerts, tradeFeed(this.venues)];
    this.prices = new Prices(o.config, o.rpc);
    this.names = new Names(o.config, o.store, o.rpc);
    this.known = new Map(Object.entries(o.config.contracts).map(([key, address]) => [address, CONTRACT_NAMES[key]]));
    this.head = null;
    this.behind = false; // the last scan stopped below the head: the next pass comes at once
    this.wake = false; // a new track wants its first stage without waiting for the next pass
    this.budget = { start: -Infinity, used: new Map() }; // messages per group in the current pass
    this.counts = { updates: 0, sent: 0, alerts: 0 };
  }

  /**
   * A new pass: prices and names are read again, and each group's budget starts over. Passes that run back to
   * back while catching up share one budget until CAIRN_POLL_MS has passed, so a backlog never floods a group.
   */
  newPass() {
    this.prices.reset();
    this.names.reset();
    const now = performance.now();
    if (now - this.budget.start >= this.config.pollMs) this.budget = { start: now, used: new Map() };
  }

  async tick() {
    this.newPass();
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
        this.newPass();
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
      signal: this.signal, subs: this.subs, tokens: this.tokens, fmt: this.fmt, chat,
      prices: this.prices, names: this.names, venues: this.venues,
      // The forum topic a command came from: a feed, watch, whale or track set up there posts there.
      thread: Number.isSafeInteger(message?.message_thread_id) ? message.message_thread_id : null,
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
   * moves the chat's data and resends to the new id; a forum topic that is gone sends to the chat's main
   * thread instead; any other refusal is logged and skipped. Returns { message, chatId }, { blocked } or
   * { refused }.
   */
  async send(chatId, text, extra = {}) {
    const block = () => {
      this.store.transaction(() => this.subs.pause(chatId));
      return { blocked: true };
    };
    let migrated = false;
    for (let hop = 0; hop < 3; hop++) {
      try {
        const message = await this.tg.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
        if (message === null) return block();
        this.counts.sent++;
        return { message, chatId };
      } catch (error) {
        if (!(error instanceof TelegramRefused)) throw error;
        const to = error.migratedTo;
        if (to !== null && to !== chatId && !migrated) {
          this.store.transaction(() => this.subs.migrate(chatId, to));
          chatId = to;
          migrated = true;
          continue;
        }
        if (error.code === 400 && extra.message_thread_id !== undefined && NO_TOPIC.test(error.description)) {
          const { message_thread_id: _gone, ...rest } = extra;
          extra = rest;
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
    this.store.transaction(() => {
      this.ledger.prune(now); this.subs.prune(now); this.tokens.prune(now); this.rate.prune(now); this.names.prune(now);
    });
  }
  /**
   * The next range: each filter the subscribed feeds need is read once, whichever feeds share it (the trade
   * feed reads its traders from the wallet alerts' chain-wide Transfer filter), and a feed nobody subscribes to
   * reads nothing. What the feeds find is saved as pending, in chain order, in the transaction that moves the
   * cursor; a failed read leaves the cursor, and the next pass reads the whole range again.
   */
  async scan() {
    const cursor = this.store.cursor;
    const range = cursor === null ? null : this.scanner.next(cursor, this.head.block_number);
    this.behind = false;
    if (!range) return;
    const interests = this.subs.interests();
    const feeds = this.feeds.filter((f) => f.wanted(interests));
    const context = { interests, tokens: this.tokens, rpc: this.rpc, now: this.head.timestamp, fmt: this.fmt,
      header: blockHeaders(this.rpc), prices: this.prices, names: this.names, known: this.known };
    const found = { deliveries: [], seen: [] };
    try {
      const events = new Map();
      for (const filter of new Set(feeds.flatMap((f) => f.filters))) events.set(filter, await this.scanner.events(range, filter));
      for (const feed of feeds) {
        const result = await feed.find(events, context);
        found.deliveries.push(...result.deliveries);
        found.seen.push(...(result.seen ?? []));
      }
    } catch (error) {
      if (this.signal.aborted || !retriable(error)) throw error;
      log('warn', `node busy: blocks ${range.from} to ${range.to} will be scanned again.`);
      return;
    }
    found.deliveries.sort(chainOrder);
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
  /**
   * Pending alerts, oldest first, chat by chat, skipping chats that are paused or were blocked during this pass.
   * A group gets at most 3 of them per pass: when more are due, 2 are sent and the third summarises the rest,
   * which the summary then delivers. Each alert posts into the forum topic its subscription was set up in.
   */
  async deliver() {
    const byChat = new Map();
    for (const row of this.ledger.pending()) (byChat.get(row.chat_id) ?? byChat.set(row.chat_id, []).get(row.chat_id)).push(row);
    for (const [chatId, rows] of byChat) {
      if (this.signal.aborted) return;
      const used = this.budget.used.get(chatId) ?? 0;
      const { full, rest } = plan(rows, rows[0].type, used);
      let target = chatId, sent = 0, open = true;
      for (const row of full) {
        if (this.signal.aborted) return;
        const r = await this.send(target, row.body, { ...topic(row.thread_id), ...(sent >= LOUD_ALERTS ? { disable_notification: true } : {}) });
        if (r.message) {
          target = r.chatId;
          sent++;
          this.store.transaction(() => this.ledger.sent(row.seq, r.message.message_id));
          this.counts.alerts++;
        } else if (r.refused) this.store.transaction(() => this.ledger.dropped(row.seq));
        else { open = false; break; } // blocked: the chat's alerts wait until it writes again
      }
      if (open && rest.length && !this.signal.aborted) {
        const r = await this.send(target, summarise(rest, this.fmt), { ...topic(mostCommon(rest.map((row) => row.thread_id))), disable_notification: true });
        if (r.message) {
          sent++;
          this.store.transaction(() => { for (const row of rest) this.ledger.summarized(row.seq, r.message.message_id); });
          this.counts.alerts += rest.length;
        } else if (r.refused) this.store.transaction(() => { for (const row of rest) this.ledger.dropped(row.seq); });
      }
      this.budget.used.set(target, (this.budget.used.get(target) ?? 0) + sent);
    }
  }
}

/** sendMessage's forum topic, when there is one. */
const topic = (thread) => (Number.isSafeInteger(thread) ? { message_thread_id: thread } : {});
/** The value most rows share (the first one on a tie): a summary posts into the topic most of its alerts came from. */
function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
}
