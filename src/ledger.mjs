// The delivery ledger. Each alert is keyed by (chat, transaction hash, event_index), the first event of its
// message, and saved as pending in the same transaction as the scan that found it. It is marked sent, with
// its message_id, only once Telegram accepts it; its text is then dropped and the key kept for seven days of
// chain time, so that a rescan or a restart never sends it twice. Track stages use negative indexes.
// Round 3: each alert keeps the forum topic it posts into, and a digest, so that a group's summary can count it;
// alerts a summary covered are marked summarized, with the summary's message_id.
// Round 4: a reorg reads the ledger back. An alert or trade whose transaction the node no longer finds is marked
// orphaned and gets one correction, its own ledger row (event_index CORRECTION − the alert's), replying to the
// alert's message; a transaction found again keeps its row, moved to its new block, so the rescan's identical key
// sends nothing. An orphaned alert whose transaction comes back later is posted again under the same key.
// Network notices (stall, recovery, outage, gap) are ledger rows too, keyed by what they report.

export const LEDGER_TTL = 7 * 24 * 3600;
export const STAGE = Object.freeze({ accepted: -1, final: -2, missing: -3 });
/** A correction's event_index: CORRECTION − the corrected alert's event_index (always below the track stages). */
export const CORRECTION = -10;
/** Rows a reorg re-checks: alerts and trades, their transaction in a block. */
const CHAIN_KINDS = "kind IN ('alert', 'trade')";

export class Ledger {
  constructor(store) { this.store = store; }
  #q(text) { return this.store.sql(text); }
  /**
   * Saves an alert before it is sent; false when its key is already in the ledger, unless that row was orphaned
   * by a reorg (and corrected): a transaction back on the chain is posted again.
   */
  add({ chatId, txHash, eventIndex, kind, events = [eventIndex], block = null, chainTime, body, thread = null, digest = null, replyTo = null }) {
    const added = this.#q(`INSERT INTO deliveries (chat_id, tx_hash, event_index, kind, events, block, chain_time, state, body, thread_id, digest, reply_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?) ON CONFLICT (chat_id, tx_hash, event_index) DO UPDATE SET state = 'pending',
      events = excluded.events, block = excluded.block, chain_time = excluded.chain_time, body = excluded.body, thread_id = excluded.thread_id,
      digest = excluded.digest, reply_to = excluded.reply_to, message_id = NULL WHERE deliveries.state = 'orphaned'`)
      .run(chatId, txHash, eventIndex, kind, JSON.stringify(events), block, chainTime, body, thread, digest === null ? null : JSON.stringify(digest), replyTo).changes === 1;
    // Re-posted after a correction: a later reorg of it may be corrected again.
    if (added && kind !== 'correction' && eventIndex >= 0) {
      this.#q("UPDATE deliveries SET state = 'orphaned' WHERE chat_id = ? AND tx_hash = ? AND event_index = ? AND kind = 'correction'")
        .run(chatId, txHash, CORRECTION - eventIndex);
    }
    return added;
  }
  /** Pending alerts of chats that are not paused, in the order they were found (chain order), with the chat's type. */
  pending(limit = 1000) {
    return this.#q(`SELECT d.seq, d.chat_id, d.body, d.thread_id, d.digest, d.kind, d.tx_hash, d.block, d.reply_to, c.type FROM deliveries d
      LEFT JOIN chats c ON c.chat_id = d.chat_id WHERE d.state = 'pending' AND coalesce(c.paused, 0) = 0 ORDER BY d.seq LIMIT ?`).all(limit);
  }
  /** Alerts and trades in blocks after `block` that are still on the chain as far as Cairn knows: a reorg re-checks them. */
  after(block) {
    return this.#q(`SELECT seq, chat_id, tx_hash, event_index, block, state, message_id, thread_id FROM deliveries
      WHERE ${CHAIN_KINDS} AND block > ? AND state IN ('pending', 'sent', 'summarized') ORDER BY seq`).all(block);
  }
  /**
   * The node no longer has the row's transaction: it is orphaned, and when the chat saw it (sent, or in a
   * summary) it gets `correction`, replying to that message. An alert still pending is simply never sent.
   */
  orphan(row, correction) {
    this.#q("UPDATE deliveries SET state = 'orphaned', body = NULL, digest = NULL WHERE seq = ?").run(row.seq);
    if (row.state === 'pending' || !Number.isSafeInteger(row.message_id)) return false;
    return this.add({ chatId: row.chat_id, txHash: row.tx_hash, eventIndex: CORRECTION - row.event_index, kind: 'correction',
      block: row.block, chainTime: correction.chainTime, body: correction.body, thread: row.thread_id, replyTo: row.message_id });
  }
  /** The chats (and topics) a notice went to: a recovery goes where its stall went. */
  recipients(txHash, eventIndex) {
    return this.#q('SELECT chat_id, thread_id FROM deliveries WHERE tx_hash = ? AND event_index = ? ORDER BY seq').all(txHash, eventIndex);
  }
  /** The row's transaction is in another block now (re-included by the fork). */
  moved(seq, block) { this.#q('UPDATE deliveries SET block = ? WHERE seq = ?').run(block, seq); }
  sent(seq, messageId) { this.#q("UPDATE deliveries SET state = 'sent', message_id = ?, body = NULL, digest = NULL WHERE seq = ?").run(messageId, seq); }
  /** Delivered inside a group's summary: the key stays, the text goes, and the summary's message_id is kept. */
  summarized(seq, messageId) { this.#q("UPDATE deliveries SET state = 'summarized', message_id = ?, body = NULL, digest = NULL WHERE seq = ?").run(messageId, seq); }
  /** Telegram refused it for good (not a 403 or a migration): keep the key, drop the text. */
  dropped(seq) { this.#q("UPDATE deliveries SET state = 'dropped', body = NULL, digest = NULL WHERE seq = ?").run(seq); }
  /** The message an alert became, for later corrections. */
  messageId(chatId, txHash, eventIndex) {
    return this.#q('SELECT message_id FROM deliveries WHERE chat_id = ? AND tx_hash = ? AND event_index = ?').get(chatId, txHash, eventIndex)?.message_id ?? null;
  }
  prune(now) { this.#q('DELETE FROM deliveries WHERE chain_time < ?').run(now - LEDGER_TTL); }
}
