import { performance } from 'node:perf_hooks';
import { walletAlerts } from './alerts.mjs';
import { callback, COMMANDS, parseCommand, parsePaste, respond } from './commands.mjs';
import { CairnError, log, NodeBusy, RpcError, TelegramDown, TelegramRefused } from './errors.mjs';
import { decodeChain, hex64, NodeValueError } from './felt.mjs';
import { links, messages, redactor, short, textLines } from './format.mjs';
import { holdsListedLink, holdsSeed, warning } from './guard.mjs';
import { prometheus, serveHttp } from './http.mjs';
import { Ledger } from './ledger.mjs';
import { NetworkWatch, noticeText } from './network.mjs';
import { Names } from './names.mjs';
import { Prices } from './prices.mjs';
import { RateLimit } from './rate.mjs';
import { Blocks, findFork } from './reorg.mjs';
import { blockHeaders, Scanner } from './scanner.mjs';
import { Store } from './store.mjs';
import { Subscriptions } from './subscriptions.mjs';
import { plan, summarise } from './summary.mjs';
import { Tokens } from './tokens.mjs';
import { trackStep } from './tracks.mjs';
import { tradeFeed } from './trades.mjs';
import { Rpc, Telegram, sleep } from './transport.mjs';
import { VENUES, venuesOf } from './venues.mjs';

