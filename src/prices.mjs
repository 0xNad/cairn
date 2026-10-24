import { FIELD, NodeValueError, SELECTORS, unsigned } from './felt.mjs';
import { decimal } from './format.mjs';

/** Oracle samples are shared by pair for one pass; no old sample masks a failed fresh read. */
export class Prices {
  constructor(config, rpc) { this.config = config; this.rpc = rpc; this.reset(); }
  reset() { this.samples = new Map(); }
  async get(token, now) {
    if (!token?.verified) return unavailable(token?.verified === false ? 'unverified token' : 'unknown symbol');
    if (!token.pragma_pair) return unavailable('no Pragma pair configured');
    if (!this.config.contracts?.pragma) return unavailable('no Pragma contract configured');
    const pair = token.pragma_pair;
    if (!this.samples.has(pair)) this.samples.set(pair, this.read(pair, now));
    return this.samples.get(pair);
  }
  async read(pair, now) {
    try {
      const a = await this.rpc.call('starknet_call', { request: {
        contract_address: this.config.contracts.pragma, entry_point_selector: SELECTORS.get_data_median,
        calldata: ['0x0', `0x${Buffer.from(pair, 'ascii').toString('hex')}`],
      }, block_id: 'latest' });
      return decodePrice(a, now, this.config.priceMaxAge);
    } catch { return unavailable('oracle read failed'); }
  }
  async usd(token, units, now) {
    const p = await this.get(token, now);
    return p?.fresh ? formatUSD(units * p.price, 10n ** BigInt(token.decimals + p.decimals)) : '';
  }
}

export function decodePrice(a, now, maxAge = 900) {
  if (!Array.isArray(a) || ![5, 6].includes(a.length)) throw new NodeValueError();
  const [price, d, timestamp, sources, tag] = a.map(v => unsigned(v, FIELD));
  if (d > 36n || timestamp > BigInt(Number.MAX_SAFE_INTEGER) || (tag === 0n ? a.length !== 6 : tag !== 1n || a.length !== 5)) throw new NodeValueError();
  if (price === 0n && timestamp === 0n) return { status: 'missing', fresh: false };
  const age = Math.max(0, now - Number(timestamp));
  return { status: 'ok', price, decimals: Number(d), age, sources, fresh: age <= maxAge };
}

/** Rational USD, rounded half up to cents; retain the below-one-cent signal before rounding. */
export function formatUSD(numerator, denominator) {
  if (numerator > 0n && numerator * 100n < denominator) return '<$0.01';
  const cents = (numerator * 100n + denominator / 2n) / denominator;
  return `$${decimal(cents / 100n, 0)}.${(cents % 100n).toString().padStart(2, '0')}`;
}

export const unavailable = reason => ({ status: 'unavailable', reason, fresh: false });

/** Plain text; the command escapes it along with other replies. */
export function priceLine(token, sample) {
  const prefix = `${token.symbol}: `;
  if (sample.status === 'missing') return prefix + 'no price';
  if (sample.status === 'unavailable') return prefix + `unavailable (${sample.reason})`;
  return prefix + `$${decimal(sample.price, sample.decimals)} · ${sample.age} seconds old · ${sample.sources} sources${sample.fresh ? '' : ' · stale'}`;
}
