import { handle, context } from './updates.mjs';
import { Guards } from './guard.mjs';
import { startHttp } from './http.mjs';
import { Network } from './network.mjs';
import { RpcPool } from './rpcpool.mjs';
import { performance } from 'node:perf_hooks';
import { walletAlerts } from './alerts.mjs';
import { COMMANDS } from './commands.mjs';
import { CairnError, log, NodeBusy, RpcError } from './errors.mjs';
import { decodeChain, NodeValueError } from './felt.mjs';
import { links, redactor } from './format.mjs';
import { Ledger, STAGE } from './ledger.mjs';
import { Names } from './names.mjs';
import { Prices } from './prices.mjs';
import { RateLimit } from './rate.mjs';
import { blockHeaders, Scanner } from './scanner.mjs';
import { Store } from './store.mjs';
import { Subscriptions } from './subscriptions.mjs';
import { deliver, reply, send, respond as respondToUpdate } from './delivery.mjs';
import { Tokens } from './tokens.mjs';
import { trackStep } from './tracks.mjs';
import { tradeFeed } from './trades.mjs';
import { Telegram, sleep } from './transport.mjs';
import { VENUES, venuesOf } from './venues.mjs';

const ALLOWED_UPDATES = ['message', 'edited_message', 'callback_query', 'my_chat_member'];
/** The network file's contracts as alerts name them, in place of a short address. */
const CONTRACT_NAMES = { pragma: 'Pragma oracle', naming: 'Starknet ID naming', ...Object.fromEntries(VENUES.map((v) => [v.contract, v.label])) };
/** Ledger rows in chain order: block, then transaction, then event. */
export const chainOrder = (a, b) => {
  const x = a.position ?? [a.block ?? 0, 0, a.eventIndex ?? 0], y = b.position ?? [b.block ?? 0, 0, b.eventIndex ?? 0];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};
/** Chain failures that leave the work for the next pass. */
const retriable = (error) => error instanceof NodeBusy || error instanceof RpcError || error instanceof NodeValueError;

export async function handshake(rpc, config, clean) {
  if (rpc instanceof RpcPool) return rpc.identify(client => handshake(client, config, clean));
  const chain = decodeChain(await rpc.call('starknet_chainId'));
  if (chain !== config.chain) throw new CairnError(`Node reports chain ${clean(chain)}; expected ${config.chain}.`, 2);
  const spec = await rpc.call('starknet_specVersion');
  const version = typeof spec === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(spec) : null;
  if (!version || !(Number(version[1]) > 0 || Number(version[2]) >= 10)) {
    throw new CairnError(`Node spec ${clean(String(spec).slice(0, 100))} is below 0.10.0 or malformed.`, 2);
  }
  return { chain, spec: clean(spec) };
}
export async function serve(config, signal) {
  const clean = redactor(config), rpc = new RpcPool(config, signal), tg = new Telegram(config, signal);
  const me = await tg.call('getMe');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(me?.username ?? '')) throw new CairnError('Telegram returned an invalid bot username.');
  const username = clean(me.username);
  let identity = null;
  try { identity = await handshake(rpc, config, clean); }
  catch (error) {
    if (signal.aborted || config.mode === 'doctor' || (error instanceof CairnError && error.exitCode === 2)) throw error;
    log('warn', 'RPC endpoints unreachable; chain identity will be checked again.');
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
    const http = await startHttp(config, () => bot.snapshot());
    try { return config.mode === 'tick' ? await bot.tick() : await bot.run(); }
    finally { if (http) { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); } }
  } finally { store.close(); }
}

/**
 * One bot process. A pass: read the head; handle updates (a subscription covers the blocks after that head);
 * scan the next range for alerts and trades and step the tracked transactions, saving what they find as
 * pending; then deliver the pending alerts, each marked sent only once Telegram accepts it, within each
 * group's budget.
 */
