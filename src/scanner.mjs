// The scanner: each block range is read once, with one chain-wide filter on Transfer and Approval (no address),
// page after page. A range is all or nothing: if a page fails, the caller keeps its cursor and the whole range
// is read again on a later pass; an invalid continuation token (error 33) restarts the range at once. The
// alert rules (alerts.mjs) decide what the events mean for each chat; round 3's venue filters (one address and
// its swap event each) read the same ranges with readRange.
import { RpcError } from './errors.mjs';
import { felt64, NodeValueError, u256 } from './felt.mjs';

export const EVENTS = Object.freeze({
  Transfer: '0x0099cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9',
  Approval: '0x0134692b230b9e1ffa39098904722134159652b09c5bc41d88d6698779d228ff',
});
// Every ERC-20 Transfer and Approval on Starknet: the keys' first position matches either selector.
export const TOKEN_EVENTS = Object.freeze({ keys: [[EVENTS.Transfer, EVENTS.Approval]] });
const CHUNK = 1000; // providers refuse more than 1024
const RESTARTS = 3;

/** Every event of blocks `from` to `to` that `filter` ({ keys, address? }) selects, in chain order, or throws. */
export async function readRange(rpc, from, to, filter = TOKEN_EVENTS) {
  for (let attempt = 0; ; attempt++) {
    const events = [];
    let token;
    try {
      do {
        const page = await rpc.call('starknet_getEvents', { filter: {
          from_block: { block_number: from }, to_block: { block_number: to }, ...filter, chunk_size: CHUNK,
          ...(token === undefined ? {} : { continuation_token: token }),
        } });
        if (!Array.isArray(page?.events)) throw new NodeValueError();
        events.push(...page.events);
        token = typeof page.continuation_token === 'string' && page.continuation_token ? page.continuation_token : undefined;
      } while (token !== undefined);
      return events;
    } catch (error) {
      if (error instanceof RpcError && error.code === 33 && attempt < RESTARTS) continue; // restart that range, from scratch
      throw error;
    }
  }
}

// One event, decoded by its shape (ARCHITECTURE.md, "Decoding by shape"):
//   keys [sel, a, b], data [low, high]  a modern ERC-20 event;
//   keys [sel], data [a, b, low, high]  a legacy one, an ERC-20 only if its contract answers decimals;
//   anything else (an NFT with its id in the keys…) is not for Cairn: null.
// A Transfer's a and b are from and to; an Approval's are owner and spender.
function decode(raw, index) {
  try {
    const keys = raw.keys.map((k) => felt64(k)), data = raw.data;
    const kind = keys[0] === felt64(EVENTS.Transfer) ? 'Transfer' : keys[0] === felt64(EVENTS.Approval) ? 'Approval' : null;
    if (!kind) return null;
    let a, b, words, legacy;
    if (keys.length === 3 && data.length === 2) [a, b, words, legacy] = [keys[1], keys[2], data, false];
    else if (keys.length === 1 && data.length === 4) [a, b, words, legacy] = [felt64(data[0]), felt64(data[1]), data.slice(2), true];
    else return null;
    const block = Number(raw.block_number);
    if (!Number.isSafeInteger(block)) return null;
    return { kind, legacy, a, b, amount: u256(words), token: felt64(raw.from_address), block, tx: felt64(raw.transaction_hash), index };
  } catch { return null; }
}

/**
 * The range's events grouped by transaction, in chain order: [{ block, tx, events, last }]. `events` are the
 * ERC-20 ones; `last` is the highest event index of the transaction among all its events, decoded or not
 * (the fee payment is a transaction's last event).
 */
export function byTransaction(rawEvents) {
  const txs = new Map(); // transaction hash → its group, in the order the node gave them: chain order
  for (const raw of rawEvents) {
    let tx;
    try { tx = felt64(raw.transaction_hash); } catch { continue; }
    let group = txs.get(tx);
    if (!group) txs.set(tx, group = { block: Number(raw.block_number), tx, events: [], last: -1, seen: 0 });
    const index = Number.isSafeInteger(raw.event_index) ? raw.event_index : group.seen; // nodes without event_index
    group.seen++;
    group.last = Math.max(group.last, index);
    const event = decode(raw, index);
    if (event) group.events.push(event);
  }
  return [...txs.values()].filter((g) => g.events.length).map(({ seen, ...g }) => g);
}
