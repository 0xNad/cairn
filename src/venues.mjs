import { hex64, normalize, SELECTORS, U128, u256, unsigned } from './felt.mjs';

const signed = (mag, sign) => unsigned(mag, U128) * (unsigned(sign, 2n) === 1n ? -1n : 1n);
/** A venue describes one scanner filter and returns deltas from the trader's perspective. */
const DEFINITIONS = [
  { key: 'ekubo_core', name: 'Ekubo', priority: 0, selector: SELECTORS.Swapped, decode(e) {
    if (e.data.length !== 21) return null;
    const d = e.data;
    return [[hex64(d[1]), -signed(d[12], d[13])], [hex64(d[2]), -signed(d[14], d[15])]];
  } },
  { key: 'avnu_exchange', name: 'AVNU', priority: 1, selector: SELECTORS.Swap, decode(e) {
    if (e.data.length !== 8) return null;
    const d = e.data;
    return [[hex64(d[1]), -u256(d.slice(2, 4))], [hex64(d[4]), u256(d.slice(5, 7))]];
  } },
];
export function venues(contracts = {}) {
  return DEFINITIONS.filter(v => contracts[v.key]).map(v => ({ ...v, filter: { address: contracts[v.key], keys: [[v.selector]] } }));
}

export function decodeVenue(raw, venue) {
  const out = [];
  for (const e of raw) {
    try {
      if (hex64(e.from_address) !== venue.filter.address || e.keys?.length !== 1 || BigInt(e.keys[0]) !== BigInt(venue.selector)) continue;
      const deltas = venue.decode(e);
      if (!deltas || !Number.isSafeInteger(e.block_number) || e.block_number < 0) continue;
      out.push({ venue: venue.name, priority: venue.priority, tx: normalize(e.transaction_hash, 'hash'), block: e.block_number,
        index: Number.isSafeInteger(e.event_index) ? e.event_index : 0, deltas });
    } catch { /* malformed venue events cannot become trades */ }
  }
  return out;
}

const priority = event => event.priority ?? DEFINITIONS.find(v => v.name === event.venue)?.priority ?? 0;

/** AVNU has precedence only when one of its swaps involves the selected token. */
export function netTrade(events, token) {
  const relevant = events.filter(e => e.deltas.some(([t]) => t === token));
  const venue = relevant.sort((a, b) => priority(b) - priority(a))[0]?.venue;
  const chosen = events.filter(e => e.venue === venue), deltas = new Map();
  for (const e of chosen) for (const [t, amount] of e.deltas) deltas.set(t, (deltas.get(t) ?? 0n) + amount);
  const net = deltas.get(token) ?? 0n;
  return { net, deltas, venue, index: chosen[0]?.index ?? 0 };
}
