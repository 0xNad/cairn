import { hex64 } from './felt.mjs';

// Round 4's reorg memory: the hashes of the last CAIRN_REORG_DEPTH scanned blocks. Each pass compares the node's
// hash for the cursor block with the stored one (from the head itself, or the parent hash of the next block,
// which the scan reads anyway); when they differ it walks back, one stored block at a time, to the common
// ancestor. Nothing older than the stored window is ever read.

export class Blocks {
  constructor(store, depth) { this.store = store; this.depth = depth; }
  #q(text) { return this.store.sql(text); }
  hash(number) { return this.#q('SELECT hash FROM blocks WHERE number = ?').get(number)?.hash ?? null; }
  /** Saves scanned blocks, { number, hash }, and forgets those more than CAIRN_REORG_DEPTH below `cursor`. */
  record(headers, cursor) {
    for (const h of headers.filter((x) => x.hash !== null)) this.#q('INSERT INTO blocks (number, hash) VALUES (?, ?) ON CONFLICT (number) DO UPDATE SET hash = excluded.hash').run(h.number, h.hash);
    this.#q('DELETE FROM blocks WHERE number <= ? OR number > ?').run(cursor - this.depth, cursor);
  }
  /** After a fork, or a skipped gap: only blocks up to `number` are still known. */
  dropAfter(number) { this.#q('DELETE FROM blocks WHERE number > ?').run(number); }
  oldest() { return this.#q('SELECT min(number) AS n FROM blocks').get()?.n ?? null; }
}

/**
 * Where the node's chain left Cairn's: null when the cursor block's hash still matches (or is unknown), else
 * { ancestor, deep }: the highest stored block whose hash the node still has, or, when even the oldest stored
 * block changed, the block just below the stored window (deep: its hash was never checked).
 */
export async function findFork(blocks, cursor, head, header) {
  const stored = blocks.hash(cursor);
  if (stored === null || head.block_number < cursor) return null; // nothing to compare, or a fallback still behind
  const now = head.block_number === cursor ? (head.block_hash === undefined ? null : hex64(head.block_hash)) : (await header(cursor + 1)).parent;
  if (now === null || now === stored) return null; // a node that gives no hash cannot be checked
  for (let n = cursor - 1; ; n--) {
    const known = blocks.hash(n);
    if (known === null) return { ancestor: n, deep: true };
    const hash = (await header(n)).hash;
    if (hash === null || hash === known) return { ancestor: n, deep: false };
  }
}
