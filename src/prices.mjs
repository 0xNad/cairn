import { RpcError } from './errors.mjs';
import { SELECTORS, shortString, unsigned } from './felt.mjs';
import { dollars } from './format.mjs';

// Pragma prices (round 3): get_data_median(SpotEntry(pair)), scaled by the decimals it returns. A sample is
// fresh while its age in chain time is at most CAIRN_PRICE_MAX_AGE; USD values come from fresh samples only,
// and never for a token outside the registry. Samples are read per block and kept for the pass only.

const U64 = 1n << 64n, U32 = 1n << 32n;

/** Pairs Cairn reads as US dollars: only these give USD values. */
export const usdPair = (pair) => typeof pair === 'string' && pair.endsWith('/USD');

/**
 * `get_data_median`'s answer [price, decimals, last_updated_timestamp, num_sources_aggregated, exp_tag, exp?]
 * (tag 0 is Some and carries the expiration, tag 1 is None): { price, decimals, timestamp, sources },
 * { missing: true } for price 0 and timestamp 0 ("no price"), or null for any other shape.
 */
export function parseMedian(result) {
  try {
    if (!Array.isArray(result)) return null;
    const tag = result.length >= 5 ? unsigned(result[4], 2n) : null;
    if (!((tag === 1n && result.length === 5) || (tag === 0n && result.length === 6))) return null;
    const price = unsigned(result[0], 1n << 128n), decimals = unsigned(result[1], 78n);
    const timestamp = unsigned(result[2], U64), sources = unsigned(result[3], U32);
    if (price === 0n) return { missing: true };
    return { price, decimals: Number(decimals), timestamp: Number(timestamp), sources: Number(sources) };
  } catch { return null; }
}

/** Seconds of chain time since the sample was updated (0 for a timestamp ahead of the block). */
export const ageOf = (sample, now) => Math.max(0, now - sample.timestamp);

/** amount (base units of a token with `decimals`) × price ÷ 10^(decimals + pair decimals), exactly: { num, den }. */
export const valueOf = (amount, decimals, sample) => ({ num: amount * sample.price, den: 10n ** BigInt(decimals + sample.decimals) });
/** A value in cents, rounded half up. */
export const centsOf = ({ num, den }) => (200n * num + den) / (2n * den);
/** Whether the exact value is at least `cents` (a USD floor includes equality). */
export const atLeast = ({ num, den }, cents) => 100n * num >= cents * den;
/** A value as shown: rounded half up to cents, as $1,234.57, and <$0.01 for any value above zero below a cent. */
export const usdText = (value) => (value.num > 0n && 100n * value.num < value.den ? '<$0.01' : dollars(centsOf(value)));
/** Two answers of one pair are the same sample: nothing was published between the blocks they were read at. */
const same = (a, b) => a.price === b.price && a.decimals === b.decimals && a.timestamp === b.timestamp && a.sources === b.sources
  && a.missing === b.missing && a.error === b.error;

export class Prices {
  constructor(config, rpc) {
    this.contract = config.contracts?.pragma ?? null;
    this.maxAge = config.priceMaxAge ?? 900;
    this.rpc = rpc;
    this.memo = new Map(); // `${pair} ${block}` → sample, for this pass
    this.range = null; // the blocks this pass scans
  }
  get enabled() { return this.contract !== null; }
  /** Starts a new pass: prices are read again. */
  reset() { this.memo.clear(); this.range = null; }
  /** The pass scans blocks `from` to `to`: when a pair answers the same at both ends, that answer serves every block between. */
  horizon(from, to) { this.range = { from, to }; }
  /**
   * Pragma's median for `pair` at block `number`: a sample, { missing: true }, or { error } when the node or the
   * contract answers with an error (an unknown pair, a past block the node no longer serves) or another shape:
   * then there is no USD value, and alerts still go out. A node that does not answer throws NodeBusy, and the
   * pass reads the range again.
   */
  async sample(pair, number) {
    const key = `${pair} ${number}`;
    if (!this.memo.has(key)) this.memo.set(key, await this.#read(pair, number));
    return this.memo.get(key);
  }
  async #read(pair, number) {
    let result;
    try {
      result = await this.rpc.call('starknet_call', { request: { contract_address: this.contract,
        entry_point_selector: SELECTORS.get_data_median, calldata: ['0x0', shortString(pair)] }, block_id: { block_number: number } });
    } catch (error) {
      if (error instanceof RpcError) return { error: `error ${error.code}` };
      throw error;
    }
    return parseMedian(result) ?? { error: 'an answer Cairn cannot read' };
  }
  /**
   * The fresh USD sample of a verified token as of `block` ({ number, timestamp }), or null. Pragma moves only
   * when a publisher updates the pair, every few minutes: a pass reads each pair at both ends of its range, and
   * at a block between them only when the two answers differ.
   */
  async usd(token, block) {
    if (!this.enabled || !token?.verified || !usdPair(token.pragma_pair)) return null;
    const pair = token.pragma_pair, { from, to } = this.range ?? {};
    let sample;
    if (this.range && block.number > from && block.number < to) {
      const first = await this.sample(pair, from), last = await this.sample(pair, to);
      sample = same(first, last) ? last : await this.sample(pair, block.number);
    } else sample = await this.sample(pair, block.number);
    return sample.price !== undefined && ageOf(sample, block.timestamp) <= this.maxAge ? sample : null;
  }
}
