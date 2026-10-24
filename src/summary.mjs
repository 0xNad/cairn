import { decimal, dollars, escapeHtml } from './format.mjs';

// The group budget (round 3): per group per pass, at most 3 messages that are not command replies. When more
// are due, 2 are sent and the third summarises the rest, which are then delivered, never sent again.

export const GROUP_BUDGET = 3;
export const GROUP_TYPES = new Set(['group', 'supergroup']);

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const read = (digest) => { try { return digest ? JSON.parse(digest) : null; } catch { return null; } };

/** What makes an alert worth a full message in a burst: a track update first, then the larger USD value. */
function weight(row) {
  const d = read(row?.digest);
  return { track: row?.kind === 'track', cents: d?.cents ? BigInt(d.cents) : null, token: d?.token ?? null, amount: d?.amount ? BigInt(d.amount) : 0n };
}
/** Positive when `a` should be sent in full rather than `b`; 0 keeps chain order. */
function heavier(a, b) {
  if (a.track !== b.track) return a.track ? 1 : -1;
  if ((a.cents === null) !== (b.cents === null)) return a.cents !== null ? 1 : -1;
  if (a.cents !== null) return a.cents > b.cents ? 1 : a.cents < b.cents ? -1 : 0;
  if (a.token !== null && a.token === b.token) return a.amount > b.amount ? 1 : a.amount < b.amount ? -1 : 0; // one unpriced token
  return 0;
}

/**
 * How a chat's due alerts fit its budget this pass: { full, rest } — `full` sent one by one, `rest` covered
 * by one summary. When more are due than fit, the ones sent in full are the largest by USD value (a track
 * update before any), kept in chain order, so a burst shows its biggest trades. Private chats have no budget;
 * a group that already used its budget waits for the next pass.
 */
export function plan(rows, type, used) {
  if (!GROUP_TYPES.has(type)) return { full: rows, rest: [] };
  const left = GROUP_BUDGET - used;
  if (left <= 0) return { full: [], rest: [] };
  if (rows.length <= left) return { full: rows, rest: [] };
  const weights = rows.map(weight);
  const order = rows.map((_, i) => i).sort((i, j) => heavier(weights[j], weights[i]) || i - j);
  const chosen = new Set(order.slice(0, left - 1));
  return { full: rows.filter((_, i) => chosen.has(i)), rest: rows.filter((_, i) => !chosen.has(i)) };
}

/**
 * One message for the alerts beyond a group's budget, from their ledger rows (digest, kind, block, tx_hash):
 * how many and in which blocks, the buys and sells of each token with their totals, the wallet alerts and the
 * track updates, and a link to the largest trade.
 */
export function summarise(rows, fmt) {
  const trades = new Map();
  let alerts = 0, whales = 0, tracks = 0, largest = null;
  for (const row of rows) {
    const d = read(row.digest);
    if (d?.k === 'trade') {
      const key = `${d.side} ${d.token}`;
      const t = trades.get(key) ?? trades.set(key, { ...d, count: 0, total: 0n, cents: 0n, priced: 0 }).get(key);
      t.count++;
      t.total += BigInt(d.amount);
      if (d.cents !== null) {
        t.cents += BigInt(d.cents);
        t.priced++;
        if (!largest || BigInt(d.cents) > BigInt(largest.d.cents)) largest = { d, tx: row.tx_hash };
      }
    } else if (row.kind === 'track') tracks++;
    else {
      alerts++;
      if (d?.whale) whales++;
    }
  }
  const blocks = rows.map((r) => r.block).filter(Number.isSafeInteger);
  const low = Math.min(...blocks), high = Math.max(...blocks);
  const where = !blocks.length ? '' : low === high ? ` in block ${low}` : ` in blocks ${low}–${high}`;
  const lines = [`➕ <b>${rows.length} more</b>${where}, summarised to keep the group readable:`];
  const symbol = (t) => (t.verified ? escapeHtml(t.symbol) : `<code>${escapeHtml(t.symbol)}</code> (unverified)`);
  for (const t of trades.values()) {
    const worth = t.priced ? ` · ≈${dollars(t.cents)}${t.priced < t.count ? ' and more' : ''}` : '';
    lines.push(`${t.side === 'buy' ? '🟢' : '🔴'} ${plural(t.count, t.side)} · ${decimal(t.total, t.decimals)} ${symbol(t)}${worth}`);
  }
  if (alerts) lines.push(`👁 ${plural(alerts, 'wallet alert')}${whales ? `, ${whales} with a whale move 🐋` : ''}`);
  if (tracks) lines.push(`⏱ ${plural(tracks, 'tracked transaction update')}`);
  if (largest) {
    const { d } = largest;
    lines.push(`Largest: ${fmt.tx(largest.tx, `${d.side === 'buy' ? 'Buy' : 'Sell'} ${decimal(BigInt(d.amount), d.decimals)} ${escapeHtml(d.symbol)} ≈${dollars(BigInt(d.cents))}`)}`);
  }
  return lines.join('\n');
}
