// The delivery ledger. Each alert is keyed by (chat, transaction hash, event_index), the first event of its
// message, and saved as pending in the same transaction as the scan that found it. It is marked sent, with
// its message_id, only once Telegram accepts it; its text is then dropped and the key kept for seven days of
// chain time, so that a rescan or a restart never sends it twice. Track stages use negative indexes.
// Round 3: each alert keeps the forum topic it posts into, and a digest, so that a group's summary can count it;
// alerts a summary covered are marked summarized, with the summary's message_id.

export const LEDGER_TTL = 7 * 24 * 3600;
export const STAGE = Object.freeze({ accepted: -1, final: -2, missing: -3, correction: -4 });

export class Ledger {
  constructor(store) { this.store = store; }
  #q(text) { return this.store.sql(text); }
  /** Saves an alert or refreshes an invalidated pending execution; false for an unchanged ledger key. */
  add({ chatId, txHash, eventIndex, kind, events = [eventIndex], block = null, chainTime, body, thread = null, digest = null }) {
    return this.store.transaction(() => {
      const saved = this.#q(`INSERT OR IGNORE INTO deliveries (chat_id, tx_hash, event_index, kind, events, block, chain_time, state, body, thread_id, digest)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        ON CONFLICT (chat_id, tx_hash, event_index) DO UPDATE SET kind = excluded.kind, events = excluded.events,
          block = excluded.block, chain_time = excluded.chain_time, body = excluded.body,
          thread_id = excluded.thread_id, digest = excluded.digest
        WHERE deliveries.state = 'pending' AND EXISTS (SELECT 1 FROM reorg_checks WHERE original_seq = deliveries.seq AND phase = 'rebuild')`).run(chatId, txHash, eventIndex, kind, JSON.stringify(events), block, chainTime, body,
        thread, digest === null ? null : JSON.stringify(digest)).changes === 1;
      if (saved) this.#q(`DELETE FROM reorg_checks WHERE phase = 'rebuild' AND original_seq IN
        (SELECT seq FROM deliveries WHERE chat_id = ? AND tx_hash = ? AND event_index = ?)`).run(chatId, txHash, eventIndex);
      return saved;
    });
  }
  /** Pending alerts of chats that are not paused, in the order they were found (chain order), with the chat's type. */
  pending(limit = 1000) {
    return this.#q(`SELECT d.seq, d.chat_id, d.body, d.thread_id, d.digest, d.kind, d.tx_hash, d.block, c.type, r.reply_to FROM deliveries d
      LEFT JOIN reorg_checks r ON r.correction_seq = d.seq
      LEFT JOIN chats c ON c.chat_id = d.chat_id WHERE d.state = 'pending' AND NOT EXISTS (SELECT 1 FROM reorg_checks WHERE original_seq = d.seq AND phase != 'corrected') AND coalesce(c.paused, 0) = 0 ORDER BY d.seq LIMIT ?`).all(limit);
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
  /** Lifecycle state is keyed by the original delivery; digests contain summary data only. */
  recheck(row, block) {
    this.#q(`INSERT INTO reorg_checks (original_seq, since_block, phase) VALUES (?, ?, 'check')
      ON CONFLICT (original_seq) DO UPDATE SET phase = 'check'
      WHERE phase != 'corrected'`).run(row.seq, block);
  }
  reorgRows(phase) {
    return this.#q(`SELECT d.*, r.since_block FROM deliveries d JOIN reorg_checks r ON r.original_seq = d.seq
      WHERE r.phase = ? ORDER BY d.seq`).all(phase);
  }
  checked(row, block = row.block) {
    this.#q('UPDATE deliveries SET block = ? WHERE seq = ?').run(block, row.seq);
    this.#q("DELETE FROM reorg_checks WHERE original_seq = ? AND phase != 'corrected'").run(row.seq);
  }
  rebuild(row, block) {
    this.#q('UPDATE deliveries SET block = ?, body = NULL, digest = NULL WHERE seq = ?').run(block, row.seq);
    this.#q("UPDATE reorg_checks SET phase = 'rebuild' WHERE original_seq = ?").run(row.seq);
  }
  finishRebuilds(through) {
    for (const row of this.reorgRows('rebuild')) if (row.kind !== 'track' && row.block <= through) {
      this.dropped(row.seq); this.checked(row);
    }
  }
  correct(original, { block, chainTime, body }) {
    return this.store.transaction(() => {
      const eventIndex = STAGE.correction - original.message_id;
      this.add({ chatId: original.chat_id, txHash: original.tx_hash, eventIndex, kind: 'correction', block, chainTime, body, thread: original.thread_id });
      const correction = this.#q('SELECT seq FROM deliveries WHERE chat_id = ? AND tx_hash = ? AND event_index = ?')
        .get(original.chat_id, original.tx_hash, eventIndex);
      this.#q(`INSERT OR REPLACE INTO reorg_checks (original_seq, since_block, phase, correction_seq, reply_to)
        VALUES (?, ?, 'corrected', ?, ?)`).run(original.seq, block, correction.seq, original.message_id);
    });
  }
  prune(now) { this.#q(`DELETE FROM deliveries WHERE chain_time < ? AND NOT EXISTS
    (SELECT 1 FROM reorg_checks r JOIN deliveries c ON c.seq = r.correction_seq
      WHERE r.original_seq = deliveries.seq AND c.state = 'pending')`).run(now - LEDGER_TTL); }
}
