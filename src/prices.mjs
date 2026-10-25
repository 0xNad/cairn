import { FIELD, NodeValueError, SELECTORS, unsigned } from './felt.mjs';
import { decimal, escapeHtml } from './format.mjs';

export const shortString = (s) => `0x${Buffer.from(s, 'ascii').toString('hex')}`;
/** Exact oracle answer. Unknown, malformed and future-dated values never price an alert. */
export function parsePrice(words, now, maxAge) {
  if (!Array.isArray(words) || words.length < 5) throw new NodeValueError();
  const [value, decimals, timestamp, sources, option] = words.map(w => unsigned(w, FIELD));
  if (decimals > 36n || timestamp > BigInt(Number.MAX_SAFE_INTEGER) || sources > BigInt(Number.MAX_SAFE_INTEGER) ||
      (option !== 0n && option !== 1n) || words.length !== (option === 0n ? 6 : 5)) throw new NodeValueError();
  if (value === 0n && timestamp === 0n) return null;
  const age = now - Number(timestamp);
  const expiration = option === 0n ? unsigned(words[5], FIELD) : null;
  return { value, decimals: Number(decimals), timestamp: Number(timestamp), sources: Number(sources), age,
    fresh: value > 0n && sources > 0n && age >= 0 && age <= maxAge && (expiration === null || expiration >= BigInt(now)) };
}
export function usdParts(units, token, price) {
  if (!token.verified || !price?.fresh) return null;
  return { numerator: units * price.value, denominator: 10n ** BigInt(token.decimals + price.decimals) };
}
export function usdValue(units, token, price) {
  const ratio = usdParts(units, token, price);
  if (!ratio) return null;
  const { numerator: n, denominator: d } = ratio;
  if (n > 0n && n * 100n < d) return '<$0.01';
  const cents = (n * 100n * 2n + d) / (2n * d);
  return `$${decimal(cents / 100n, 0)}.${String(cents % 100n).padStart(2, '0')}`;
}
export function meetsUsd(units, token, price, floor, scale = 18) {
  const r = usdParts(units, token, price);
  return !!r && r.numerator * 10n ** BigInt(scale) >= BigInt(floor) * r.denominator;
}
export class Prices {
  constructor(config, rpc) { this.config = config; this.rpc = rpc; this.reset(); }
  reset() { this.cache = new Map(); }
  async get(token, now, block = 'latest') {
    const address = this.config.contracts?.pragma;
    if (!address || !token.verified || !token.pragma_pair) return null;
    const key = `${token.pragma_pair}:${now}:${JSON.stringify(block)}`;
    if (!this.cache.has(key)) this.cache.set(key, (async () => {
      try {
        const answer = await this.rpc.call('starknet_call', { request: { contract_address: address,
          entry_point_selector: SELECTORS.get_data_median, calldata: ['0x0', shortString(token.pragma_pair)] }, block_id: block });
        return parsePrice(answer, now, this.config.priceMaxAge);
      } catch { return null; } // Oracle failure affects only this pair; transfers still alert.
    })());
    return this.cache.get(key);
  }
  async lines(args, tokens, head) {
    if (!this.config.contracts?.pragma) return ['Prices unavailable: Pragma is not configured for this network.'];
    if (!head) return ['node busy: prices unavailable.'];
    const names = args.trim() ? args.trim().split(/\s+/) : [...tokens.registry.values()].map(t => t.symbol);
    const lines = ['<b>Oracle prices · USD</b>'];
    for (const name of names.slice(0, 50)) {
      const token = tokens.bySymbol(name);
      if (!token) { lines.push(`${escapeHtml(name.slice(0, 40))}: unknown verified symbol.`); continue; }
      const p = await this.get(token, head.timestamp, { block_number: head.block_number });
      lines.push(p ? `${escapeHtml(token.symbol)}: $${decimal(p.value, p.decimals)} · age ${p.age}s · ${p.sources} sources${p.fresh ? '' : ' · stale / unavailable for alerts'}`
        : `${escapeHtml(token.symbol)}: no price available.`);
    }
    return lines;
  }
}
