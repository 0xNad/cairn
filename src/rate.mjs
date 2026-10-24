// Per-user command limits, measured on message.date: at most 10 commands in any 60 s. The first command
// beyond gets one slow-down notice, later ones are ignored until the window passes. Only the sender's id
// and the dates of their last commands are kept, for a minute.

export const RATE = Object.freeze({ commands: 10, seconds: 60 });

export class RateLimit {
  constructor(store) { this.store = store; }
  #recent(sender, date) {
    const row = this.store.sql('SELECT dates, noticed FROM rate WHERE sender = ?').get(sender);
    const dates = row ? JSON.parse(row.dates).filter((d) => d > date - RATE.seconds && d <= date) : [];
    return { dates, noticed: row?.noticed === 1 };
  }
  /** "ok", "notice" (the first command over the limit) or "ignore". Reads only. */
  verdict(sender, date) {
    if (!Number.isSafeInteger(sender) || !Number.isSafeInteger(date)) return 'ok';
    const { dates, noticed } = this.#recent(sender, date);
    if (dates.length < RATE.commands) return 'ok';
    return noticed ? 'ignore' : 'notice';
  }
  /** Records the verdict, inside the transaction that confirms the update. */
  note(sender, date, verdict) {
    if (!Number.isSafeInteger(sender) || !Number.isSafeInteger(date)) return;
    const { dates } = this.#recent(sender, date);
    if (verdict === 'ok') dates.push(date);
    this.store.sql(`INSERT INTO rate (sender, dates, noticed, last) VALUES (?, ?, ?, ?)
      ON CONFLICT (sender) DO UPDATE SET dates = excluded.dates, noticed = excluded.noticed, last = excluded.last`)
      .run(sender, JSON.stringify(dates), verdict === 'ok' ? 0 : 1, date);
    this.prune(date);
  }
  /** Forgets everyone whose last command is more than a minute old (each pass runs it on chain time). */
  prune(now) { this.store.sql('DELETE FROM rate WHERE last < ?').run(now - RATE.seconds); }
}
