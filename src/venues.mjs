import { FIELD, hex64, i129, normalize, SELECTORS, u256, unsigned } from './felt.mjs';

/**
 * The venues the trade feed reads (round 3), in precedence order. A venue is a contract of the network file,
 * the event its swaps emit, and a decoder from that event's data to legs: each token it moved, signed from the
 * trader's side (+ received, − paid). An aggregator comes before the pools it routes through, because in a
 * transaction where it swapped the token, the pools' events are only its route.
 *
 * Adding a venue is one entry here (its decoder and precedence) and its contract in the network file: the
 * scanner then reads one more filter on the same ranges, and the netting and trader rules apply unchanged.
 */
export const VENUES = Object.freeze([
  { key: 'avnu', name: 'AVNU', contract: 'avnu_exchange', selector: SELECTORS.Swap, aggregator: true, legs: avnuLegs },
  { key: 'ekubo', name: 'Ekubo', contract: 'ekubo_core', selector: SELECTORS.Swapped, aggregator: false, legs: ekuboLegs },
]);

/**
 * AVNU's Swap: [taker, sell_token, sell_low, sell_high, buy_token, buy_low, buy_high, beneficiary]. The taker
 * pays sell_amount of sell_token and gets buy_amount of buy_token; neither the taker nor the beneficiary
 * identifies the trader (both can be a wrapper contract).
 */
function avnuLegs(data) {
  if (data.length !== 8) return null;
  return [{ token: hex64(data[1]), amount: -u256(data.slice(2, 4)) }, { token: hex64(data[4]), amount: u256(data.slice(5, 7)) }];
}

/**
 * Ekubo Core's Swapped: keys [sel], 21 data felts, with token0 and token1 at 1 and 2 and delta.amount0 and
 * delta.amount1 (i129: magnitude, sign) at 12 to 15. A positive delta is paid into the pool, so the trader's
 * side is its opposite. The locker at 0 is always a router, never the trader.
 */
function ekuboLegs(data) {
  if (data.length !== 21) return null;
  return [{ token: hex64(data[1]), amount: -i129(data[12], data[13]) }, { token: hex64(data[2]), amount: -i129(data[14], data[15]) }];
}

/** The venues the network file names, in precedence order, each with its address and its events filter. */
export function venuesOf(config) {
  return VENUES.filter((v) => config.contracts?.[v.contract]).map((v) => Object.freeze({
    ...v, address: config.contracts[v.contract],
    filter: Object.freeze({ address: config.contracts[v.contract], keys: [[v.selector]] }),
  }));
}

const SELECTOR = new Map(VENUES.map((v) => [v.key, BigInt(v.selector)]));
// Without event_index (older nodes), a swap's place counts within its own filter, kept apart from the token
// events' places so that a trade and a wallet alert in one transaction never share a ledger key.
const ORDINAL_BASE = 1_000_000;

/**
 * A venue's raw events as swaps, in chain order: { venue, tx, block, txIndex, index, legs }. An event of
 * another shape, or from another contract, is ignored.
 */
export function decodeSwaps(venue, raw) {
  const out = [], ordinal = new Map();
  for (const e of raw) {
    try {
      if (!Array.isArray(e.keys) || !Array.isArray(e.data) || e.keys.length === 0) continue;
      if (unsigned(e.keys[0], FIELD) !== SELECTOR.get(venue.key) || hex64(e.from_address) !== venue.address) continue;
      if (!Number.isSafeInteger(e.block_number) || e.block_number < 0) continue;
      const legs = venue.legs(e.data);
      if (!legs) continue;
      const tx = normalize(e.transaction_hash, 'hash');
      const seen = ordinal.get(tx) ?? 0;
      ordinal.set(tx, seen + 1);
      out.push({ venue, tx, block: e.block_number, legs,
        txIndex: Number.isSafeInteger(e.transaction_index) ? e.transaction_index : null,
        index: Number.isSafeInteger(e.event_index) && e.event_index >= 0 ? e.event_index : ORDINAL_BASE + seen });
    } catch { /* not a swap Cairn can read: ignored */ }
  }
  return out;
}
