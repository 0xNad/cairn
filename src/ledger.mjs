// The delivery ledger. Each alert is keyed by (chat, transaction hash, event_index), the first event of its
// message, and saved as pending in the same transaction as the scan that found it. It is marked sent, with
// its message_id, only once Telegram accepts it; its text is then dropped and the key kept for seven days of
// chain time, so that a rescan or a restart never sends it twice. Track stages use negative indexes.
// Round 3: each alert keeps the forum topic it posts into, and a digest, so that a group's summary can count it;
// alerts a summary covered are marked summarized, with the summary's message_id.

export const LEDGER_TTL = 7 * 24 * 3600;
export const STAGE = Object.freeze({ accepted: -1, final: -2, missing: -3 });

export class Ledger {
  constructor(store) { this.store = store; }
  #q(text) { return this.store.sql(text); }
  /** Saves an alert before it is sent; false when its key is already in the ledger. */
  add({ chatId, txHash, eventIndex, kind, events = [eventIndex], block = null, chainTime, body, thread = null, digest = null }) {
    // A re-included transaction may have different event indexes. A delivered transaction stays delivered.
    if (block !== null && this.#q("SELECT 1 FROM deliveries WHERE chat_id = ? AND tx_hash = ? AND state IN ('sent','summarized','orphaned') AND event_index >= 0").get(chatId, txHash)) return false;
    return this.#q(`INSERT OR IGNORE INTO deliveries (chat_id, tx_hash, event_index, kind, events, block, chain_time, state, body, thread_id, digest)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(chatId, txHash, eventIndex, kind, JSON.stringify(events), block, chainTime, body,
      thread, digest === null ? null : JSON.stringify(digest)).changes === 1;
  }
  /** Pending alerts of chats that are not paused, in the order they were found (chain order), with the chat's type. */
  pending(limit = 1000) {
    return this.#q(`SELECT d.seq, d.chat_id, d.body, d.thread_id, d.digest, d.kind, d.tx_hash, d.block, c.type FROM deliveries d
      LEFT JOIN chats c ON c.chat_id = d.chat_id WHERE d.state = 'pending' AND coalesce(c.paused, 0) = 0 ORDER BY d.seq LIMIT ?`).all(limit);
  }
  sent(seq, messageId) { this.#q("UPDATE deliveries SET state = 'sent', message_id = ?, body = NULL, digest = NULL WHERE seq = ?").run(messageId, seq); }
  /** Delivered inside a group's summary: the key stays, the text goes, and the summary's message_id is kept. */
  summarized(seq, messageId) { this.#q("UPDATE deliveries SET state = 'summarized', message_id = ?, body = NULL, digest = NULL WHERE seq = ?").run(messageId, seq); }
  /** Telegram refused it for good (not a 403 or a migration): keep the key, drop the text. */
  dropped(seq) { this.#q("UPDATE deliveries SET state = 'dropped', body = NULL, digest = NULL WHERE seq = ?").run(seq); }
  /** The message an alert became, for later corrections. */
  messageId(chatId, txHash, eventIndex) {
    return this.#q('SELECT message_id FROM deliveries WHERE chat_id = ? AND tx_hash = ? AND event_index = ?').get(chatId, txHash, eventIndex)?.message_id ?? null;
  }
  prune(now) {
    this.#q('DELETE FROM deliveries WHERE chain_time < ?').run(now - LEDGER_TTL);
    this.#q('DELETE FROM corrections WHERE seq NOT IN (SELECT seq FROM deliveries)').run();
  }
}
