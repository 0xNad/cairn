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
    return this.#q(`INSERT OR IGNORE INTO deliveries (chat_id, tx_hash, event_index, kind, events, block, chain_time, state, body, thread_id, digest)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT (chat_id, tx_hash, event_index) DO UPDATE SET kind = excluded.kind, events = excluded.events,
        block = excluded.block, chain_time = excluded.chain_time, body = excluded.body,
        thread_id = excluded.thread_id, digest = excluded.digest
      WHERE deliveries.state = 'pending' AND json_extract(deliveries.digest, '$.rebuild') = 1`).run(chatId, txHash, eventIndex, kind, JSON.stringify(events), block, chainTime, body,
      thread, digest === null ? null : JSON.stringify(digest)).changes === 1;
  }
  /** Pending alerts of chats that are not paused, in the order they were found (chain order), with the chat's type. */
  pending(limit = 1000) {
    return this.#q(`SELECT d.seq, d.chat_id, d.body, d.thread_id, d.digest, d.kind, d.tx_hash, d.block, c.type FROM deliveries d
      LEFT JOIN chats c ON c.chat_id = d.chat_id WHERE d.state = 'pending' AND json_extract(d.digest, '$.reorg') IS NULL AND json_extract(d.digest, '$.rebuild') IS NULL AND coalesce(c.paused, 0) = 0 ORDER BY d.seq LIMIT ?`).all(limit);
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
  /** Keep unresolved fork history on its original delivery; pending originals cannot be sent yet. */
  recheck(row, block) {
    const digest = JSON.parse(row.digest ?? '{}');
    digest.reorg ??= block;
    this.#q('UPDATE deliveries SET digest = ? WHERE seq = ?').run(JSON.stringify(digest), row.seq);
  }
  rechecking() { return this.#q("SELECT * FROM deliveries WHERE json_extract(digest, '$.reorg') IS NOT NULL ORDER BY seq").all(); }
  checked(row, block = row.block) {
    const digest = JSON.parse(row.digest);
    delete digest.reorg;
    this.#q('UPDATE deliveries SET digest = ?, block = ? WHERE seq = ?')
      .run(Object.keys(digest).length ? JSON.stringify(digest) : null, block, row.seq);
  }
  /** Discard orphaned execution facts; only the normal scanner or track formatter can release the row. */
  rebuild(row, block) {
    this.#q(`UPDATE deliveries SET block = ?, body = NULL, digest = '{"rebuild":true}' WHERE seq = ?`).run(block, row.seq);
  }
  rebuildingTracks() {
    return this.#q("SELECT * FROM deliveries WHERE state = 'pending' AND kind = 'track' AND json_extract(digest, '$.rebuild') = 1").all();
  }
  /** A fully scanned replacement range may no longer contain any event matching the original alert. */
  finishRebuilds(through) {
    this.#q(`UPDATE deliveries SET state = 'dropped', body = NULL, digest = NULL WHERE state = 'pending'
      AND kind IN ('alert', 'trade') AND block <= ? AND json_extract(digest, '$.rebuild') = 1`).run(through);
  }
  /** Corrections share the original transaction's ledger key space and reply to its saved message. */
  correct(original, { block, chainTime, body }) {
    return this.add({ chatId: original.chat_id, txHash: original.tx_hash, eventIndex: STAGE.correction - original.message_id,
      kind: 'correction', block, chainTime, body, thread: original.thread_id, digest: { reply: original.message_id } });
  }
  prune(now) { this.#q('DELETE FROM deliveries WHERE chain_time < ?').run(now - LEDGER_TTL); }
}
