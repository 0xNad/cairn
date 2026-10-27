import { decimal, escapeHtml } from './format.mjs';
import { usdText } from './prices.mjs';

// The group budget (round 3): per group per pass, at most 3 messages that are not command replies. When more
// are due, 2 are sent and the third summarises the rest, which are then delivered, never sent again.

export const GROUP_BUDGET = 3;
export const GROUP_TYPES = new Set(['group', 'supergroup']);
const POLICY = Object.freeze({ network: { individual: true }, correction: { individual: true } });
const MAX_LINKS = 10; // transaction links a summary lists for its wallet alerts and for its track updates

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const read = (digest) => { try { return digest ? JSON.parse(digest) : null; } catch { return null; } };

/**
 * What makes an alert worth a full message in a burst: a track update first (someone asked for it), then an
 * approval by a watched wallet, then the larger USD value.
 */
function weight(row) {
  const d = read(row?.digest);
  return { track: row?.kind === 'track', approval: d?.approval === true, cents: d?.cents ? BigInt(d.cents) : null,
    token: d?.token ?? null, amount: d?.amount ? BigInt(d.amount) : 0n };
}
/** Positive when `a` should be sent in full rather than `b`; 0 keeps chain order. */
function heavier(a, b) {
  if (a.track !== b.track) return a.track ? 1 : -1;
  if (a.approval !== b.approval) return a.approval ? 1 : -1;
  if ((a.cents === null) !== (b.cents === null)) return a.cents !== null ? 1 : -1;
  if (a.cents !== null) return a.cents > b.cents ? 1 : a.cents < b.cents ? -1 : 0;
  if (a.token !== null && a.token === b.token) return a.amount > b.amount ? 1 : a.amount < b.amount ? -1 : 0; // one unpriced token
  return 0;
}

/**
 * How a chat's due alerts fit its budget this pass: { full, rest } — `full` sent one by one, `rest` covered
 * by one summary. When more are due than fit, the ones sent in full are the weightiest (above), kept in chain
 * order, so a burst shows its biggest trades. Private chats have no budget; a group that already used its
 * budget waits for the next pass. Individual notices consume slots first and are never summarized.
 */
export function plan(rows, type, used) {
  if (!GROUP_TYPES.has(type)) return { full: rows, rest: [] };
  const left = GROUP_BUDGET - used;
  if (left <= 0) return { full: [], rest: [] };
  const individual = rows.filter(row => POLICY[row?.kind]?.individual);
  const full = individual.slice(0, left), remaining = left - full.length;
  if (!remaining) return { full, rest: [] };
  const candidates = rows.filter(row => !POLICY[row?.kind]?.individual);
  if (candidates.length <= remaining) return { full: [...full, ...candidates], rest: [] };
  const weights = candidates.map(weight);
  const order = candidates.map((_, i) => i).sort((i, j) => heavier(weights[j], weights[i]) || i - j);
  const chosen = new Set(order.slice(0, remaining - 1));
  return { full: [...full, ...candidates.filter((_, i) => chosen.has(i))], rest: candidates.filter((_, i) => !chosen.has(i)) };
}

/** Exact USD values with power-of-ten denominators, added up. */
const add = (a, b) => (a.den >= b.den ? { num: a.num + b.num * (a.den / b.den), den: a.den } : { num: a.num * (b.den / a.den) + b.num, den: b.den });
/** A trade digest's exact USD value, or null (a digest that kept only cents gives them). */
const valueIn = (d) => (d.value ? { num: BigInt(d.value[0]), den: BigInt(d.value[1]) } : d.cents ? { num: BigInt(d.cents), den: 100n } : null);

/**
 * One message for the alerts beyond a group's budget, from their ledger rows (digest, kind, block, tx_hash):
 * how many and in which blocks, the buys and sells of each token with their totals, the wallet alerts and the
 * track updates with a link to each, and a link to the largest trade.
 */
export function summarise(rows, fmt) {
  const trades = new Map(), alerts = [], tracks = [];
  let whales = 0, approvals = 0, largest = null;
  for (const row of rows) {
    const d = read(row.digest);
    if (d?.k === 'trade') {
      const key = `${d.side} ${d.token}`;
      const t = trades.get(key) ?? trades.set(key, { ...d, count: 0, total: 0n, value: { num: 0n, den: 1n }, priced: 0 }).get(key);
      t.count++;
      t.total += BigInt(d.amount);
      if (valueIn(d)) {
        t.value = add(t.value, valueIn(d));
        t.priced++;

      }
      if (!largest || heavier(weight(row), weight(largest.row)) > 0) largest = { d, tx: row.tx_hash, row };
    } else if (row.kind === 'track') tracks.push(row);
    else {
      alerts.push(row);
      if (d?.whale) whales++;
      if (d?.approval) approvals++;
    }
  }
  const blocks = rows.map((r) => r.block).filter(Number.isSafeInteger);
  const low = Math.min(...blocks), high = Math.max(...blocks);
  const where = !blocks.length ? '' : low === high ? ` in block ${low}` : ` in blocks ${low}–${high}`;
  const lines = [`➕ <b>${rows.length} more</b>${where}, summarised to keep the group readable:`];
  const symbol = (t) => (t.verified ? escapeHtml(t.symbol) : `<code>${escapeHtml(t.symbol)}</code> (unverified)`);
  for (const t of trades.values()) {
    const worth = t.priced ? ` · ≈${escapeHtml(usdText(t.value))}${t.priced < t.count ? ' and more' : ''}` : '';
    lines.push(`${t.side === 'buy' ? '🟢' : '🔴'} ${plural(t.count, t.side)} · ${decimal(t.total, t.decimals)} ${symbol(t)}${worth}`);
  }
  const linked = (list) => {
    const shown = list.slice(0, MAX_LINKS).map((row, i) => fmt.tx(row.tx_hash, String(i + 1))).join(' · ');
    return `${shown}${list.length > MAX_LINKS ? ` and ${list.length - MAX_LINKS} more` : ''}`;
  };
  if (alerts.length) {
    const marks = [whales && `${whales} with a whale move 🐋`, approvals && `${approvals} with an approval 🔑`].filter(Boolean);
    lines.push(`👁 ${plural(alerts.length, 'wallet alert')}${marks.length ? `, ${marks.join(', ')}` : ''}: ${linked(alerts)}`);
  }
  if (tracks.length) lines.push(`⏱ ${plural(tracks.length, 'tracked transaction update')}: ${linked(tracks)}`);
  if (largest) {
    const { d } = largest;
    const worth = valueIn(d) ? ` ≈${escapeHtml(usdText(valueIn(d)))}` : '';
    lines.push(`Largest: ${fmt.tx(largest.tx, `${d.side === 'buy' ? 'Buy' : 'Sell'} ${decimal(BigInt(d.amount), d.decimals)} ${escapeHtml(d.symbol)}${worth}`)}`);
  }
  return lines.join('\n');
}
