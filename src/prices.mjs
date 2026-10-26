// Pragma prices: `get_data_median(SpotEntry(pair))` on the configured oracle, read at the latest block and
// judged fresh against the chain's own time. USD values are computed exactly, in cents, from base units.
import { FIELD, NodeValueError, unsigned } from './felt.mjs';
import { decimal } from './format.mjs';

export const GET_DATA_MEDIAN = '0x0024b869ce68dd257b370701ca16e4aaf9c6483ff6805d04ba7661f3a0b6ce59';
/** A Cairo short string such as `STRK/USD`, as calldata. */
export const shortString = (s) => `0x${Buffer.from(s, 'latin1').toString('hex') || '0'}`;
const MAX_DECIMALS = 36n;

/**
 * The median price of `pair`, or null when Pragma has none (a zero price or timestamp). Returns
 * { pair, price, decimals, usd, age, sources, fresh }: `usd` is the exact decimal, `age` the seconds between
 * the last update and `now` (chain time), and `fresh` whether that age is at most `maxAge`. Node and contract
 * errors propagate, so the caller can say which pair failed.
 */
export async function readPrice(rpc, pragma, pair, now, maxAge) {
  const answer = await rpc.call('starknet_call', { request: {
    contract_address: pragma, entry_point_selector: GET_DATA_MEDIAN, calldata: ['0x0', shortString(pair)],
  }, block_id: 'latest' });
  // [price, decimals, last_updated_timestamp, num_sources_aggregated, expiration: Option<u64>]
  if (!Array.isArray(answer) || (answer.length !== 5 && answer.length !== 6)) throw new NodeValueError();
  const price = unsigned(answer[0], FIELD), decimals = unsigned(answer[1], FIELD);
  const updated = unsigned(answer[2], FIELD), sources = unsigned(answer[3], FIELD);
  if (price === 0n || updated === 0n) return null;
  if (decimals > MAX_DECIMALS || updated > BigInt(Number.MAX_SAFE_INTEGER) || sources > 1_000_000n) throw new NodeValueError();
  const age = now - Number(updated);
  return {
    pair, price, decimals: Number(decimals), usd: decimal(price, Number(decimals)).replaceAll(',', ''),
    age, sources: Number(sources), fresh: age <= maxAge,
  };
}

/** Cents of `amount` base units at `quote`, rounded down. */
const cents = (amount, tokenDecimals, quote) => (amount * quote.price * 100n) / 10n ** BigInt(tokenDecimals + quote.decimals);

/** `amount` base units in dollars, rounded down to the cent, such as `1,250.00`. */
export function usdValue(amount, tokenDecimals, quote) {
  const c = cents(amount, tokenDecimals, quote);
  return `${decimal(c / 100n, 0)}.${(c % 100n).toString().padStart(2, '0')}`;
}

/** Whether `amount` base units are worth at least `floorCents`, compared exactly (equality included). */
export function atLeastUsd(amount, tokenDecimals, quote, floorCents) {
  return amount * quote.price * 100n >= floorCents * 10n ** BigInt(tokenDecimals + quote.decimals);
}

/**
 * The prices one scan pass uses, read once per pair: only a fresh quote is returned, so a stale, missing or
 * failed price leaves USD values out (and a dollar floor unmet) rather than inventing one.
 */
export function freshQuotes(rpc, config, now) {
  const cache = new Map();
  return {
    async fresh(token) {
      const pair = token?.pragma_pair;
      if (!config.contracts.pragma || !pair) return null;
      if (!cache.has(pair)) {
        let quote = null;
        try { quote = await readPrice(rpc, config.contracts.pragma, pair, now, config.priceMaxAge); } catch { /* no USD this pass */ }
        cache.set(pair, quote?.fresh ? quote : null);
      }
      return cache.get(pair);
    },
  };
}
