import { EndpointLost, RpcError } from './errors.mjs';
import { FIELD, hex64, NodeValueError, normalize, SELECTORS, u256, unsigned } from './felt.mjs';

/**
 * Round 2's chain-wide filter: every Transfer and Approval, from any contract. Round 3's venue filters
 * (src/venues.mjs) are read on the same ranges, and the trade feed reads its traders from this one.
 */
export const TOKEN_EVENTS = Object.freeze({ keys: [[SELECTORS.Transfer, SELECTORS.Approval]] });
const PAGE = 1000; // some providers refuse more than 1024
const MAX_PAGES = 10_000;

/**
 * The scanner: each pass reads the blocks after the cursor, at most CAIRN_MAX_BLOCKS, once per filter. A
 * range is read whole or not at all: a failed page fails the range (the cursor stays, the next pass reads it
 * again from its first page), and an invalid continuation token (error 33) restarts it. From round 4 a range is
 * read from one endpoint: its continuation tokens go back only to the endpoint that issued them, and when that
 * endpoint fails mid-range, the range restarts from its first page on the next endpoint.
 */
export class Scanner {
  constructor(rpc, config) {
    this.rpc = rpc;
    this.maxBlocks = config.maxBlocks;
  }
  /** The next range after `cursor` up to `head`, as { from, to }, or null when there is none. */
  next(cursor, head) {
    const from = cursor + 1, to = Math.min(head, cursor + this.maxBlocks);
    return from <= to ? { from, to } : null;
  }
  /** Every event `filter` matches in `range`, in chain order. */
  async events(range, filter, restarts = 2) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.#pages(range, filter); }
      catch (error) {
        const restart = (error instanceof RpcError && error.code === 33) || (error instanceof EndpointLost && this.rpc.endpoints?.length > 1);
        if (restart && attempt < restarts) continue;
        throw error;
      }
    }
  }
  async #pages(range, filter) {
    const events = [], tokens = new Set();
    let token, endpoint;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { result: answer, endpoint: used } = await this.rpc.request('starknet_getEvents', { filter: {
        from_block: { block_number: range.from }, to_block: { block_number: range.to }, ...filter, chunk_size: PAGE,
        ...(token === undefined ? {} : { continuation_token: token }),
      } }, { endpoint });
      endpoint = used; // the next page's token is only valid on this endpoint
      if (!answer || !Array.isArray(answer.events)) throw new NodeValueError();
      events.push(...answer.events);
      token = typeof answer.continuation_token === 'string' && answer.continuation_token !== '' ? answer.continuation_token : undefined;
      if (token === undefined) return events;
      if (tokens.has(token)) throw new NodeValueError(); // a node that loops would never finish the range
      tokens.add(token);
    }
    throw new NodeValueError();
  }
}

/**
 * The headers of the blocks a pass needs (time and sequencer_address), each read once: { number, timestamp,
 * sequencer }. A failed read fails the range, which the next pass reads again.
 */
export function blockHeaders(rpc) {
  const memo = new Map();
  return async (number) => {
    if (!memo.has(number)) {
      const block = await rpc.call('starknet_getBlockWithTxHashes', { block_id: { block_number: number } });
      if (!Number.isSafeInteger(block?.timestamp)) throw new NodeValueError();
      memo.set(number, { number, timestamp: block.timestamp, sequencer: hex64(block.sequencer_address ?? '0x0') });
    }
    return memo.get(number);
  };
}

const TRANSFER = BigInt(SELECTORS.Transfer), APPROVAL = BigInt(SELECTORS.Approval);
/**
 * Token events decoded by their shape alone: keys [sel, a, b] with data [low, high] is a modern ERC-20 event;
 * keys [sel] with data [a, b, low, high] is legacy (an ERC-20 only if its contract answers decimals, which
 * the caller checks); anything else, such as an NFT with its token id in the keys, is dropped. Returns
 * { kind, token, a, b, amount, legacy, block, tx, txIndex, index } in chain order; a is the sender or owner,
 * b the recipient or spender.
 */
export function decodeTokenEvents(raw) {
  const out = [], ordinal = new Map();
  for (const e of raw) {
    try {
      const keys = e.keys, data = e.data;
      if (!Array.isArray(keys) || !Array.isArray(data) || keys.length === 0) continue;
      const selector = unsigned(keys[0], FIELD);
      const kind = selector === TRANSFER ? 'Transfer' : selector === APPROVAL ? 'Approval' : null;
      if (!kind) continue;
      let parties, words, legacy;
      if (keys.length === 3 && data.length === 2) [parties, words, legacy] = [keys.slice(1), data, false];
      else if (keys.length === 1 && data.length === 4) [parties, words, legacy] = [data.slice(0, 2), data.slice(2), true];
      else continue;
      if (!Number.isSafeInteger(e.block_number) || e.block_number < 0) continue;
      const tx = normalize(e.transaction_hash, 'hash');
      // Nodes from spec 0.10 give event_index (its place in the receipt); count within the page otherwise.
      const seen = ordinal.get(tx) ?? 0;
      ordinal.set(tx, seen + 1);
      const index = Number.isSafeInteger(e.event_index) && e.event_index >= 0 ? e.event_index : seen;
      out.push({ kind, token: hex64(e.from_address), a: hex64(parties[0]), b: hex64(parties[1]), amount: u256(words), legacy,
        block: e.block_number, tx, txIndex: Number.isSafeInteger(e.transaction_index) ? e.transaction_index : null, index });
    } catch { /* not a token event Cairn can read: ignored */ }
  }
  return out;
}
