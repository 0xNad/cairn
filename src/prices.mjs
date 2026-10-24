import { NodeBusy, RpcError } from './errors.mjs';
import { SELECTORS, shortString, unsigned } from './felt.mjs';

// Pragma prices (round 3): get_data_median(SpotEntry(pair)), scaled by the decimals it returns. A sample is
// fresh while its age in chain time is at most CAIRN_PRICE_MAX_AGE; USD values come from fresh samples only,
// and never for a token outside the registry. Samples are read per block and kept for the pass only.

/** The contract's own answers: not deployed, no such entrypoint, or the call failed (an unknown pair). */
const NO_ANSWER = new Set([20, 21, 40]);
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

export class Prices {
  constructor(config, rpc) {
    this.contract = config.contracts?.pragma ?? null;
    this.maxAge = config.priceMaxAge ?? 900;
    this.rpc = rpc;
    this.memo = new Map(); // `${pair} ${block}` → sample, for this pass
    this.until = null; // the last block of the range this pass scans
  }
  get enabled() { return this.contract !== null; }
  /** Starts a new pass: prices are read again. */
  reset() { this.memo.clear(); this.until = null; }
  /** The pass scans up to block `number`: one read of each pair there serves the earlier blocks it does not postdate. */
  horizon(number) { this.until = number; }
  /**
   * Pragma's median for `pair` at block `number`: a sample, { missing: true }, or { error } when the contract
   * refuses or answers another shape. Throws NodeBusy when the node fails, so that the caller retries.
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
      if (error instanceof RpcError && NO_ANSWER.has(error.code)) return { error: `contract error ${error.code}` };
      if (error instanceof RpcError) throw new NodeBusy();
      throw error;
    }
    return parseMedian(result) ?? { error: 'an answer Cairn cannot read' };
  }
  /**
   * The fresh USD sample of a verified token as of `block` ({ number, timestamp }), or null. Pragma moves only
   * when a publisher updates the pair, every few minutes, so the pass reads each pair once, at the end of its
   * range, and reads the trade's own block only when that sample was updated after it.
   */
  async usd(token, block) {
    if (!this.enabled || !token?.verified || !usdPair(token.pragma_pair)) return null;
    let sample = this.until !== null && this.until > block.number ? await this.sample(token.pragma_pair, this.until) : null;
    if (!sample || (sample.price !== undefined && sample.timestamp > block.timestamp)) sample = await this.sample(token.pragma_pair, block.number);
    return sample.price !== undefined && ageOf(sample, block.timestamp) <= this.maxAge ? sample : null;
  }
}
