import { FIELD, hex64, normalize, U128, u256, unsigned } from './felt.mjs';

/** An i129 (magnitude felt, sign felt): sign 1 is negative. */
const i129 = (magnitude, sign) => {
  const m = unsigned(magnitude, U128);
  return unsigned(sign, 2n) === 1n ? -m : m;
};

/**
 * The venues the trade feed reads, in precedence order: an aggregator first, because its Swap already nets
 * the pool hops it routed through, so a transaction it touched is read from it alone. Each venue names its
 * network-file contract, its event selector, and how one event's data becomes legs: a token and the change
 * in the trader's holdings (positive received, negative paid). A third venue is one more entry here.
 */
export const VENUES = Object.freeze([
  {
    name: 'AVNU', contract: 'avnu_exchange',
    selector: '0x00e316f0d9d2a3affa97de1d99bb2aac0538e2666d0d8545545ead241ef0ccab', // Swap
    // [taker, sell_token, sell_low, sell_high, buy_token, buy_low, buy_high, beneficiary]
    legs: (d) => d.length !== 8 ? null : [
      { token: hex64(d[1]), delta: -u256(d.slice(2, 4)) },
      { token: hex64(d[4]), delta: u256(d.slice(5, 7)) },
    ],
  },
  {
    name: 'Ekubo', contract: 'ekubo_core',
    selector: '0x0157717768aca88da4ac4279765f09f4d0151823d573537fbbeb950cdbd9a870', // Swapped
    // 21 felts: token0 at 1, token1 at 2, delta.amount0 at 12–13 and delta.amount1 at 14–15. A pool delta is
    // what was paid into the pool, so the trader's change is its opposite.
    legs: (d) => d.length !== 21 ? null : [
      { token: hex64(d[1]), delta: -i129(d[12], d[13]) },
      { token: hex64(d[2]), delta: -i129(d[14], d[15]) },
    ],
  },
]);

/** The venues this network file configures, each with its contract address. */
export const enabledVenues = (config) => VENUES.filter((v) => config.contracts[v.contract]).map((v) => ({ ...v, address: config.contracts[v.contract] }));

/** The scanner filter for one venue: its own contract and event, read alongside round 2's chain-wide filter. */
export const venueFilter = (venue) => ({ address: venue.address, keys: [[venue.selector]] });

/** A venue's raw events as swaps { venue, tx, block, index, legs }, in chain order; any other shape is dropped. */
export function decodeSwaps(venue, raw) {
  const out = [], ordinal = new Map(), selector = BigInt(venue.selector);
  for (const e of raw ?? []) {
    try {
      if (!Array.isArray(e.keys) || !Array.isArray(e.data) || unsigned(e.keys[0], FIELD) !== selector) continue;
      if (hex64(e.from_address) !== venue.address || !Number.isSafeInteger(e.block_number)) continue;
      const legs = venue.legs(e.data);
      if (!legs) continue;
      const tx = normalize(e.transaction_hash, 'hash');
      const seen = ordinal.get(tx) ?? 0;
      ordinal.set(tx, seen + 1);
      const index = Number.isSafeInteger(e.event_index) && e.event_index >= 0 ? e.event_index : seen;
      out.push({ venue, tx, block: e.block_number, index, legs });
    } catch { /* not a swap Cairn can read: ignored */ }
  }
  return out;
}

/**
 * The brief's netting rule for one transaction and one token: the first venue, in precedence order, with a
 * swap involving the token nets it over its own swaps, and the other venues' events in that transaction are
 * ignored. Returns { venue, net, paid: [token, delta] | null, index } or null when no venue touched the token.
 */
export function netTrade(swaps, token) {
  for (const venue of VENUES) {
    const mine = swaps.filter((s) => s.venue.name === venue.name && s.legs.some((l) => l.token === token));
    if (!mine.length) continue;
    const totals = new Map();
    for (const s of mine) for (const l of s.legs) totals.set(l.token, (totals.get(l.token) ?? 0n) + l.delta);
    const net = totals.get(token);
    // What changed hands for it: the other token moving the opposite way, the largest such amount.
    let paid = null;
    for (const [other, delta] of totals) {
      if (other === token || delta === 0n || (delta > 0n) === (net > 0n)) continue;
      if (!paid || (delta < 0n ? -delta : delta) > (paid[1] < 0n ? -paid[1] : paid[1])) paid = [other, delta];
    }
    return { venue: mine[0].venue, net, paid, index: Math.min(...mine.map((s) => s.index)) };
  }
  return null;
}

/**
 * The trader: never the transaction's sender (relayers and paymasters send for others), but the address
 * whose holdings of the token changed most over the transaction's own Transfer events, in the trade's
 * direction. `excluded` holds the zero address and the venue contracts; the caller leaves the fee payment
 * out. A tie goes to the address that appears at the earliest event_index. Null when nobody qualifies.
 */
export function findTrader(transfers, side, excluded) {
  const net = new Map(), first = new Map();
  for (const t of transfers) {
    for (const [address, delta] of [[t.a, -t.amount], [t.b, t.amount]]) {
      if (excluded.has(address)) continue;
      net.set(address, (net.get(address) ?? 0n) + delta);
      if (!first.has(address) || t.index < first.get(address)) first.set(address, t.index);
    }
  }
  let best = null;
  for (const [address, change] of net) {
    const gain = side === 'buy' ? change : -change;
    if (gain <= 0n) continue;
    if (!best || gain > best.gain || (gain === best.gain && first.get(address) < best.first)) best = { address, gain, first: first.get(address) };
  }
  return best?.address ?? null;
}
