// What each chat asked Cairn to follow, in CAIRN_DATA. Every function is synchronous and runs inside the
// caller's transaction, so that a change and the update that asked for it are saved together. From round 3,
// a feed, watch, whale or track keeps the forum topic it was set up in (thread_id), and posts there.

export const LIMITS = Object.freeze({ whales: 5, tracks: 10, minimums: 20, muted: 100, label: 32 });
const OFFER_TTL = 24 * 3600; // seconds of chain time a Watch or Track button keeps working
/** Every table holding a chat's data, children before the chat itself: /forget and migrations walk it. */
const CHAT_TABLES = ['network_subscriptions', 'protection', 'watches', 'seen', 'whales', 'minimums', 'muted', 'tracks', 'offers', 'feeds', 'deliveries', 'chats'];
const FEED_COLUMNS = 'id, chat_id, token, symbol, min, min_units, min_usd, mode, since_block, thread_id';
/** A topic for export: only chats with forum topics show one. */
const topic = (row) => (row.thread_id === null || row.thread_id === undefined ? {} : { thread_id: row.thread_id });

const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

export class Subscriptions {
  constructor(store, config) {
    this.store = store;
    this.maxWatches = config.maxWatches;
  }
  #q(text) { return this.store.sql(text); }

  /** Records a chat's id and type when it first subscribes. */
  chat(chat) {
    this.#q('INSERT INTO chats (chat_id, type) VALUES (?, ?) ON CONFLICT (chat_id) DO UPDATE SET type = excluded.type')
      .run(chat.id, String(chat.type ?? 'unknown').slice(0, 16));
  }
  pause(chatId) { this.#q('UPDATE chats SET paused = 1 WHERE chat_id = ?').run(chatId); }
  /** A chat that writes again, or re-adds the bot, gets its pending alerts. */
  resume(chatId) { this.#q('UPDATE chats SET paused = 0 WHERE chat_id = ? AND paused <> 0').run(chatId); }
  isPaused(chatId) { return this.#q('SELECT paused FROM chats WHERE chat_id = ?').get(chatId)?.paused === 1; }

  /** Network alerts are subscriptions; paused chats stay subscribed but receive no notices. */
  network(chat, on, thread = null) {
    this.chat(chat);
    if (on) this.#q(`INSERT INTO network_subscriptions (chat_id, thread_id) VALUES (?, ?)
      ON CONFLICT (chat_id) DO UPDATE SET thread_id = excluded.thread_id`).run(chat.id, thread);
    else this.#q('DELETE FROM network_subscriptions WHERE chat_id = ?').run(chat.id);
  }
  networkOn(chatId) { return Boolean(this.#q('SELECT 1 FROM network_subscriptions WHERE chat_id = ?').get(chatId)); }
  networkSubscribers() { return this.#q('SELECT chat_id, thread_id FROM network_subscriptions JOIN chats USING(chat_id) WHERE paused = 0').all(); }

  // ---- watches -------------------------------------------------------------------------------------

  watches(chatId) { return this.#q('SELECT id, chat_id, address, label, since_block, thread_id FROM watches WHERE chat_id = ? ORDER BY id').all(chatId); }
  watchById(id) { return this.#q('SELECT id, chat_id, address, label, since_block, thread_id FROM watches WHERE id = ?').get(id) ?? null; }
  /**
   * Adds a watch, or relabels an existing one; asked again from another forum topic, its alerts move there.
   * Returns { status: added|exists|cap, watch, relabelled, moved, before } (before: the topic it was in).
   */
  watch(chat, address, label, sinceBlock, thread = null) {
    const all = this.watches(chat.id);
    const existing = all.find((w) => w.address === address);
    if (existing) {
      const relabelled = Boolean(label) && label !== existing.label, moved = existing.thread_id !== thread;
      if (relabelled) this.#q('UPDATE watches SET label = ? WHERE id = ?').run(label, existing.id);
      if (moved) this.#q('UPDATE watches SET thread_id = ? WHERE id = ?').run(thread, existing.id);
      return { status: 'exists', watch: { ...existing, label: relabelled ? label : existing.label, thread_id: thread }, relabelled, moved, before: existing.thread_id };
    }
    if (all.length >= this.maxWatches) return { status: 'cap' };
    this.chat(chat);
    const { lastInsertRowid } = this.#q('INSERT INTO watches (chat_id, address, label, since_block, thread_id) VALUES (?, ?, ?, ?, ?)')
      .run(chat.id, address, label || null, sinceBlock, thread);
    return { status: 'added', watch: this.watchById(Number(lastInsertRowid)) };
  }
  /**
   * Removes the chat's watch on `address`, or the only one labelled `label`. Returns { watch } when removed,
   * { ambiguous: n } when n watches share the label, or {} when none matches.
   */
  unwatch(chatId, { address, label, id }) {
    const matches = this.watches(chatId).filter((w) => (id !== undefined ? w.id === id : address ? w.address === address : same(w.label, label)));
    if (matches.length !== 1) return matches.length ? { ambiguous: matches.length } : {};
    const [watch] = matches;
    this.#q('DELETE FROM watches WHERE id = ?').run(watch.id);
    this.#q('DELETE FROM seen WHERE chat_id = ? AND address = ?').run(chatId, watch.address);
    return { watch };
  }
  /** Notes a token seen moving for a watched address, for /balance. */
  noteSeen(chatId, address, token) { this.#q('INSERT OR IGNORE INTO seen (chat_id, address, token) VALUES (?, ?, ?)').run(chatId, address, token); }
  seen(chatId, address) { return this.#q('SELECT token FROM seen WHERE chat_id = ? AND address = ? ORDER BY rowid').all(chatId, address).map((r) => r.token); }

  // ---- whales, floors and mutes ----------------------------------------------------------------------

  whales(chatId) { return this.#q('SELECT id, chat_id, token, symbol, min, units, since_block, thread_id FROM whales WHERE chat_id = ? ORDER BY id').all(chatId); }
  whaleById(id) { return this.#q('SELECT id, chat_id, token, symbol, min, units, since_block, thread_id FROM whales WHERE id = ?').get(id) ?? null; }
  /** Sets the chat's threshold on a token, in place (and in the asking topic) when it has one: added|updated|cap. */
  whale(chat, token, symbol, min, units, sinceBlock, thread = null) {
    const all = this.whales(chat.id);
    const existing = all.find((w) => w.token === token);
    if (existing) {
      this.#q('UPDATE whales SET symbol = ?, min = ?, units = ?, thread_id = ? WHERE id = ?').run(symbol, min, String(units), thread, existing.id);
      return 'updated';
    }
    if (all.length >= LIMITS.whales) return 'cap';
    this.chat(chat);
    this.#q('INSERT INTO whales (chat_id, token, symbol, min, units, since_block, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(chat.id, token, symbol, min, String(units), sinceBlock, thread);
    return 'added';
  }
  unwhale(chatId, { token, id }) {
    const whale = this.whales(chatId).find((w) => (id !== undefined ? w.id === id : w.token === token));
    if (whale) this.#q('DELETE FROM whales WHERE id = ?').run(whale.id);
    return whale ?? null;
  }
  minimums(chatId) { return this.#q('SELECT token, amount, units FROM minimums WHERE chat_id = ? ORDER BY rowid').all(chatId); }
  /** Sets the chat's floor for watch alerts on a token (0 removes it): set|removed|none|cap. */
  minimum(chat, token, amount, units) {
    const has = this.#q('SELECT 1 FROM minimums WHERE chat_id = ? AND token = ?').get(chat.id, token);
    if (units === 0n) {
      if (!has) return 'none';
      this.#q('DELETE FROM minimums WHERE chat_id = ? AND token = ?').run(chat.id, token);
      return 'removed';
    }
    if (!has && this.minimums(chat.id).length >= LIMITS.minimums) return 'cap';
    this.chat(chat);
    this.#q(`INSERT INTO minimums (chat_id, token, amount, units) VALUES (?, ?, ?, ?)
      ON CONFLICT (chat_id, token) DO UPDATE SET amount = excluded.amount, units = excluded.units`).run(chat.id, token, amount, String(units));
    return 'set';
  }
  muted(chatId) { return this.#q('SELECT token FROM muted WHERE chat_id = ? ORDER BY rowid').all(chatId).map((r) => r.token); }
  mute(chat, token) {
    const all = this.muted(chat.id);
    if (all.includes(token)) return 'exists';
    if (all.length >= LIMITS.muted) return 'cap';
    this.chat(chat);
    this.#q('INSERT INTO muted (chat_id, token) VALUES (?, ?)').run(chat.id, token);
    return 'added';
  }
  unmute(chatId, token) { return this.#q('DELETE FROM muted WHERE chat_id = ? AND token = ?').run(chatId, token).changes > 0; }

  // ---- tracks and buttons ------------------------------------------------------------------------------

  tracks(chatId) { return this.#q('SELECT id, chat_id, hash, since_block, since_time, stage, thread_id FROM tracks WHERE chat_id = ? ORDER BY id').all(chatId); }
  allTracks() { return this.#q('SELECT id, chat_id, hash, since_block, since_time, stage, thread_id FROM tracks ORDER BY id').all(); }
  trackById(id) { return this.#q('SELECT id, chat_id, hash, since_block, since_time, stage, thread_id FROM tracks WHERE id = ?').get(id) ?? null; }
  track(chat, hash, sinceBlock, sinceTime, thread = null) {
    const all = this.tracks(chat.id);
    if (all.some((t) => t.hash === hash)) return 'exists';
    if (all.length >= LIMITS.tracks) return 'cap';
    this.chat(chat);
    this.#q('INSERT INTO tracks (chat_id, hash, since_block, since_time, thread_id) VALUES (?, ?, ?, ?, ?)').run(chat.id, hash, sinceBlock, sinceTime, thread);
    return 'added';
  }
  untrack(chatId, { hash, id }) {
    const track = this.tracks(chatId).find((t) => (id !== undefined ? t.id === id : t.hash === hash));
    if (track) this.#q('DELETE FROM tracks WHERE id = ?').run(track.id);
    return track ?? null;
  }
  /** A rebuilt acceptance can reopen a previously completed track until its L1 notice. */
  resumeTrack(track, head, stage) {
    this.#q(`INSERT INTO tracks (chat_id, hash, since_block, since_time, stage, thread_id) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (chat_id, hash) DO UPDATE SET stage = min(tracks.stage, excluded.stage)`)
      .run(track.chat_id, track.hash, head.block_number, head.timestamp, stage, track.thread_id);
  }
  trackStage(id, stage) { this.#q('UPDATE tracks SET stage = ? WHERE id = ?').run(stage, id); }
  trackDone(id) { this.#q('DELETE FROM tracks WHERE id = ?').run(id); }
  /** Keeps a pasted address or hash for a day, so that its button can carry a short id instead. */
  offer(chat, kind, value, now) {
    this.chat(chat);
    return Number(this.#q('INSERT INTO offers (chat_id, kind, value, chain_time) VALUES (?, ?, ?, ?)').run(chat.id, kind, value, now).lastInsertRowid);
  }
  offerById(id, now) {
    const offer = this.#q('SELECT id, chat_id, kind, value, chain_time FROM offers WHERE id = ?').get(id);
    return offer && now - offer.chain_time < OFFER_TTL ? offer : null;
  }

  // ---- the trade feed (round 3) --------------------------------------------------------------------------

  feedOf(chatId) { return this.#q(`SELECT ${FEED_COLUMNS} FROM feeds WHERE chat_id = ?`).get(chatId) ?? null; }
  feedById(id) { return this.#q(`SELECT ${FEED_COLUMNS} FROM feeds WHERE id = ?`).get(id) ?? null; }
  /**
   * Sets the chat's one feed: { status: added|updated|replaced, previous }. A feed on another token replaces the
   * old one and covers the blocks after `sinceBlock`; on the same token its floor, side and topic change in place.
   * `min` is the floor as typed (a token amount or $ and cents), `minUnits` or `minUsd` (cents) the value compared.
   */
  feed(chat, { token, symbol, min = null, minUnits = null, minUsd = null, mode }, sinceBlock, thread = null) {
    const previous = this.feedOf(chat.id);
    const values = [symbol, min, minUnits === null ? null : String(minUnits), minUsd === null ? null : String(minUsd), mode, thread];
    this.chat(chat);
    if (previous?.token === token) {
      this.#q('UPDATE feeds SET symbol = ?, min = ?, min_units = ?, min_usd = ?, mode = ?, thread_id = ? WHERE id = ?').run(...values, previous.id);
      return { status: 'updated', previous };
    }
    if (previous) this.#q('DELETE FROM feeds WHERE id = ?').run(previous.id);
    this.#q('INSERT INTO feeds (chat_id, token, symbol, min, min_units, min_usd, mode, thread_id, since_block) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(chat.id, token, ...values, sinceBlock);
    return { status: previous ? 'replaced' : 'added', previous };
  }
  /** Stops the chat's feed (or the one with `id`, when it is this chat's); returns it, or null. */
  unfeed(chatId, { id } = {}) {
    const feed = this.feedOf(chatId);
    if (!feed || (id !== undefined && feed.id !== id)) return null;
    this.#q('DELETE FROM feeds WHERE id = ?').run(feed.id);
    return feed;
  }

  // ---- the whole chat ------------------------------------------------------------------------------------

  /**
   * Everything stored for the chat, as /export shows it: the brief's six keys, round 3's feed, then what else
   * CAIRN_DATA holds for it (its type and pause state, the values behind its buttons, and its delivery records,
   * counted). A subscription set up in a forum topic shows its thread_id.
   */
  export(chatId) {
    const chat = this.#q('SELECT type, paused FROM chats WHERE chat_id = ?').get(chatId);
    const deliveries = { pending: 0, sent: 0, summarized: 0, dropped: 0 };
    for (const r of this.#q('SELECT state, count(*) AS n FROM deliveries WHERE chat_id = ? GROUP BY state').all(chatId)) deliveries[r.state] = r.n;
    const feed = this.feedOf(chatId);
    const protection = this.#q('SELECT seed, links FROM protection WHERE chat_id = ?').get(chatId);
    return {
      chat_id: chatId,
      ...(protection ? { protection } : {}),
      ...(this.networkOn(chatId) ? { network: true } : {}),
      watches: this.watches(chatId).map((w) => ({ address: w.address, label: w.label, since_block: w.since_block, seen: this.seen(chatId, w.address), ...topic(w) })),
      whales: this.whales(chatId).map((w) => ({ token: w.token, symbol: w.symbol, min: w.min, ...topic(w) })),
      minimums: Object.fromEntries(this.minimums(chatId).map((m) => [m.token, m.amount])),
      tracks: this.tracks(chatId).map((t) => ({ hash: t.hash, since_block: t.since_block, ...topic(t) })),
      muted: this.muted(chatId),
      feed: feed && { token: feed.token, symbol: feed.symbol, min: feed.min, side: feed.mode, since_block: feed.since_block, ...topic(feed) },
      chat: chat ? { type: chat.type, paused: chat.paused === 1 } : null,
      buttons: this.#q('SELECT kind, value, chain_time FROM offers WHERE chat_id = ? ORDER BY id').all(chatId)
        .map((o) => ({ kind: o.kind, value: o.value, chain_time: o.chain_time })),
      deliveries,
    };
  }
  /**
   * Deletes every row about the chat, its delivery ledger included, and in a private chat (whose id is the
   * person's) their rate-limit entry too; returns what each table held.
   */
  forget(chatId) {
    const counts = {};
    for (const table of CHAT_TABLES) counts[table] = this.#q(`DELETE FROM ${table} WHERE chat_id = ?`).run(chatId).changes;
    this.#q('DELETE FROM rate WHERE sender = ?').run(chatId);
    return counts;
  }
  /** Moves a chat's data to the id Telegram gave it after an upgrade to a supergroup. */
  migrate(from, to) {
    if (from === to) return;
    for (const table of CHAT_TABLES) {
      this.#q(`UPDATE OR IGNORE ${table} SET chat_id = ? WHERE chat_id = ?`).run(to, from);
      this.#q(`DELETE FROM ${table} WHERE chat_id = ?`).run(from);
    }
  }
  /** Every subscription, indexed for the scanner: wallet alerts (round 2) and trade feeds (round 3). */
  interests() {
    const watchers = new Map(), whales = new Map(), muted = new Set(), floors = new Map(), labels = new Map(), feeds = new Map();
    const add = (map, key, value) => (map.get(key) ?? map.set(key, []).get(key)).push(value);
    for (const w of this.#q('SELECT chat_id, address, label, since_block, thread_id FROM watches').all()) {
      add(watchers, w.address, { chatId: w.chat_id, since: w.since_block, thread: w.thread_id });
      if (!labels.has(w.chat_id)) labels.set(w.chat_id, new Map());
      labels.get(w.chat_id).set(w.address, w.label);
    }
    for (const w of this.#q('SELECT chat_id, token, units, since_block, thread_id FROM whales').all()) {
      add(whales, w.token, { chatId: w.chat_id, units: BigInt(w.units), since: w.since_block, thread: w.thread_id });
    }
    for (const m of this.#q('SELECT chat_id, token FROM muted').all()) muted.add(`${m.chat_id} ${m.token}`);
    for (const m of this.#q('SELECT chat_id, token, units FROM minimums').all()) floors.set(`${m.chat_id} ${m.token}`, BigInt(m.units));
    for (const f of this.#q(`SELECT ${FEED_COLUMNS} FROM feeds ORDER BY id`).all()) {
      add(feeds, f.token, { chatId: f.chat_id, id: f.id, mode: f.mode, since: f.since_block, thread: f.thread_id,
        minUnits: f.min_units === null ? null : BigInt(f.min_units), minUsd: f.min_usd === null ? null : BigInt(f.min_usd) });
    }
    return { watchers, whales, muted, floors, labels, feeds, empty: watchers.size === 0 && whales.size === 0 };
  }
  /** Drops buttons older than a day of chain time. */
  prune(now) { this.#q('DELETE FROM offers WHERE chain_time < ?').run(now - OFFER_TTL); }
}