export class Bot {
  constructor(o) {
    Object.assign(this, o);
    this.subs = new Subscriptions(o.store, o.config);
    this.ledger = new Ledger(o.store);
    this.guards = new Guards(o.store, o.config.blocklist);
    this.network = new Network(o.config, o.store, o.rpc, this.ledger, this.subs);
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
    this.chainReady = false; // pending chain facts wait for this instance to validate their history
    this.catchingUp = false; // groups wait for the whole saved backlog before choosing their biggest posts
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

  snapshot() {
    const reason = !this.head ? 'rpc' : this.tg.healthy === false ? 'telegram' : Date.now() - this.network.since >= this.config.stallSeconds * 1000 ? 'stalled' : null;
    return { ...this.counts, head: this.head?.block_number ?? Number(this.store.get('head_number') ?? 0), lag: Math.max(0, Math.floor(Date.now() / 1000) - (this.head?.timestamp ?? Number(this.store.get('chain_time') ?? 0))),
      errors: this.rpc.errors + this.rpc.clients.reduce((n, c) => n + c.errors, 0), reason };
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
      let batch;
      try { batch = await this.poll(timeout); }
      catch (error) {
        if (this.signal.aborted || error.exitCode === 3 || /conflict/i.test(error.message)) throw error;
        await sleep(this.config.pollMs, this.signal);
        continue;
      }
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
    this.chainReady = false;
    try {
      this.identity ??= await handshake(this.rpc, this.config, this.clean);
      const block = await this.rpc.call('starknet_getBlockWithTxHashes', { block_id: 'latest' });
      if (!Number.isSafeInteger(block?.block_number) || block.block_number < 0 || !Number.isSafeInteger(block.timestamp)) throw new Error('invalid header');
      this.head = block;
      this.headEndpoint = this.rpc.generation ?? 0;
      // Update handling also reads the head without running the periodic step.
      this.network.recovered(block);
      // The first head ever read becomes the cursor: Cairn never backfills.
      if (this.store.cursor === null) this.store.transaction(() => { this.store.cursor = Math.max(0, block.block_number - this.config.confirmations); });
    } catch (error) {
      if (this.signal.aborted || (error instanceof CairnError && error.exitCode === 2)) throw error;
      this.head = null;
      log('warn', error instanceof NodeBusy ? 'RPC endpoints unreachable; latest block unavailable.' : 'RPC latest block unavailable; retrying.');
    }
  }
  async poll(timeout) {
    const batch = await this.tg.call('getUpdates', { offset: this.store.offset, limit: 100, timeout, allowed_updates: ALLOWED_UPDATES });
    if (!Array.isArray(batch)) throw new CairnError('Telegram returned invalid updates.');
    return batch;
  }

  // ---- updates ---------------------------------------------------------------------------------------

  handle(update) { return handle(this, update); }
  context(chat, message) { return context(this, chat, message); }

  // ---- replies -------------------------------------------------------------------------------------------

  respond(out) { return respondToUpdate(this, out); }
  reply(out) { return reply(this, out); }
  send(chatId, text, extra) { return send(this, chatId, text, extra); }
  deliver() { return deliver(this); }

  // ---- alerts --------------------------------------------------------------------------------------------

  async networkPass() {
    this.chainReady = false;
    try {
      if (await this.network.step(this.head, Date.now(), this.headEndpoint) === false || !this.head) return false;
      await this.network.remember(this.head, this.headEndpoint);
      return this.chainReady = true;
    } catch (error) { if (this.signal.aborted || !retriable(error)) throw error; return false; }
  }
  async background() {
    this.behind = false;
    if (!await this.networkPass()) return;
    if (await this.scan() === false) { this.chainReady = false; return; }
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
    for (let attempt = 0; attempt < 3; attempt++) {
      const safe = this.head.block_number - this.config.confirmations;
      const backlog = Number(this.store.get('catchup_to'));
      const target = backlog > this.store.cursor ? Math.min(safe, backlog) : safe;
      const range = this.scanner.next(this.store.cursor, target);
      if (!range) { this.catchingUp = false; return; }
      const endpoint = this.rpc.generation ?? 0, interests = this.subs.interests();
      const feeds = this.feeds.filter(f => f.wanted(interests)), found = { deliveries: [], seen: [] };
      this.prices.reset(); this.names.reset();
      const context = { interests, tokens: this.tokens, rpc: this.rpc, now: this.head.timestamp, fmt: this.fmt,
        header: blockHeaders(this.rpc), prices: this.prices, names: this.names, known: this.known };
      this.store.db.exec('SAVEPOINT scan_range');
      try {
        const events = new Map();
        for (const filter of new Set(feeds.flatMap(f => f.filters))) events.set(filter, await this.scanner.events(range, filter));
        for (const feed of feeds) {
          const result = await feed.find(events, context);
          found.deliveries.push(...result.deliveries); found.seen.push(...(result.seen ?? []));
        }
        if ((this.rpc.generation ?? 0) !== endpoint) throw new RpcError(33);
        for (const delivery of found.deliveries.sort(chainOrder)) this.ledger.add(delivery);
        this.ledger.finishRebuilds(range.to);
        for (const [chatId, address, token] of found.seen) this.subs.noteSeen(chatId, address, token);
        this.store.cursor = range.to;
        this.store.set('catchup_to', range.to < target ? target : 0);
        this.store.db.exec('RELEASE scan_range');
        this.catchingUp = range.to < target;
        this.behind = range.to < safe;
        return;
      } catch (error) {
        this.store.db.exec('ROLLBACK TO scan_range; RELEASE scan_range');
        this.prices.reset(); this.names.reset();
        if (this.signal.aborted || !retriable(error)) throw error;
        if ((this.rpc.generation ?? 0) !== endpoint && attempt < 2) {
          await this.readHead();
          if (!await this.networkPass()) return false;
        } else { log('warn', `node busy: blocks ${range.from} to ${range.to} will be scanned again.`); return false; }
      }
    }
  }
  async trackPass() {
    for (const row of this.ledger.reorgRows('rebuild')) if (row.kind === 'track') {
      this.subs.resumeTrack({ chat_id: row.chat_id, hash: row.tx_hash, thread_id: row.thread_id },
        this.head, row.event_index === STAGE.accepted ? 0 : 1);
    }
    for (const track of this.subs.allTracks()) {
      const endpoint = this.rpc.generation ?? 0;
      let step;
      try { step = await trackStep(track, { rpc: this.rpc, head: this.head, fmt: this.fmt }); }
      catch (error) {
        if (this.signal.aborted || !retriable(error)) throw error;
        log('warn', 'node busy: tracked transactions will be checked again.');
        return;
      }
      if ((this.rpc.generation ?? 0) !== endpoint) return;
      if (!step) continue;
      this.store.transaction(() => {
        if (step.delivery) this.ledger.add(step.delivery);
        if (step.stage === 'done') this.subs.trackDone(track.id);
        else this.subs.trackStage(track.id, step.stage);
      });
    }
  }
}
