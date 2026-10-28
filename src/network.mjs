import { hex64 } from './felt.mjs';
import { utc } from './format.mjs';

// Round 4's network watch, on the bot's own pass: each head read (or failed head read) is observed here, in the
// transaction that queues what it finds. A stall is measured on the wall clock, never on chain timestamps: the
// head mark is the block Cairn last saw change and when it saw it, kept in CAIRN_DATA so that `tick` processes
// and restarts share it. One stall alert per stall, one recovery when blocks resume, and one operator notice per
// outage of every endpoint (and one when it ends). The latches live in the meta table.

const MARK = 'network.mark', STALL = 'network.stall', OUTAGE = 'network.outage';

/** A wall-clock length as people read it: 45 s, 2 min 5 s, 3 h 20 min. */
export function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 120) return `${s} s`;
  if (s < 7200) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

export class NetworkWatch {
  constructor(store, config) {
    this.store = store;
    this.stallMs = config.stallSeconds * 1000;
    this.stallSeconds = config.stallSeconds;
  }
  #read(key) { try { return JSON.parse(this.store.get(key) ?? 'null'); } catch { return null; } }
  #write(key, value) {
    if (value === null) this.store.sql('DELETE FROM meta WHERE key = ?').run(key);
    else this.store.set(key, JSON.stringify(value));
  }
  /** The block Cairn last saw change and when, { block, hash, at (ms), time (chain s) }, or null. */
  get mark() { return this.#read(MARK); }
  /** The chain time network notices are filed under (the ledger prunes by chain time). */
  get chainTime() { return this.mark?.time ?? 0; }

  /**
   * A head was read at wall time `now`. Returns the notices it causes: { kind: 'stall', key, ms, block } when the
   * head has not changed for CAIRN_STALL_SECONDS (once per stall), { kind: 'resumed', key, ms, block } when it moves
   * after a stall, and { kind: 'rpc-back', key, ms } when it ends an outage of every endpoint. A lower block (a
   * lagging fallback) is not a change; a new hash at the same height (a reorg at the tip) is.
   */
  observe(head, now) {
    const notices = [], mark = this.mark, hash = hex64(head.block_hash ?? '0x0');
    const outage = this.#read(OUTAGE);
    if (outage) {
      notices.push({ kind: 'rpc-back', key: outage.at, ms: now - outage.at });
      this.#write(OUTAGE, null);
    }
    const changed = !mark || head.block_number > mark.block || (head.block_number === mark.block && hash !== mark.hash);
    if (changed) {
      const stall = this.#read(STALL);
      if (stall && mark) notices.push({ kind: 'resumed', key: stall.key, ms: now - mark.at, block: head.block_number, time: head.timestamp });
      this.#write(STALL, null);
      this.#write(MARK, { block: head.block_number, hash, at: now, time: head.timestamp });
    } else if (!this.#read(STALL) && now - mark.at >= this.stallMs) {
      this.#write(STALL, { key: mark.at });
      notices.push({ kind: 'stall', key: mark.at, ms: now - mark.at, block: mark.block, time: mark.time });
    }
    return notices;
  }
  /** Every endpoint failed the head read at `now`: { kind: 'rpc-down', key } the first time in an outage, else null. */
  failed(now) {
    if (this.#read(OUTAGE)) return null;
    this.#write(OUTAGE, { at: now });
    return { kind: 'rpc-down', key: now };
  }
  get outage() { return this.#read(OUTAGE); }
  /** Whether the head has not changed for CAIRN_STALL_SECONDS of wall time at `now`. */
  stalled(now) { const mark = this.mark; return mark !== null && now - mark.at >= this.stallMs; }
}

/** The message for a notice. Stall and recovery go to subscribed chats; outages go only to CAIRN_OPERATOR_CHAT. */
export function noticeText(n, { endpoints = 1, stallSeconds } = {}) {
  switch (n.kind) {
    case 'stall':
      return `⏸ <b>Starknet stall</b>: no new block for ${duration(n.ms)} (the alert threshold is ${stallSeconds} s). ` +
        `The head is still block ${n.block}${Number.isSafeInteger(n.time) ? `, from ${utc(n.time)}` : ''}. Cairn posts once more when blocks resume.`;
    case 'resumed':
      return `▶️ <b>Starknet blocks resumed</b> with block ${n.block}, after ${duration(n.ms)} without a new block.`;
    case 'rpc-down':
      return `🔴 <b>Every Starknet RPC endpoint is failing</b> (${endpoints === 1 ? 'the only one' : `all ${endpoints}`}): Cairn cannot read the chain, ` +
        'so alerts wait and lookups answer "node busy". Subscribers are not told. Check the endpoints and your network; Cairn keeps trying.';
    case 'rpc-back':
      return `🟢 <b>Starknet RPC recovered</b> after ${duration(n.ms)}: Cairn reads the chain again and sends the alerts that waited.`;
    case 'gap':
      return `⏭ <b>Blocks skipped</b>: Cairn fell ${n.behind} blocks behind (more than CAIRN_MAX_GAP, ${n.max}), so blocks ${n.from} to ${n.to} ` +
        `were skipped without alerts. It resumed at block ${n.to + 1}.`;
    case 'deep-reorg':
      return `⚠️ <b>Deep reorg</b>: the chain changed below the ${n.depth} blocks Cairn keeps (CAIRN_REORG_DEPTH). Cairn rescanned from block ${n.from}; ` +
        `alerts from before it were not re-checked.`;
    default:
      throw new Error('unknown notice');
  }
}
