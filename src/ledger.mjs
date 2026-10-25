// The delivery ledger. Each alert is keyed by (chat, transaction hash, event_index), the first event of its
// message, and saved as pending in the same transaction as the scan that found it. It is marked sent, with
// its message_id, only once Telegram accepts it; its text is then dropped and the key kept for seven days of
// chain time, so that a rescan or a restart never sends it twice. Track stages use negative indexes.

export const LEDGER_TTL = 7 * 24 * 3600;
export const STAGE = Object.freeze({ accepted: -1, final: -2, missing: -3 });

export class Ledger {
  constructor(store) { this.store = store; }
  #q(text) { return this.store.sql(text); }
  /** Saves an alert before it is sent; false when its key is already in the ledger. */
  add({ chatId, txHash, eventIndex, kind, events = [eventIndex], block = null, chainTime, body, topic = 0 }) {
    return this.#q(`INSERT OR IGNORE INTO deliveries (chat_id, tx_hash, event_index, kind, events, block, chain_time, state, body, topic)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`).run(chatId, txHash, eventIndex, kind, JSON.stringify(events), block, chainTime, body, topic).changes === 1;
  }
  /** Pending alerts of chats that are not paused, in the order they were found (chain order). */
  pending(limit = -1) {
    return this.#q(`SELECT d.seq, d.chat_id, d.body, d.topic, d.tx_hash, d.event_index, d.block, d.chain_time, d.kind, c.type FROM deliveries d LEFT JOIN chats c ON c.chat_id = d.chat_id
      WHERE d.state = 'pending' AND coalesce(c.paused, 0) = 0 ORDER BY d.seq LIMIT ?`).all(limit);
  }
  sent(seq, messageId) { this.#q("UPDATE deliveries SET state = 'sent', message_id = ?, body = NULL WHERE seq = ? OR summary_seq = ?").run(messageId, seq, seq); }
  /** Telegram refused it for good (not a 403 or a migration): keep the key, drop the text. */
  dropped(seq) { this.#q("UPDATE deliveries SET state = 'dropped', body = NULL WHERE seq = ? OR summary_seq = ?").run(seq, seq); }
  /** Coalesce each group's backlog before any send. Commands are never in this ledger. */
  summarize(fmt) {
    const groups = new Map();
    for (const r of this.pending()) if (['group', 'supergroup'].includes(r.type)) {
      if (!groups.has(r.chat_id)) groups.set(r.chat_id, []);
      groups.get(r.chat_id).push(r);
    }
    for (const [chatId, rows] of groups) {
      if (rows.length <= 3) continue;
      const rest = rows.slice(2), first = rest[0];
      const topics = new Set(rest.map(r => r.topic));
      let count = rest.length;
      for (const r of rest) if (r.kind === 'summary') count += Number(this.#q('SELECT count(*) AS n FROM deliveries WHERE summary_seq = ?').get(r.seq).n) - 1;
      const links = [...new Set(rest.map(r => r.tx_hash))].slice(0, 4).map((tx, i) => fmt.tx(tx, `Transaction ${i + 1}`));
      const topic = topics.size === 1 ? first.topic : 0;
      this.add({ chatId, topic, txHash: first.tx_hash, eventIndex: -100 - first.seq, kind: 'summary',
        events: rest.map(r => r.event_index), block: first.block, chainTime: first.chain_time,
        body: `<b>${count} more alerts</b> · burst summary\n${links.join(' · ')}${topics.size > 1 ? '\nAcross forum topics; individual subscriptions keep their topics.' : ''}\nUse /min, /mute or /feed to adjust this chat’s alerts.` });
      const seq = this.#q('SELECT seq FROM deliveries WHERE chat_id = ? AND tx_hash = ? AND event_index = ? AND topic = ?')
        .get(chatId, first.tx_hash, -100 - first.seq, topic).seq;
      for (const r of rest) {
        this.#q("UPDATE deliveries SET state = 'batched', summary_seq = ? WHERE seq = ? OR summary_seq = ?").run(seq, r.seq, r.seq);
      }
    }
  }
  /** The message an alert became, for later corrections. */
  messageId(chatId, txHash, eventIndex) {
    return this.#q('SELECT message_id FROM deliveries WHERE chat_id = ? AND tx_hash = ? AND event_index = ?').get(chatId, txHash, eventIndex)?.message_id ?? null;
  }
  prune(now) { this.#q('DELETE FROM deliveries WHERE chain_time < ?').run(now - LEDGER_TTL); }
}
