import { hex64 } from './felt.mjs';
import { RpcError } from './errors.mjs';

export function duration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`;
}
/** Persisted wall-clock latches and bounded chain history, stepped only by the bot's pass. */
export class Network {
  constructor(config, store, rpc, ledger) { Object.assign(this, { config, store, rpc, ledger }); }
  get since() { return Number(this.store.get('head_since') ?? Date.now()); }
  subscribers() { return this.store.sql('SELECT p.chat_id FROM protection p JOIN chats c USING(chat_id) WHERE network = 1 AND paused = 0').all(); }
  notice(key, body, head, chats = this.subscribers()) {
    for (const { chat_id } of chats) this.ledger.add({ chatId: chat_id, txHash: key, eventIndex: -10, kind: 'network', chainTime: head?.timestamp ?? Number(this.store.get('chain_time') ?? 0), body });
  }
  async step(head, now = Date.now(), endpoint = this.rpc.generation ?? 0) {
    if (!head) {
      if (this.store.get('rpc_outage') !== '1') this.store.transaction(() => {
        this.store.set('rpc_outage', 1);
        if (this.config.operatorChat !== null) this.notice(`outage:${now}`, '⚠️ Chain access is down.\nAll configured endpoints are unavailable.', null, [{ chat_id: this.config.operatorChat }]);
      });
      return;
    }
    this.store.transaction(() => {
      this.store.set('rpc_outage', 0);
      this.store.set('chain_time', head.timestamp);
      const previous = this.store.get('head_hash');
      if (previous !== hex64(head.block_hash)) {
        if (this.store.get('stalled') === '1') this.notice(`recovery:${this.since}`, `✅ Recovered after ${duration(now - this.since)}.\nBlocks are moving again.`, head);
        this.store.set('head_hash', hex64(head.block_hash));
        this.store.set('head_since', now);
        this.store.set('stalled', 0);
      } else if (now - this.since >= this.config.stallSeconds * 1000 && this.store.get('stalled') !== '1') {
        this.notice(`stall:${this.since}`, '⏸ No new blocks.\nWaiting for the chain to resume.', head);
        this.store.set('stalled', 1);
      }
    });
    await this.reorg(head, endpoint);
    const safe = Math.max(0, head.block_number - this.config.confirmations);
    if (safe - this.store.cursor > this.config.maxGap) this.store.transaction(() => {
      this.notice(`gap:${this.store.cursor}:${safe}`, `⏩ Skipped ${safe - this.store.cursor} blocks to catch up.\nNew alerts resume from here.`, head);
      this.store.cursor = safe;
    });
  }
  async reorg(head, endpoint) {
    const rows = this.store.sql('SELECT * FROM blocks ORDER BY number DESC').all();
    let ancestor = null, changed = false;
    for (const row of rows) {
      if (row.number > head.block_number) { changed = true; continue; }
      const block = row.number === head.block_number ? head : await this.rpc.call('starknet_getBlockWithTxHashes', { block_id: { block_number: row.number } });
      if (hex64(block.block_hash) === row.hash) { ancestor = row.number; break; }
      changed = true;
    }
    if (changed) {
      // Beyond retained history, rescan the retained window; never walk outside the configured depth.
      ancestor ??= Math.max(0, head.block_number - this.config.reorgDepth);
      this.store.transaction(() => {
        for (const row of this.store.sql("SELECT * FROM deliveries WHERE block > ? AND kind != 'correction'").all(ancestor)) {
          this.ledger.recheck(row, head.block_number);
        }
        this.store.cursor = Math.min(this.store.cursor, ancestor);
        this.store.sql('DELETE FROM blocks WHERE number > ?').run(ancestor);
      });
    }
    await this.reconcile(head, endpoint);
  }
  /** Only two not-found answers on the replacement head's endpoint prove removal. */
  async disposition(tx) {
    try { return { receipt: await this.rpc.call('starknet_getTransactionReceipt', { transaction_hash: tx }) }; }
    catch (error) {
      if (error.exitCode === 2 || error.name === 'AbortError') throw error;
      if (!(error instanceof RpcError && error.code === 29)) return null;
    }
    try { await this.rpc.call('starknet_getTransactionStatus', { transaction_hash: tx }); }
    catch (error) {
      if (error.exitCode === 2 || error.name === 'AbortError') throw error;
      if (error instanceof RpcError && error.code === 29) return { missing: true };
    }
    return null;
  }
  async reconcile(head, endpoint) {
    const byTx = new Map();
    for (const row of this.ledger.rechecking()) {
      if (head.block_number - JSON.parse(row.digest).reorg >= this.config.reorgDepth) {
        this.store.transaction(() => { this.ledger.checked(row); if (row.message_id === null) this.ledger.dropped(row.seq); });
      } else (byTx.get(row.tx_hash) ?? byTx.set(row.tx_hash, []).get(row.tx_hash)).push(row);
    }
    for (const [tx, rows] of byTx) {
      if ((this.rpc.generation ?? 0) !== endpoint) return;
      const result = await this.disposition(tx);
      // A failover must not combine one provider's replacement blocks with another provider's absence.
      if ((this.rpc.generation ?? 0) !== endpoint) return;
      if (!result?.missing && !Number.isSafeInteger(result?.receipt?.block_number)) continue;
      this.store.transaction(() => {
        for (const row of rows) {
          this.ledger.checked(row, result.receipt?.block_number ?? row.block);
          if (result.missing) {
            if (row.message_id !== null) this.ledger.correct(row, { block: head.block_number, chainTime: head.timestamp,
              body: '↩️ Correction: this transaction\nwas dropped by a reorg.' });
            else this.ledger.dropped(row.seq);
          }
        }
      });
    }
  }
  async remember(head) {
    const start = Number(this.store.get('history_start') ?? head.block_number);
    const low = Math.max(start, head.block_number - this.config.reorgDepth + 1);
    const saved = new Set(this.store.sql('SELECT number FROM blocks').all().map(r => r.number));
    const blocks = [];
    for (let n = low; n <= head.block_number; n++) if (!saved.has(n)) {
      const b = n === head.block_number ? head : await this.rpc.call('starknet_getBlockWithTxHashes', { block_id: { block_number: n } });
      blocks.push([n, hex64(b.block_hash)]);
    }
    this.store.transaction(() => {
      this.store.set('history_start', start);
      for (const [n, hash] of blocks) this.store.sql('INSERT OR REPLACE INTO blocks VALUES (?, ?)').run(n, hash);
      this.store.sql('DELETE FROM blocks WHERE number < ?').run(low);
    });
  }
}
