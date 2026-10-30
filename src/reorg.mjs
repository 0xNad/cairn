import { NodeBusy, RpcError } from './errors.mjs';
import { hex64, NodeValueError } from './felt.mjs';
import { CORRECTION } from './ledger.mjs';

// Reorgs (round 4). Cairn keeps the hash and time of every recently scanned block, for the last
// CAIRN_REORG_DEPTH blocks. Before each scan it compares the node's hash of the cursor block with the kept one (one
// header read; none when the cursor is the head just read): since every block commits to its parent, an unchanged
// cursor block means nothing below it changed either. When it differs, Cairn walks back through the hashes it keeps,
// newest first and never deeper than CAIRN_REORG_DEPTH, to the newest block the node still has, moves the cursor
// back to that common ancestor, and rescans through round 2's scanner and ledger:
// - an alert about a transaction the node no longer finds gets one correction, as a reply to its message (a summary
//   that covered several gets one correction listing them); one never sent is dropped instead;
// - an alert whose transaction the node still has, in a block again or not, gets nothing more: the ledger already
//   holds its key, so the rescan cannot send it twice, and only notes the block it now sits in;
// - new events in the replacement blocks are new keys, alerted once like any other.
// A transaction the node still knows but has not put back in a block (back in its mempool) is checked again on each
// pass: back in a block, nothing more; gone, or not back after DOUBT_TTL of chain time, it gets its correction.

export const DOUBT_TTL = 600;

/** Where one endpoint says a transaction stands: 'included' (in a block), 'waiting' (known, in no block) or 'gone'. */
async function standingAt(rpc, hash, endpoint) {
  let status;
  try { status = await rpc.call('starknet_getTransactionStatus', { transaction_hash: hash }, { endpoint }); }
  catch (error) {
    if (error instanceof RpcError && error.code === 29) return 'gone';
    throw error;
  }
  const finality = String(status?.finality_status ?? '');
  if (finality === 'ACCEPTED_ON_L2' || finality === 'ACCEPTED_ON_L1') return 'included';
  return finality === 'REJECTED' ? 'gone' : 'waiting';
}
/**
 * Where a transaction stands after a reorg. With several endpoints, each one that answers is asked, and the most
 * hopeful answer counts: a transaction is gone only when no endpoint has it, so an endpoint still on the old fork,
 * or one behind, never sends a false correction. Throws NodeBusy when none answers.
 */
export async function standing(rpc, hash) {
  const endpoints = rpc.endpoints?.length > 1 ? rpc.endpoints.map((e) => e.index) : [undefined];
  const answers = [];
  for (const endpoint of endpoints) {
    try { answers.push(await standingAt(rpc, hash, endpoint)); }
    catch (error) { if (!(error instanceof NodeBusy) || endpoints.length === 1) throw error; }
    if (answers.includes('included')) return 'included';
  }
  if (!answers.length) throw new NodeBusy();
  return answers.includes('waiting') ? 'waiting' : 'gone';
}

/**
 * What the ledger does with the alert rows a reorg took back, given each transaction's standing: { drop, doubt,
 * settle, corrections }, where each correction is one message's rows (a summary may cover several).
 */
export function verdicts(rows, standings, now) {
  const out = { drop: [], doubt: [], settle: [], corrections: [] }, byMessage = new Map();
  for (const row of rows) {
    let standing = standings.get(row.tx_hash);
    if (standing === 'waiting' && row.doubt_since !== null && now - row.doubt_since >= DOUBT_TTL) standing = 'gone';
    if (standing === 'included') { if (row.doubt_since !== null) out.settle.push(row); }
    else if (standing === 'waiting') out.doubt.push(row);
    else if (row.state === 'pending') out.drop.push(row);
    else {
      const key = `${row.chat_id} ${row.message_id}`;
      (byMessage.get(key) ?? byMessage.set(key, []).get(key)).push(row);
    }
  }
  out.corrections = [...byMessage.values()];
  return out;
}

