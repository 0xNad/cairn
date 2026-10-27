import { performance } from 'node:perf_hooks';
import { walletAlerts } from './alerts.mjs';
import { callback, COMMANDS, parseCommand, parsePaste, respond } from './commands.mjs';
import { CairnError, log, NodeBusy, RpcError, TelegramDown, TelegramRefused } from './errors.mjs';
import { decodeChain, hex64, NodeValueError } from './felt.mjs';
import { links, messages, redactor, textLines } from './format.mjs';
import { Guards, warning } from './guards.mjs';
import { listen, prometheus } from './http.mjs';
import { Ledger } from './ledger.mjs';
import { Names } from './names.mjs';
import { Network } from './network.mjs';
import { Prices } from './prices.mjs';
import { RateLimit } from './rate.mjs';
import { because, correction, Forks, standing, verdicts } from './reorg.mjs';
import { blockHeaders, Scanner, TOKEN_EVENTS } from './scanner.mjs';
import { Store } from './store.mjs';
import { Subscriptions } from './subscriptions.mjs';
import { plan, summarise } from './summary.mjs';
import { Tokens } from './tokens.mjs';
import { trackStep } from './tracks.mjs';
import { tradeFeed } from './trades.mjs';
import { Rpc, Telegram, sleep } from './transport.mjs';
import { VENUES, venuesOf } from './venues.mjs';

// Round 4 adds edited messages, which only the guards read: a link edited into an old message is caught too.
const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'my_chat_member'];
const ADMINS = new Set(['creator', 'administrator']);
const LOUD_ALERTS = 3; // alerts per private chat and pass with a notification; later ones in the same pass arrive silently
/** A 400 that means the bot may not write to the chat for now, rather than that one message was bad. */
const NO_WRITE = /not enough rights|have no rights|chat not found/i;
/** A 400 about the forum topic itself (deleted or closed): the message goes to the chat's main thread instead. */
const NO_TOPIC = /thread|topic/i;
/** The network file's contracts as alerts name them, in place of a short address. */
const CONTRACT_NAMES = { pragma: 'Pragma oracle', naming: 'Starknet ID naming', ...Object.fromEntries(VENUES.map((v) => [v.contract, v.label])) };
/** Ledger rows in chain order: block, then transaction, then event; a delivery without a position keeps its place. */
const place = (d) => d.position ?? [d.block ?? 0, 0, d.eventIndex ?? 0];
const chainOrder = (a, b) => place(a)[0] - place(b)[0] || place(a)[1] - place(b)[1] || place(a)[2] - place(b)[2];
const SLOW_DOWN = 'Slow down: Cairn answers at most 10 commands a minute from one person, and ignores the rest until that minute has passed.';
/** Chain failures that leave the work for the next pass. */
const retriable = (error) => error instanceof NodeBusy || error instanceof RpcError || error instanceof NodeValueError;
/** A block header Cairn can use: a number, a hash and a timestamp. */
const validHeader = (block) => Number.isSafeInteger(block?.block_number) && block.block_number >= 0 && Number.isSafeInteger(block.timestamp)
  && typeof block.block_hash === 'string';

/** The chain and spec handshake of one endpoint: a wrong chain or an old spec exits 2, naming what it reported. */
async function handshake(rpc, index, config, clean) {
  const several = rpc.endpoints.length > 1, where = several ? `RPC ${rpc.name(index)}` : 'Node';
  const chain = decodeChain(await rpc.call('starknet_chainId', {}, { endpoint: index }));
  if (chain !== config.chain) {
    throw new CairnError(several
      ? `${where} reports ${clean(chain)}, but CAIRN_CHAIN is ${config.chain}: every endpoint of STARKNET_RPC_URLS must serve the same chain.`
      : `Node reports ${clean(chain)}; expected ${config.chain} (CAIRN_CHAIN).`, 2);
  }
  const spec = await rpc.call('starknet_specVersion', {}, { endpoint: index });
  // A pre-release of a 0.10 spec (0.10.3-rc.0, as one public endpoint reported on 27 Oct 2026) is not below 0.10.0.
  const version = typeof spec === 'string' ? /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]{1,32})?$/.exec(spec) : null;
  if (!version || !(Number(version[1]) > 0 || Number(version[2]) >= 10)) {
    throw new CairnError(`${where} spec ${clean(String(spec).slice(0, 100))} is below 0.10.0 or malformed.`, 2);
  }
  return { chain, spec: clean(spec) };
}
/**
 * doctor's line: the bot, then the chain, head and spec of the first endpoint, and of each one when there are
 * several, with whether it serves the chain-wide event filter every alert comes from (`events`: "ok", or why not).
 */
