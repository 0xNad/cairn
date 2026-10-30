// The delivery ledger. Each alert is keyed by (chat, transaction hash, event_index), the first event of its
// message, and saved as pending in the same transaction as the scan that found it. It is marked sent, with
// its message_id, only once Telegram accepts it; its text is then dropped and the key kept for seven days of
// chain time, so that a rescan or a restart never sends it twice. Track stages use negative indexes.
// Round 3: each alert keeps the forum topic it posts into, and a digest, so that a group's summary can count it;
// alerts a summary covered are marked summarized, with the summary's message_id.
// Round 4: network notices (stalls, recoveries, gaps, outages) are deliveries too, keyed by what they report
// (`stall:<block>:<since>`, `gap:<from>:<to>`, `outage:<since>`) instead of a transaction hash. After a reorg, an
// alert whose transaction left the chain is marked corrected and gets one correction: a delivery keyed by the same
// transaction at CORRECTION − event_index, which replies to the alert's message_id (reply_to).

export const LEDGER_TTL = 7 * 24 * 3600;
export const STAGE = Object.freeze({ accepted: -1, final: -2, missing: -3 });
/** A correction's event index: below every track stage, one per alert. */
export const CORRECTION = -10;
/** The kinds that report a transaction in a block: what a reorg can take back. */
const ON_CHAIN = "('alert', 'trade')";

export class Ledger {
  constructor(store) { this.store = store; }
  #q(text) { return this.store.sql(text); }
  /** Saves an alert before it is sent; false when its key is already in the ledger. */
  add({ chatId, txHash, eventIndex, kind, events = [eventIndex], block = null, chainTime, body, thread = null, digest = null, replyTo = null }) {
    return this.#q(`INSERT OR IGNORE INTO deliveries (chat_id, tx_hash, event_index, kind, events, block, chain_time, state, body, thread_id, digest, reply_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`).run(chatId, txHash, eventIndex, kind, JSON.stringify(events), block, chainTime, body,
      thread, digest === null ? null : JSON.stringify(digest), replyTo).changes === 1;
  }
  /**
   * Pending alerts of chats that are not paused, in the order they were found (chain order), with the chat's type.
   * An alert whose transaction left the chain in a reorg waits (doubt_since) until it is back in a block.
   */
  pending(limit = 1000) {
    return this.#q(`SELECT d.seq, d.chat_id, d.body, d.thread_id, d.digest, d.kind, d.tx_hash, d.block, d.reply_to, c.type FROM deliveries d
      LEFT JOIN chats c ON c.chat_id = d.chat_id WHERE d.state = 'pending' AND d.doubt_since IS NULL AND coalesce(c.paused, 0) = 0
      ORDER BY d.seq LIMIT ?`).all(limit);
  }
  sent(seq, messageId) { this.#q("UPDATE deliveries SET state = 'sent', message_id = ?, body = NULL, digest = NULL WHERE seq = ?").run(messageId, seq); }
  /** Delivered inside a group's summary: the key stays, the text goes, and the summary's message_id is kept. */
  summarized(seq, messageId) { this.#q("UPDATE deliveries SET state = 'summarized', message_id = ?, body = NULL, digest = NULL WHERE seq = ?").run(messageId, seq); }
  /** Telegram refused it for good (not a 403 or a migration), or it was taken back before it was sent: keep the key, drop the text. */
  dropped(seq) { this.#q("UPDATE deliveries SET state = 'dropped', body = NULL, digest = NULL, doubt_since = NULL WHERE seq = ?").run(seq); }
  /** The message an alert became, for later corrections. */
  messageId(chatId, txHash, eventIndex) {
    return this.#q('SELECT message_id FROM deliveries WHERE chat_id = ? AND tx_hash = ? AND event_index = ?').get(chatId, txHash, eventIndex)?.message_id ?? null;
  }
  prune(now) { this.#q('DELETE FROM deliveries WHERE chain_time < ?').run(now - LEDGER_TTL); }
  /** How many deliveries wait to be sent. */
  waiting() { return this.#q("SELECT count(*) AS n FROM deliveries WHERE state = 'pending'").get().n; }

  // ---- round 4: notices and reorgs ---------------------------------------------------------------------------

  /** The deliveries of one notice key (every chat that got a stall alert, say). */
  notices(key) { return this.#q('SELECT seq, chat_id, state, thread_id FROM deliveries WHERE tx_hash = ? AND event_index = 0').all(key); }
  /** A delivery found again by a rescan, in the block it now sits in (a transaction re-included elsewhere). */
  relocate({ chatId, txHash, eventIndex, block }) {
    this.#q('UPDATE deliveries SET block = ? WHERE chat_id = ? AND tx_hash = ? AND event_index = ? AND block IS NOT ?').run(block, chatId, txHash, eventIndex, block);
  }
  /** Alerts and trade posts about transactions in blocks after `ancestor`, sent or not, that no reorg corrected yet. */
  after(ancestor) {
    return this.#q(`SELECT seq, chat_id, tx_hash, event_index, block, state, message_id, thread_id, doubt_since FROM deliveries
      WHERE kind IN ${ON_CHAIN} AND block > ? AND state IN ('pending', 'sent', 'summarized') ORDER BY seq`).all(ancestor);
  }
  /** Alerts whose transaction was out of every block when last checked: still waiting to be re-included or dropped. */
  doubts() {
    return this.#q(`SELECT seq, chat_id, tx_hash, event_index, block, state, message_id, thread_id, doubt_since FROM deliveries
      WHERE doubt_since IS NOT NULL AND state IN ('pending', 'sent', 'summarized') ORDER BY seq`).all();
  }
  doubt(seq, since) { this.#q('UPDATE deliveries SET doubt_since = coalesce(doubt_since, ?) WHERE seq = ?').run(since, seq); }
  /** Back in a block: nothing more to say about it. */
  settled(seq) { this.#q('UPDATE deliveries SET doubt_since = NULL WHERE seq = ?').run(seq); }
  /** Its transaction left the chain and its correction is queued: never checked again, never corrected twice. */
  corrected(seq) { this.#q("UPDATE deliveries SET state = 'corrected', doubt_since = NULL WHERE seq = ?").run(seq); }
}