// Round 4 reads edited messages too, for the guards only: a phrase edited into a message is removed as well.
const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'my_chat_member'];
const ADMINS = new Set(['creator', 'administrator']);
const LOUD_ALERTS = 3; // alerts per private chat and pass with a notification; later ones in the same pass arrive silently
/** A 400 that means the bot may not write to the chat for now, rather than that one message was bad. */
const NO_WRITE = /not enough rights|have no rights|chat not found/i;
/** A 400 about the forum topic itself (deleted or closed): the message goes to the chat's main thread instead. */
const NO_TOPIC = /thread|topic/i;
/** The network file's contracts as alerts name them, in place of a short address. */
const CONTRACT_NAMES = { pragma: 'Pragma oracle', naming: 'Starknet ID naming', ...Object.fromEntries(VENUES.map((v) => [v.contract, v.label])) };
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
  try {
    identity = await handshake(rpc, config, clean);
    await rpc.verifyAll(); // round 4: a fallback on another chain exits 2 now, not when it is first needed
  }
  catch (error) {
    if (signal.aborted || (error instanceof CairnError && error.exitCode === 2)) throw error;
    if (config.mode === 'doctor' && !identity) throw error;
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
 *
 * Round 4 adds no loop of its own. The head read feeds the network watch (stalls, recoveries, outages); the
 * scan first checks the cursor block's hash and, after a reorg, rewinds the cursor and corrects the ledger, then
 * keeps CAIRN_CONFIRMATIONS and CAIRN_MAX_GAP; every update passes the guards before it is a command; and every
 * notice is a ledger row that deliver() sends like an alert. /healthz and /metrics only read this state.
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
    this.network = new NetworkWatch(o.store, o.config);
    this.blocks = new Blocks(o.store, o.config.reorgDepth);
    this.head = null;
    this.rpcOk = true; // false while every endpoint fails the head read
    this.telegramOk = true; // false while getUpdates fails (run keeps trying)
    this.behind = false; // the last scan stopped below the head: the next pass comes at once
    this.wake = false; // a new track wants its first stage without waiting for the next pass
    this.budget = { start: -Infinity, used: new Map() }; // messages per group in the current pass
    this.counts = { updates: 0, sent: 0, alerts: 0, notices: 0, corrections: 0, reorgs: 0, stalls: 0, skipped: 0,
      guarded: { seed: 0, links: 0 }, undeleted: 0, telegramErrors: 0 };
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
  /**
   * A pass every CAIRN_POLL_MS, long-polling Telegram in between; back to back while catching up. With
   * CAIRN_HTTP_PORT set it serves /healthz and /metrics. Telegram trouble (unreachable, 5xx) no longer ends the
   * process: /healthz says "telegram" and the loop tries again with backoff, up to 30 s.
   */
  async run() {
    const http = this.config.httpPort === null ? null : await serveHttp(this.config, { health: () => this.health(), metrics: () => this.metrics() });
    try {
      let due = 0, backoff = 0;
      while (!this.signal.aborted) {
        try {
          due = await this.cycle(due);
          backoff = 0;
        } catch (error) {
          if (this.signal.aborted || !(error instanceof TelegramDown)) throw error;
          this.telegramOk = false;
          this.counts.telegramErrors++;
          backoff = Math.min(30_000, Math.max(1000, backoff * 2));
          log('warn', `Telegram unavailable; trying again in ${backoff / 1000} s.`);
          await sleep(backoff, this.signal);
        }
      }
    } finally { http?.close(); }
  }
  async cycle(due) {
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
    return due;
  }

  async readHead() {
    const now = Date.now();
    try {
      this.identity ??= await handshake(this.rpc, this.config, this.clean);
      const block = await this.rpc.call('starknet_getBlockWithTxHashes', { block_id: 'latest' });
      if (!Number.isSafeInteger(block?.block_number) || block.block_number < 0 || !Number.isSafeInteger(block.timestamp)) throw new Error('invalid header');
      this.head = block;
      this.rpcOk = true;
      this.store.transaction(() => {
        // The first head ever read (less CAIRN_CONFIRMATIONS) becomes the cursor: Cairn never backfills.
        if (this.store.cursor === null) {
          const start = Math.max(0, block.block_number - this.config.confirmations);
          this.store.cursor = start;
          if (start === block.block_number && block.block_hash !== undefined) this.blocks.record([{ number: start, hash: hex64(block.block_hash) }], start);
        }
        this.notify(this.network.observe(block, now));
      });
    } catch (error) {
      if (this.signal.aborted || (error instanceof CairnError && error.exitCode === 2)) throw error;
      this.head = null;
      this.rpcOk = false;
      log('warn', 'node busy: latest header unavailable.');
      // Every endpoint failed: the operator hears it once per outage; subscribers are not told.
      if (error instanceof NodeBusy) this.store.transaction(() => this.notify([this.network.failed(now)].filter(Boolean)));
    }
  }
  /**
   * Files network notices as ledger rows, keyed by what they report so that none is sent twice: a stall to the
   * chats with network alerts on, its recovery to those that got the stall, a skipped gap to every chat it cost
   * alerts, and outages and deep reorgs to CAIRN_OPERATOR_CHAT only.
   */
  notify(notices) {
    const operator = this.config.operatorChat === null ? [] : [{ chat_id: this.config.operatorChat, thread_id: null }];
    for (const n of notices) {
      let to, key, index = 0;
      switch (n.kind) {
        case 'stall': to = this.subs.networkChats(); key = `stall:${n.key}`; this.counts.stalls++; break;
        case 'resumed': {
          const on = new Set(this.subs.networkChats().map((c) => c.chat_id));
          to = this.ledger.recipients(`stall:${n.key}`, 0).filter((c) => on.has(c.chat_id)); key = `stall:${n.key}`; index = 1; break;
        }
        case 'gap': to = this.subs.affectedChats(); key = `gap:${n.from}`; break;
        case 'rpc-down': to = operator; key = `rpc:${n.key}`; log('warn', 'every RPC endpoint is failing.'); break;
        case 'rpc-back': to = operator; key = `rpc:${n.key}`; index = 1; log('info', 'RPC recovered.'); break;
        case 'deep-reorg': to = operator; key = `reorg:${n.from}`; log('warn', `reorg deeper than CAIRN_REORG_DEPTH: rescanning from block ${n.from}.`); break;
        default: continue;
      }
      const body = noticeText(n, { endpoints: this.rpc.endpoints.length, stallSeconds: this.config.stallSeconds });
      for (const c of to) {
        this.ledger.add({ chatId: c.chat_id, txHash: key, eventIndex: index, kind: 'network', chainTime: n.time ?? this.network.chainTime, body, thread: c.thread_id ?? null });
      }
    }
  }
  async poll(timeout) {
    const batch = await this.tg.call('getUpdates', { offset: this.store.offset, limit: 100, timeout, allowed_updates: ALLOWED_UPDATES });
    if (!Array.isArray(batch)) throw new CairnError('Telegram returned invalid updates.');
    this.telegramOk = true;
    return batch;
  }

  // ---- updates ---------------------------------------------------------------------------------------

  async handle(update) {
    if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) throw new CairnError('Telegram returned an invalid update id.');
    if (update.update_id < this.store.offset) return;
    let commit = () => null;
    if (update.message) commit = await this.onMessage(update.message);
    else if (update.edited_message) commit = await this.onMessage(update.edited_message, true);
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
  async onMessage(message, edited = false) {
    const chat = message?.chat;
    if (!Number.isSafeInteger(chat?.id)) return () => null;
    // Round 4: the guards come first; a message they remove is never read as a command.
    const guarded = await this.guard(message);
    if (guarded) return () => { this.subs.resume(chat.id); return guarded; };
    if (edited) return () => null;
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
  /**
   * Round 4's guards: a message holding a BIP-39 phrase, or a link under a blocklisted domain, is deleted and
   * replaced by a warning that repeats none of it. Without the right to delete, the warning names the right.
   * Nothing of the message is kept, logged or counted beyond its kind.
   */
  async guard(message) {
    const text = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : '';
    if (!text || message.from?.id === this.me.id) return null;
    const on = this.subs.guards(message.chat.id);
    const kind = on.seed && holdsSeed(text) ? 'seed'
      : on.links && holdsListedLink(text, message.entities ?? message.caption_entities, this.config.blocklist) ? 'links' : null;
    if (!kind) return null;
    let deleted = false;
    try { deleted = (await this.tg.call('deleteMessage', { chat_id: message.chat.id, message_id: message.message_id })) === true; }
    catch (error) { if (!(error instanceof TelegramRefused)) throw error; } // no right to delete, or already gone
    this.counts.guarded[kind]++;
    if (!deleted) this.counts.undeleted++;
    log('info', `guard: ${kind === 'seed' ? 'a recovery phrase' : 'a blocklisted link'} ${deleted ? 'deleted' : 'found, but Telegram refused to delete it'}.`);
    const group = message.chat.type !== 'private';
    return { chat_id: message.chat.id, ...(Number.isSafeInteger(message.message_thread_id) ? { message_thread_id: message.message_thread_id } : {}),
      lines: warning(kind, deleted, group).split('\n') };
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
      // The forum topic a command came from: a feed, watch, whale or track set up there posts there. A reply in
      // an ordinary group (or a comment thread) also carries a message_thread_id, which subscriptions ignore.
      thread: Number.isSafeInteger(message?.message_thread_id) && (message.is_topic_message === true || !message.reply_to_message)
        ? message.message_thread_id : null,
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
   *
   * Round 4, before the range: a reorg rewinds the cursor to the common ancestor (see rewind), and a gap above
   * CAIRN_MAX_GAP is skipped with one notice. The range ends CAIRN_CONFIRMATIONS below the head. After it, the
   * hashes of its blocks near the head are kept for the next check, once they are seen to chain onto the
   * stored ones and to match the events read: a chain that changed during the scan leaves the cursor.
   */
  async scan() {
    this.behind = false;
    let cursor = this.store.cursor;
    if (cursor === null) return;
    const header = blockHeaders(this.rpc), safe = this.head.block_number - this.config.confirmations;
    try {
      const fork = await findFork(this.blocks, cursor, this.head, header);
      if (fork) cursor = await this.rewind(fork);
      if (this.config.maxGap > 0 && safe - cursor > this.config.maxGap) return await this.skip(cursor, safe, header);
    } catch (error) {
      if (this.signal.aborted || !retriable(error)) throw error;
      log('warn', 'node busy: the reorg check will run again.');
      return;
    }
    const range = this.scanner.next(cursor, safe);
    if (!range) return;
    const interests = this.subs.interests();
    const feeds = this.feeds.filter((f) => f.wanted(interests));
    this.prices.horizon(range.from, range.to);
    const context = { interests, tokens: this.tokens, rpc: this.rpc, now: this.head.timestamp, fmt: this.fmt,
      header, prices: this.prices, names: this.names, known: this.known };
    const found = { deliveries: [], seen: [] }, kept = [];
    try {
      const events = new Map();
      for (const filter of new Set(feeds.flatMap((f) => f.filters))) events.set(filter, await this.scanner.events(range, filter));
      for (const feed of feeds) {
        const result = await feed.find(events, context);
        found.deliveries.push(...result.deliveries);
        found.seen.push(...(result.seen ?? []));
      }
      // The blocks the next reorg check needs: the last CAIRN_REORG_DEPTH below the safe head, or only the
      // range's last block while catching up far below it.
      for (let n = Math.max(range.from, Math.min(range.to, safe - this.config.reorgDepth + 1)); n <= range.to; n++) kept.push(await header(n));
      if (!this.continuous(cursor, kept, events)) {
        log('warn', `the chain changed during the scan: blocks ${range.from} to ${range.to} will be scanned again.`);
        return;
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
      this.blocks.record(kept, range.to);
      this.store.cursor = range.to;
    });
    this.behind = range.to < safe;
  }
  /** Whether the kept headers chain onto each other and onto the stored cursor block, and match the events' hashes. */
  continuous(cursor, kept, events) {
    const byNumber = new Map(kept.map((h) => [h.number, h]));
    for (const [i, h] of kept.entries()) {
      const below = i > 0 ? kept[i - 1].hash : h.number === cursor + 1 ? this.blocks.hash(cursor) : null;
      if (below !== null && h.parent !== null && h.parent !== below) return false;
    }
    for (const list of events.values()) {
      for (const e of list) {
        const h = byNumber.get(e.block_number);
        if (h?.hash && e.block_hash !== undefined && hex64(e.block_hash) !== h.hash) return false;
      }
    }
    return true;
  }
  /**
   * A reorg: the node's chain left Cairn's after `ancestor`. Each alert and trade the ledger holds for the
   * replaced blocks is looked up again: one the node no longer finds is orphaned and, when the chat saw it, gets
   * one correction replying to it; one the node finds again (re-included) keeps its key, moved to its new block,
   * so the rescan sends nothing more. Then the cursor goes back to the ancestor, and this pass rescans from there:
   * the replacement blocks' new events are alerted once, in chain order. Returns the new cursor.
   */
  async rewind({ ancestor, deep }) {
    const rows = this.ledger.after(ancestor), where = new Map();
    for (const tx of new Set(rows.map((r) => r.tx_hash))) {
      try {
        const receipt = await this.rpc.call('starknet_getTransactionReceipt', { transaction_hash: tx });
        // Re-included but reverted: its transfers did not happen, so the alert is corrected like an orphan.
        where.set(tx, receipt?.execution_status === 'REVERTED' ? 'gone'
          : Number.isSafeInteger(receipt?.block_number) ? receipt.block_number : null);
      } catch (error) {
        if (!(error instanceof RpcError && error.code === 29)) throw error;
        where.set(tx, 'gone');
      }
    }
    this.store.transaction(() => {
      for (const row of rows) {
        const block = where.get(row.tx_hash);
        if (block === 'gone') {
          const body = `↩️ <b>Correction</b>: a chain reorganisation replaced block ${row.block}, and transaction <code>${short(row.tx_hash)}</code> is no longer on the chain (or now reverts). ` +
            'Disregard the alert this replies to. If the transaction is included again, Cairn posts it again.';
          if (this.ledger.orphan(row, { chainTime: this.head.timestamp, body })) this.counts.corrections++;
        } else if (Number.isSafeInteger(block) && block !== row.block) this.ledger.moved(row.seq, block);
      }
      this.blocks.dropAfter(ancestor);
      this.store.cursor = ancestor;
      if (deep) this.notify([{ kind: 'deep-reorg', from: ancestor + 1, depth: this.config.reorgDepth, time: this.head.timestamp }]);
    });
    this.counts.reorgs++;
    log('warn', `reorg: the chain changed after block ${ancestor}; rescanning from block ${ancestor + 1}.`);
    return ancestor;
  }
  /** More than CAIRN_MAX_GAP blocks behind: jump to the safe head, with one notice per chat the gap costs alerts. */
  async skip(cursor, safe, header) {
    const top = safe === this.head.block_number ? { number: safe, hash: this.head.block_hash === undefined ? null : hex64(this.head.block_hash) } : await header(safe);
    this.store.transaction(() => {
      this.blocks.dropAfter(-1);
      this.blocks.record([top], safe);
      this.store.cursor = safe;
      this.notify([{ kind: 'gap', from: cursor + 1, to: safe, behind: safe - cursor, max: this.config.maxGap, time: this.head.timestamp }]);
    });
    this.counts.skipped += safe - cursor;
    log('warn', `skipped blocks ${cursor + 1} to ${safe} (more than CAIRN_MAX_GAP behind).`);
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
    for (const [chatId, all] of byChat) {
      if (this.signal.aborted) return;
      // Round 4: network notices and corrections go first and outside the group budget; a correction replies
      // to the alert it corrects.
      let target = chatId, open = true;
      for (const row of all.filter(urgent)) {
        if (this.signal.aborted) return;
        const reply = Number.isSafeInteger(row.reply_to) ? { reply_parameters: { message_id: row.reply_to, allow_sending_without_reply: true } } : {};
        const r = await this.send(target, row.body, { ...topic(row.thread_id), ...reply });
        if (r.message) {
          target = r.chatId;
          this.store.transaction(() => this.ledger.sent(row.seq, r.message.message_id));
          this.counts.notices++;
        } else if (r.refused) this.store.transaction(() => this.ledger.dropped(row.seq));
        else { open = false; break; }
      }
      const rows = all.filter((row) => !urgent(row));
      if (!open || !rows.length) continue;
      const used = this.budget.used.get(target) ?? 0;
      const { full, rest } = plan(rows, rows[0].type, used);
      let sent = 0;
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

  // ---- operations (round 4) --------------------------------------------------------------------------------

  /** /healthz: 200 { ok, head, lag_s } (lag_s: wall clock less the head's timestamp), or 503 { ok: false, reason }. */
  health() {
    const now = Date.now();
    if (!this.rpcOk) return { ok: false, reason: 'rpc' };
    if (!this.telegramOk) return { ok: false, reason: 'telegram' };
    if (!this.head) return { ok: false, reason: 'rpc' }; // no head read yet
    const head = this.head.block_number, lag_s = Math.max(0, Math.round(now / 1000 - this.head.timestamp));
    if (this.network.stalled(now)) return { ok: false, reason: 'stalled', head, lag_s };
    return { ok: true, head, lag_s };
  }
  /** /metrics: this process's counters since it started, and the head it last read. */
  metrics() {
    const c = this.counts, rpc = this.rpc.stats, healthy = this.health().ok;
    return prometheus([
      { name: 'cairn_head_block', type: 'gauge', help: 'Latest Starknet block number read.', value: this.head?.block_number ?? null },
      { name: 'cairn_head_lag_seconds', type: 'gauge', help: 'Wall clock less the latest block timestamp.', value: this.head ? Math.max(0, Date.now() / 1000 - this.head.timestamp) : null },
      { name: 'cairn_cursor_block', type: 'gauge', help: 'Last block scanned for alerts.', value: this.store.cursor },
      { name: 'cairn_healthy', type: 'gauge', help: '1 when /healthz answers 200.', value: healthy ? 1 : 0 },
      { name: 'cairn_updates_total', type: 'counter', help: 'Telegram updates handled.', value: c.updates },
      { name: 'cairn_messages_sent_total', type: 'counter', help: 'Messages Telegram accepted.', value: c.sent },
      { name: 'cairn_alerts_total', type: 'counter', help: 'Alerts, trades and track updates delivered.', value: c.alerts },
      { name: 'cairn_notices_total', type: 'counter', help: 'Network notices and reorg corrections delivered.', value: c.notices },
      { name: 'cairn_rpc_requests_total', type: 'counter', help: 'Starknet RPC requests sent.', value: rpc.requests },
      { name: 'cairn_rpc_errors_total', type: 'counter', help: 'Starknet RPC requests that failed (connection, timeout, HTTP error, malformed).', value: rpc.errors },
      { name: 'cairn_rpc_failovers_total', type: 'counter', help: 'Switches to another RPC endpoint.', value: rpc.failovers },
      { name: 'cairn_rpc_endpoint', type: 'gauge', help: 'The RPC endpoint in use (1 is the first of STARKNET_RPC_URLS).', value: this.rpc.answered + 1 },
      { name: 'cairn_telegram_errors_total', type: 'counter', help: 'Times Telegram was unreachable or failing.', value: c.telegramErrors },
      { name: 'cairn_reorgs_total', type: 'counter', help: 'Reorgs handled.', value: c.reorgs },
      { name: 'cairn_corrections_total', type: 'counter', help: 'Corrections queued for orphaned alerts.', value: c.corrections },
      { name: 'cairn_stalls_total', type: 'counter', help: 'Stalls reported.', value: c.stalls },
      { name: 'cairn_skipped_blocks_total', type: 'counter', help: 'Blocks skipped over CAIRN_MAX_GAP.', value: c.skipped },
      { name: 'cairn_guard_removals_total', type: 'counter', help: 'Messages the guards caught.', value: Object.entries(c.guarded).map(([guard, value]) => ({ labels: { guard }, value })) },
      { name: 'cairn_guard_undeleted_total', type: 'counter', help: 'Caught messages Telegram refused to delete.', value: c.undeleted },
    ]);
  }
}

/** Ledger rows sent before alerts and outside a group's budget: network notices and reorg corrections. */
const urgent = (row) => row.kind === 'network' || row.kind === 'correction';
/** sendMessage's forum topic, when there is one. */
const topic = (thread) => (Number.isSafeInteger(thread) ? { message_thread_id: thread } : {});
/** The value most rows share (the first one on a tie): a summary posts into the topic most of its alerts came from. */
function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
}