async function doctor(rpc, username) {
  const rows = [];
  for (const endpoint of rpc.endpoints) {
    const at = { endpoint: endpoint.index };
    let block, events = 'ok';
    try {
      block = await rpc.call('starknet_blockNumber', {}, at);
      if (!Number.isSafeInteger(block) || block < 0) throw new CairnError(`${rpc.name(endpoint.index)} returned an invalid block number.`);
      const range = { from_block: { block_number: Math.max(0, block - 1) }, to_block: { block_number: Math.max(0, block - 1) } };
      try { await rpc.call('starknet_getEvents', { filter: { ...range, ...TOKEN_EVENTS, chunk_size: 1000 } }, at); }
      catch (error) {
        if (!(error instanceof RpcError)) throw error;
        events = `refused (RPC error ${error.code})`;
        log('warn', `${rpc.name(endpoint.index)} refuses the chain-wide event filter (RPC error ${error.code}): alerts and feeds need it, so pick another endpoint.`);
      }
    } catch (error) {
      if (error instanceof NodeBusy) throw new CairnError(`node busy: ${rpc.name(endpoint.index)} did not answer; check the RPC origin or retry later.`);
      throw error;
    }
    rows.push({ endpoint: endpoint.index + 1, ...endpoint.identity, block, events });
  }
  const [first] = rows;
  return { bot: username, chain: first.chain, block: first.block, spec: first.spec, events: first.events, ...(rows.length > 1 ? { endpoints: rows } : {}) };
}

export async function serve(config, signal) {
  const clean = redactor(config), rpc = new Rpc(config, signal), tg = new Telegram(config, signal);
  rpc.identifyWith((index) => handshake(rpc, index, config, clean));
  const me = await tg.call('getMe');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(me?.username ?? '')) throw new CairnError('Telegram returned an invalid bot username.');
  const username = clean(me.username);
  // Every endpoint answers the handshake at start, so that one on another chain stops Cairn at once (exit 2); one
  // that cannot be reached now is checked again before its first chain read.
  for (const endpoint of rpc.endpoints) {
    try { await rpc.identify(endpoint.index); }
    catch (error) {
      if (signal.aborted || (error instanceof CairnError && error.exitCode === 2)) throw error;
      const got = error instanceof RpcError ? `RPC error ${error.code}` : error.why ?? 'no usable answer';
      const why = `node busy: ${rpc.name(endpoint.index)} fails the handshake (${got}); check its URL (its path for spec 0.10), its key and its limits`;
      if (config.mode === 'doctor') throw new CairnError(`${why}.`);
      log('warn', `${why}. It is checked again before its first chain read.`);
    }
  }
  if (config.mode === 'doctor') return doctor(rpc, username);
  const store = new Store(config.data);
  try {
    if (config.mode === 'run') await tg.call('deleteWebhook', { drop_pending_updates: false });
    const commandList = JSON.stringify(COMMANDS);
    if (store.get('commands') !== commandList) {
      await tg.call('setMyCommands', { commands: COMMANDS });
      store.transaction(() => store.set('commands', commandList));
    }
    const bot = new Bot({ config, store, rpc, tg, clean, username, me, signal });
    if (config.mode === 'tick') return await bot.tick();
    if (config.httpPort !== null) await listen(config, { health: () => bot.health(), metrics: () => bot.metrics() }, signal);
    return await bot.run();
  } finally { store.close(); }
}