/** One correction, replying to the alert (or summary) whose transactions left the chain. */
export function correction(rows, why, fmt, now) {
  const [first] = rows, txs = [...new Set(rows.map((r) => r.tx_hash))];
  const body = txs.length === 1
    ? `↩️ <b>Correction</b>: ${why}, and transaction ${fmt.tx(txs[0])} is no longer on chain. What this alert reported did not happen; anything that replaced it is posted on its own.`
    : `↩️ <b>Correction</b>: ${why}, and ${txs.length} of the transactions this message counted are no longer on chain: ${txs.map((tx) => fmt.tx(tx)).join(' · ')}. What it reported for them did not happen.`;
  return { chatId: first.chat_id, txHash: first.tx_hash, eventIndex: CORRECTION - first.event_index, kind: 'correction', block: first.block,
    chainTime: now, thread: first.thread_id, replyTo: first.message_id, body, digest: { k: 'correction' } };
}
export const because = {
  fork: (fork) => `Starknet reorganised the blocks after ${fork.ancestor}`,
  dropped: () => `a reorganisation took this transaction out of its block, and it was not included again within ${DOUBT_TTL / 60} minutes`,
};

export class Forks {
  constructor(store, rpc, config) {
    this.store = store;
    this.rpc = rpc;
    this.depth = config.reorgDepth;
  }
  #q(text) { return this.store.sql(text); }
  /** A block as the node has it now: { number, hash, timestamp }, or null when it has no such block (error 24). */
  async header(number) {
    let b;
    try { b = await this.rpc.call('starknet_getBlockWithTxHashes', { block_id: { block_number: number } }); }
    catch (error) {
      if (error instanceof RpcError && error.code === 24) return null;
      throw error;
    }
    if (!Number.isSafeInteger(b?.timestamp)) throw new NodeValueError();
    return { number, hash: hex64(b.block_hash), timestamp: b.timestamp };
  }
  /** The kept hash and time of a scanned block, or null. */
  kept(number) { return this.#q('SELECT number, hash, timestamp FROM blocks WHERE number = ?').get(number) ?? null; }
  /** Prepare the complete retained window before advancing a scan. A failed header leaves state untouched. */
  async history(from, to, head) {
    const blocks = [];
    for (let number = Math.max(from, to - this.depth + 1); number <= to; number++) {
      const block = number === head.block_number
        ? { number, hash: hex64(head.block_hash), timestamp: head.timestamp }
        : await this.header(number);
      if (!block) throw new NodeValueError();
      blocks.push(block);
    }
    return blocks;
  }
  /** Keeps a block a scan reached and forgets those CAIRN_REORG_DEPTH below it. Runs in the caller's transaction. */
  remember({ number, hash, timestamp }) {
    this.#q('INSERT INTO blocks (number, hash, timestamp) VALUES (?, ?, ?) ON CONFLICT (number) DO UPDATE SET hash = excluded.hash, timestamp = excluded.timestamp')
      .run(number, hash, timestamp);
    this.#q('DELETE FROM blocks WHERE number <= ?').run(number - this.depth);
  }
  /** Forgets the blocks after the common ancestor, which the rescan replaces. Runs in the caller's transaction. */
  rewind(ancestor) { this.#q('DELETE FROM blocks WHERE number > ?').run(ancestor); }
  /**
   * Whether the blocks scanned still stand: null, or the fork { from, hash, ancestor, deep }. `deep` means none of
   * the kept hashes matched within CAIRN_REORG_DEPTH: the rescan then starts at that depth, and no deeper.
   */
  async check(cursor, head) {
    if (cursor === null || head.block_number < cursor) return null; // a node behind the cursor: nothing to compare yet
    const now = cursor === head.block_number ? { number: cursor, hash: hex64(head.block_hash), timestamp: head.timestamp } : await this.header(cursor);
    if (!now) return null;
    const kept = this.kept(cursor);
    if (!kept) { // a first start, a skipped gap or a round 3 state: from now on this block is the reference
      this.store.transaction(() => this.remember(now));
      return null;
    }
    if (now.hash === kept.hash) return null;
    for (const b of this.#q('SELECT number, hash FROM blocks WHERE number < ? AND number > ? ORDER BY number DESC').all(cursor, cursor - this.depth)) {
      if ((await this.header(b.number))?.hash === b.hash) return { from: cursor, hash: now.hash, ancestor: b.number, deep: false };
    }
    return { from: cursor, hash: now.hash, ancestor: Math.max(0, cursor - this.depth), deep: true };
  }
}