/**
 * One bot process, and one loop. A pass: read the head (with failover across the RPC endpoints) and note it for
 * the stall and outage rules; handle updates, the guards first (a subscription covers the blocks after that head);
 * check that the blocks scanned still stand, rewinding after a reorg; skip a gap longer than CAIRN_MAX_GAP; scan
 * the next confirmed range for alerts and trades and step the tracked transactions, saving what they find as
 * pending; then deliver every pending delivery (alerts, trades, track updates, network notices and corrections),
 * each marked sent only once Telegram accepts it, within each group's budget. /healthz and /metrics read what the
 * passes recorded.
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
    this.network = new Network({ store: o.store, ledger: this.ledger, subs: this.subs, config: o.config });
    this.forks = new Forks(o.store, o.rpc, o.config);
    this.guards = new Guards(o.config);
    this.head = null;
    this.rpcOk = false; // the last head read and scan got their answers
    this.behind = false; // the last scan stopped below the head: the next pass comes at once
    this.wake = false; // a new track wants its first stage without waiting for the next pass
    this.budget = { start: -Infinity, used: new Map() }; // messages per group in the current pass
    this.warned = new Set(); // `${chat} ${guard}` warned in this batch of updates: a flood gets one warning
    this.crossChecked = -Infinity; // when the other endpoints were last asked about a head that stopped moving
    this.counts = { updates: 0, sent: 0, alerts: 0 };
    this.stats = { reorgs: 0, corrections: 0, seed: 0, links: 0 };
  }

  /**
   * A new pass: prices and names are read again, and each group's budget starts over. Passes that run back to
   * back while catching up share one budget until CAIRN_POLL_MS has passed, so a backlog never floods a group.
   */
  newPass() {
    this.prices.reset();
    this.names.reset();
    this.guards.refresh();
    const now = performance.now();
    if (now - this.budget.start >= this.config.pollMs) this.budget = { start: now, used: new Map() };
  }

  async tick() {
    this.newPass();
    await this.readHead();
    for (;;) {
      const batch = await this.poll(0);
      if (!batch.length) break;
      this.warned.clear();
      for (const update of batch) await this.handle(update);
    }
    await this.background();
    await this.deliver();
    await this.tg.call('getUpdates', { offset: this.store.offset, limit: 1, timeout: 0, allowed_updates: ALLOWED_UPDATES });
    return { updates: this.counts.updates, sent: this.counts.sent, head: this.head?.block_number ?? null,
      alerts: this.counts.alerts, cursor: this.store.cursor ?? 0 };
  }
  /**
   * A pass every CAIRN_POLL_MS, long-polling Telegram in between; back to back while catching up. When Telegram
   * cannot be reached, /healthz says so and the loop waits (1 s, doubling to 30 s) and tries again: scanning goes
   * on, and alerts wait in the ledger.
   */
  async run() {
    let due = 0, failures = 0;
    while (!this.signal.aborted) {
      try {
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
        failures = 0;
        if (batch.length) {
          await this.readHead();
          this.warned.clear();
          for (const update of batch) {
            if (this.signal.aborted) break;
            await this.handle(update);
          }
          await this.deliver();
        } else if (timeout === 0 && !this.behind) await sleep(Math.max(1, wait), this.signal);
      } catch (error) {
        if (this.signal.aborted || !(error instanceof TelegramDown)) throw error;
        const pause = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
        log('warn', `${error.message} Next try in ${pause / 1000} s.`);
        await sleep(pause, this.signal);
      }
    }
  }

  /**
   * The head, read from the first endpoint that answers. A head that has not moved for CAIRN_STALL_SECONDS is
   * checked against the other endpoints before it counts as a stall: a node stuck behind is left for one that moves.
   */
  async readHead() {
    const now = Date.now();
    try {
      let block = await this.rpc.call('starknet_getBlockWithTxHashes', { block_id: 'latest' });
      if (!validHeader(block)) throw new NodeValueError();
      if (this.rpc.endpoints.length > 1 && this.network.stalling(block, now)) block = await this.freshest(block);
      this.head = block;
      // /healthz is "rpc" again once nothing waits to be scanned, or once a scan reads its range (scan() says so).
      if (this.store.cursor === null || !this.scanner.next(this.store.cursor, block.block_number - this.config.confirmations)) this.rpcOk = true;
      // The first head ever read sets the cursor (with confirmations, the first safe block): Cairn never backfills.
      if (this.store.cursor === null) this.store.transaction(() => { this.store.cursor = Math.max(0, block.block_number - this.config.confirmations); });
      this.network.observe(block, { now, endpoint: this.rpc.name(this.rpc.current) });
    } catch (error) {
      if (this.signal.aborted || (error instanceof CairnError && error.exitCode === 2)) throw error;
      this.head = null;
      this.rpcOk = false;
      // Every endpoint failed: an outage, which only the operator hears of.
      if (error instanceof NodeBusy) this.network.observe(null, { now, endpoints: this.rpc.endpoints.length });
      log('warn', 'node busy: latest header unavailable.');
    }
  }
  async freshest(block) {
    if (performance.now() - this.crossChecked < this.config.stallSeconds * 1000) return block;
    this.crossChecked = performance.now();
    const stuck = this.rpc.current;
    for (const endpoint of this.rpc.endpoints) {
      if (endpoint.index === stuck) continue;
      let other;
      try { other = await this.rpc.call('starknet_getBlockWithTxHashes', { block_id: 'latest' }, { endpoint: endpoint.index }); }
      catch (error) {
        if (error instanceof NodeBusy || error instanceof RpcError) continue;
        throw error;
      }
      if (validHeader(other) && other.block_number > block.block_number) {
        log('warn', 'rpc endpoint behind', { stuck: this.rpc.name(stuck), at: block.block_number, ahead: this.rpc.name(endpoint.index), head: other.block_number });
        this.rpc.demote(stuck);
        this.rpc.use(endpoint.index);
        return other;
      }
    }
    return block;
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
    if (!edited && Number.isSafeInteger(message.migrate_to_chat_id)) return () => { this.subs.migrate(chat.id, message.migrate_to_chat_id); return null; };
    if (!edited && Number.isSafeInteger(message.migrate_from_chat_id)) return () => { this.subs.migrate(message.migrate_from_chat_id, chat.id); return null; };
    // A chat that writes again gets its pending alerts.
    const resume = () => this.subs.resume(chat.id);
    // The guards come first: a seed phrase or a blocklisted link is deleted, whatever else the message is.
    const found = this.guards.inspect(message, this.subs.guardsOf(chat.id));
    if (found) {
      const thread = Number.isSafeInteger(message.message_thread_id) && message.is_topic_message === true ? message.message_thread_id : null;
      return () => { resume(); return { guard: { ...found, chat, messageId: message.message_id, thread } }; };
    }
    if (edited) return () => null;
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
    const endpoint = this.rpc.endpoints[this.rpc.current];
    return {
      config: this.config, rpc: this.rpc, username: this.username, clean: this.clean, head: this.head, spec: endpoint?.identity?.spec,
      endpoint: this.rpc.endpoints.length > 1 ? this.rpc.name(this.rpc.current) : null,
      signal: this.signal, subs: this.subs, tokens: this.tokens, fmt: this.fmt, chat,
      prices: this.prices, names: this.names, venues: this.venues, guards: this.guards,
      // The forum topic a command came from: a feed, watch, whale or track set up there posts there. A reply in
      // an ordinary group (or a comment thread) also carries a message_thread_id, which subscriptions ignore.
      thread: Number.isSafeInteger(message?.message_thread_id) && (message.is_topic_message === true || !message.reply_to_message)
        ? message.message_thread_id : null,
      admin: (user) => (admin ??= this.isAdmin(chat, message, user)),
      rights: () => this.rights(chat),
    };
  }
  /** What Cairn itself may do in a group: { admin, canDelete }, or null when Telegram will not say. */
  async rights(chat) {
    try {
      const member = await this.tg.call('getChatMember', { chat_id: chat.id, user_id: this.me.id });
      return { admin: ADMINS.has(member?.status), canDelete: member?.status === 'creator' || member?.can_delete_messages === true };
    } catch (error) {
      if (error instanceof TelegramRefused) return null;
      throw error;
    }
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
    if (out.guard) return this.enforce(out.guard);
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
  /**
   * A guarded message: deleted (deleteMessage), then a warning to the chat, never as a reply, whose preview would
   * quote it. Without the right to delete, the warning names it. A flood in one batch of updates gets one warning
   * per chat and guard; each message is still deleted. Nothing of the message is stored or logged.
   */
  async enforce({ chat, messageId, thread, ...found }) {
    let deleted = false;
    if (Number.isSafeInteger(messageId)) {
      try { deleted = (await this.tg.call('deleteMessage', { chat_id: chat.id, message_id: messageId })) === true; }
      catch (error) {
        if (!(error instanceof TelegramRefused)) throw error;
        deleted = /not found/i.test(error.description); // already gone
      }
    }
    this.stats[found.guard]++;
    log('info', 'guard', { guard: found.guard, deleted });
    const key = `${chat.id} ${found.guard}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    await this.send(chat.id, warning(found, deleted), topic(thread));
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
    try {
      const fork = await this.forks.check(this.store.cursor, this.head);
      if (fork) await this.rewind(fork);
      await this.reconsider();
    } catch (error) {
      if (this.signal.aborted || !retriable(error)) throw error;
      log('warn', 'node busy: the blocks scanned will be checked for a reorg again.');
      return;
    }
    this.skipGap();
    await this.scan();
    await this.trackPass();
    const now = this.head.timestamp;
    this.store.transaction(() => {
      this.ledger.prune(now); this.subs.prune(now); this.tokens.prune(now); this.rate.prune(now); this.names.prune(now);
    });
  }
  /**
   * After a reorg: the alerts about blocks past the common ancestor are settled against the node (a correction for
   * each one whose transaction is gone, nothing for one still there), and the cursor goes back to the ancestor, so
   * that this pass rescans the replacement blocks through the scanner and the ledger like any range.
   */
  async rewind(fork) {
    const rows = this.ledger.after(fork.ancestor);
    const now = this.head.timestamp, decided = verdicts(rows, await this.standings(rows), now);
    this.store.transaction(() => {
      this.apply(decided, because.fork(fork), now);
      this.store.cursor = fork.ancestor;
      this.forks.rewind(fork.ancestor);
      if (fork.deep) this.network.deepReorg(fork, this.head);
    });
    this.stats.reorgs++;
    log('warn', 'reorg', { block: fork.from, ancestor: fork.ancestor, deep: fork.deep, corrections: decided.corrections.length,
      dropped: decided.drop.length, waiting: decided.doubt.length });
  }
  /** Alerts whose transaction a reorg left out of every block: settled once it is back in one, corrected once it is gone. */
  async reconsider() {
    const rows = this.ledger.doubts();
    if (!rows.length) return;
    const now = this.head.timestamp, decided = verdicts(rows, await this.standings(rows), now);
    this.store.transaction(() => this.apply(decided, because.dropped(), now));
  }
  async standings(rows) {
    const out = new Map();
    for (const tx of new Set(rows.map((r) => r.tx_hash))) out.set(tx, await standing(this.rpc, tx));
    return out;
  }
  apply({ drop, doubt, settle, corrections }, why, now) {
    for (const row of drop) this.ledger.dropped(row.seq);
    for (const row of doubt) this.ledger.doubt(row.seq, now);
    for (const row of settle) this.ledger.settled(row.seq);
    for (const rows of corrections) {
      this.ledger.add(correction(rows, why, this.fmt, now));
      for (const row of rows) this.ledger.corrected(row.seq);
    }
    this.stats.corrections += corrections.length;
  }
  /** More than CAIRN_MAX_GAP blocks behind (after a long downtime): jump to the safe head, with one notice per chat concerned. */
  skipGap() {
    const cursor = this.store.cursor, safe = this.head.block_number - this.config.confirmations;
    if (cursor === null || safe - cursor <= this.config.maxGap) return;
    this.store.transaction(() => {
      this.network.skipped(cursor + 1, safe, this.head);
      this.store.cursor = safe;
    });
  }
  /**
   * The next range, up to the block CAIRN_CONFIRMATIONS deep: each filter the subscribed feeds need is read once,
   * whichever feeds share it (the trade feed reads its traders from the wallet alerts' chain-wide Transfer filter),
   * and a feed nobody subscribes to reads nothing. What the feeds find is saved as pending, in chain order, in the
   * transaction that moves the cursor and keeps the hash of the range's last block; a failed read leaves the cursor,
   * and the next pass reads the whole range again. A delivery the ledger already holds (a rescan after a reorg)
   * is not sent again: the ledger only notes its block.
   */
  async scan() {
    const cursor = this.store.cursor, safe = this.head.block_number - this.config.confirmations;
    const range = cursor === null ? null : this.scanner.next(cursor, safe);
    this.behind = false;
    if (!range) return;
    const interests = this.subs.interests();
    const feeds = this.feeds.filter((f) => f.wanted(interests));
    this.prices.horizon(range.from, range.to);
    const context = { interests, tokens: this.tokens, rpc: this.rpc, now: this.head.timestamp, fmt: this.fmt,
      header: blockHeaders(this.rpc), prices: this.prices, names: this.names, known: this.known };
    const found = { deliveries: [], seen: [] };
    let end;
    try {
      const events = new Map();
      for (const filter of new Set(feeds.flatMap((f) => f.filters))) events.set(filter, await this.scanner.events(range, filter));
      for (const feed of feeds) {
        const result = await feed.find(events, context);
        found.deliveries.push(...result.deliveries);
        found.seen.push(...(result.seen ?? []));
      }
      end = range.to === this.head.block_number
        ? { number: range.to, hash: hex64(this.head.block_hash), timestamp: this.head.timestamp } : await this.forks.header(range.to);
      if (!end) throw new NodeValueError(); // the node lost the block it just served: read the range again
    } catch (error) {
      if (this.signal.aborted || !retriable(error)) throw error;
      this.rpcOk = false; // until a pass reads its range: /healthz says rpc while alerts cannot be found
      log('warn', `node busy: blocks ${range.from} to ${range.to} will be scanned again.`);
      return;
    }
    found.deliveries.sort(chainOrder);
    this.store.transaction(() => {
      for (const delivery of found.deliveries) if (!this.ledger.add(delivery)) this.ledger.relocate(delivery);
      for (const [chatId, address, token] of found.seen) this.subs.noteSeen(chatId, address, token);
      this.store.cursor = range.to;
      this.forks.remember(end);
    });
    this.rpcOk = true;
    this.behind = range.to < safe;
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
   * Pending deliveries, oldest first, chat by chat, skipping chats that are paused or were blocked during this pass.
   * A group gets at most 3 of them per pass: when more are due, 2 are sent and the third summarises the rest,
   * which the summary then delivers. Each alert posts into the forum topic its subscription was set up in, and a
   * correction replies to the alert it corrects.
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
        const r = await this.send(target, row.body, { ...topic(row.thread_id), ...(sent >= LOUD_ALERTS ? { disable_notification: true } : {}),
          ...(Number.isSafeInteger(row.reply_to) ? { reply_parameters: { message_id: row.reply_to, allow_sending_without_reply: true } } : {}) });
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

  // ---- health and metrics (round 4) ------------------------------------------------------------------------

  /** Chain seconds between the head and the last block scanned: how late alerts are. */
  lag() {
    const cursor = this.store.cursor;
    if (!this.head || cursor === null || cursor >= this.head.block_number) return 0;
    const kept = this.forks.kept(cursor);
    return kept ? Math.max(0, this.head.timestamp - kept.timestamp) : 0;
  }
  /**
   * What /healthz answers: { ok: true, head, lag_s, … }, or { ok: false, reason } with the reason "rpc" (the last
   * head read or scan failed on every endpoint), "telegram" (Telegram cannot be reached) or "stalled" (no new
   * block for CAIRN_STALL_SECONDS of wall clock), in that order. Both answers add the cursor, how long the head has
   * not changed, and which endpoint is in use.
   */
  health(now = Date.now()) {
    const seen = this.network.seen;
    const facts = { cursor: this.store.cursor, unchanged_s: seen ? Math.max(0, Math.round((now - seen.at) / 1000)) : null,
      endpoint: this.rpc.current + 1, endpoints: this.rpc.endpoints.length };
    if (!this.head || !this.rpcOk) return { ok: false, reason: 'rpc', head: seen?.n ?? null, ...facts };
    if (!this.tg.healthy) return { ok: false, reason: 'telegram', head: this.head.block_number, ...facts };
    if (seen && now - seen.at >= this.config.stallSeconds * 1000) return { ok: false, reason: 'stalled', head: this.head.block_number, ...facts };
    return { ok: true, head: this.head.block_number, lag_s: this.lag(), ...facts };
  }
  /** What /metrics answers, in Prometheus text: counters since this process started, gauges as of the last pass. */
  metrics() {
    const now = Date.now(), seen = this.network.seen, endpoints = this.rpc.endpoints;
    const one = (value) => [[{}, value]];
    return prometheus([
      { name: 'cairn_head_block', type: 'gauge', help: 'The latest Starknet block Cairn read.', samples: one(this.head?.block_number ?? seen?.n ?? 0) },
      { name: 'cairn_cursor_block', type: 'gauge', help: 'The last block scanned for alerts.', samples: one(this.store.cursor ?? 0) },
      { name: 'cairn_lag_seconds', type: 'gauge', help: 'Chain seconds between the head and the last block scanned.', samples: one(this.lag()) },
      { name: 'cairn_head_unchanged_seconds', type: 'gauge', help: 'Wall-clock seconds since the head last changed; CAIRN_STALL_SECONDS of it is a stall.',
        samples: one(seen ? Math.max(0, (now - seen.at) / 1000) : 0) },
      { name: 'cairn_healthy', type: 'gauge', help: '1 when /healthz answers 200, else 0.', samples: one(this.health(now).ok ? 1 : 0) },
      { name: 'cairn_updates_total', type: 'counter', help: 'Telegram updates handled.', samples: one(this.counts.updates) },
      { name: 'cairn_messages_sent_total', type: 'counter', help: 'Messages Telegram accepted: replies, alerts and warnings.', samples: one(this.counts.sent) },
      { name: 'cairn_alerts_total', type: 'counter', help: 'Deliveries sent: wallet and whale alerts, trade posts, track updates, network notices and corrections.',
        samples: one(this.counts.alerts) },
      { name: 'cairn_pending_alerts', type: 'gauge', help: 'Deliveries waiting to be sent.', samples: one(this.ledger.waiting()) },
      { name: 'cairn_rpc_requests_total', type: 'counter', help: 'JSON-RPC requests, by endpoint (its place in the list).',
        samples: endpoints.map((e) => [{ endpoint: e.index + 1 }, e.requests]) },
      { name: 'cairn_rpc_errors_total', type: 'counter', help: 'JSON-RPC requests that failed (HTTP 429 or 5xx, timeout, broken answer), by endpoint.',
        samples: endpoints.map((e) => [{ endpoint: e.index + 1 }, e.errors]) },
      { name: 'cairn_rpc_endpoint', type: 'gauge', help: 'The endpoint that answered last, by its place in the list.', samples: one(this.rpc.current + 1) },
      { name: 'cairn_telegram_errors_total', type: 'counter', help: 'Telegram calls that failed because Telegram could not be reached.', samples: one(this.tg.errors) },
      { name: 'cairn_reorgs_total', type: 'counter', help: 'Reorgs Cairn walked back from.', samples: one(this.stats.reorgs) },
      { name: 'cairn_corrections_total', type: 'counter', help: 'Corrections queued for alerts whose transaction left the chain.', samples: one(this.stats.corrections) },
      { name: 'cairn_guard_deletions_total', type: 'counter', help: 'Messages a guard caught, by guard.',
        samples: [[{ guard: 'seed' }, this.stats.seed], [{ guard: 'links' }, this.stats.links]] },
    ]);
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
