import { createServer } from 'node:http';
import { CairnError, NodeBusy, RpcError } from './errors.mjs';
import { normalize, NodeValueError } from './felt.mjs';

/** Round 4 shares the scanner cursor and delivery ledger. Only hashes and delivery IDs are retained. */
export class Operations {
  constructor(bot) { this.bot = bot; this.store = bot.store; this.config = bot.config; this.rpcDown = true; this.telegramDown = false; }
  q(sql) { return this.store.sql(sql); }
  notice(body) {
    for (const s of this.q('SELECT chat_id, thread_id FROM protection WHERE network = 1').all()) {
      this.q('INSERT INTO notices (chat_id, thread_id, body) VALUES (?, ?, ?)').run(s.chat_id, s.thread_id, body);
    }
  }
  observe(head, now = Date.now()) {
    this.rpcDown = head === null;
    this.store.transaction(() => {
      if (!head) {
        if (this.store.get('rpc_outage') !== '1') {
          this.store.set('rpc_outage', 1);
          if (this.config.operatorChat !== null) this.q('INSERT INTO notices (chat_id, body) VALUES (?, ?)')
            .run(this.config.operatorChat, 'RPC outage: all configured endpoints are unavailable. Chain monitoring is paused; Cairn will retry automatically.');
        }
        return;
      }
      this.store.set('rpc_outage', 0);
      const key = `${head.block_number}:${head.block_hash ?? ''}`;
      const changed = this.store.get('network_head') !== key;
      const last = Number(this.store.get('head_changed') ?? now);
      if (changed) {
        if (this.store.get('stalled') === '1') this.notice(`Blocks resumed. Network recovered after ${Math.max(0, (now - last) / 1000).toFixed(1)} seconds without a new head.`);
        this.store.set('network_head', key); this.store.set('head_changed', now); this.store.set('stalled', 0);
      } else if (now - last >= this.config.stallSeconds * 1000 && this.store.get('stalled') !== '1') {
        this.store.set('stalled', 1);
        this.notice(`Network stalled: no new block for ${Math.floor((now - last) / 1000)} seconds. Last observed head: ${head.block_number}.`);
      }
    });
  }
  health(now = Date.now()) {
    const head = this.bot.head?.block_number ?? null;
    const lag_s = Math.max(0, (now - Number(this.store.get('head_changed') ?? now)) / 1000);
    const reason = this.rpcDown ? 'rpc' : this.telegramDown ? 'telegram' : this.reorgBlocked ? 'reorg' : lag_s >= this.config.stallSeconds ? 'stalled' : null;
    return { ok: reason === null, head, lag_s, ...(reason ? { reason } : {}) };
  }
  async http() {
    if (this.config.httpPort === null) return;
    this.server = createServer((req, res) => {
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      if (req.method !== 'GET' || !['/healthz', '/metrics'].includes(req.url)) { res.writeHead(404); res.end(); return; }
      if (req.url === '/healthz') {
        const health = this.health(); res.writeHead(health.ok ? 200 : 503, { 'content-type': 'application/json' }); res.end(JSON.stringify(health)); return;
      }
      const b = this.bot;
      const metrics = { head_block: [b.head?.block_number ?? 0, 'gauge'], updates_total: [b.counts.updates, 'counter'],
        messages_sent_total: [b.counts.sent, 'counter'], alerts_total: [b.counts.alerts, 'counter'], rpc_errors_total: [b.rpc.errors, 'counter'] };
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(Object.entries(metrics).map(([name, [value, type]]) => `# TYPE cairn_${name} ${type}\ncairn_${name} ${value}\n`).join(''));
    });
    this.server.requestTimeout = 5000; this.server.headersTimeout = 5000;
    await new Promise((resolve, reject) => {
      this.server.once('error', () => reject(new CairnError('Cannot bind CAIRN_HTTP_HOST / CAIRN_HTTP_PORT.', 2)));
      this.server.listen(this.config.httpPort, this.config.httpHost, resolve);
    });
    process.stderr.write(`${JSON.stringify({ event: 'http', port: this.server.address().port })}\n`);
  }
  close() { if (this.server) { this.server.closeAllConnections(); this.server.close(); } }
  /** Validate the bounded retained window before any new alerts. A deeper fork rescans only that window. */
  async reconcile(head) {
    const floor = Math.max(0, head.block_number - this.config.reorgDepth + 1);
    const previous = this.q('SELECT number, hash FROM headers WHERE number >= ? ORDER BY number DESC').all(floor);
    const fresh = new Map();
    const read = async n => {
      if (!fresh.has(n)) {
        const h = n === head.block_number ? head : await this.bot.rpc.call('starknet_getBlockWithTxHashes', { block_id: { block_number: n } });
        if (h?.block_number !== n) throw new NodeValueError();
        fresh.set(n, normalize(h.block_hash, 'hash'));
      }
      return fresh.get(n);
    };
    let fork = false, ancestor = null;
    for (const saved of previous) {
      if (saved.number > head.block_number || await read(saved.number) !== saved.hash) { fork = true; continue; }
      if (fork) { ancestor = saved.number; break; }
    }
    // Also detect a rollback beyond the retained tip.
    const oldTop = this.q('SELECT max(number) AS n FROM headers').get().n;
    if (oldTop !== null && oldTop > head.block_number) fork = true;
    if (fork) {
      ancestor ??= floor - 1;
      const affected = this.q("SELECT * FROM deliveries WHERE block > ? AND state NOT IN ('orphaned','dropped') ORDER BY seq").all(ancestor);
      const receipts = new Map();
      for (const row of affected) if (!receipts.has(row.tx_hash)) {
        try {
          const receipt = await this.bot.rpc.call('starknet_getTransactionReceipt', { transaction_hash: row.tx_hash });
          if (!receipt || !Number.isSafeInteger(receipt.block_number)) throw new NodeBusy();
          receipts.set(row.tx_hash, receipt.block_number);
        } catch (e) { if (e instanceof RpcError && e.code === 29) receipts.set(row.tx_hash, null); else throw e; }
      }
      this.store.transaction(() => {
        for (const row of affected) {
          const block = receipts.get(row.tx_hash);
          if (block !== null) { this.q('UPDATE deliveries SET block = ? WHERE seq = ?').run(block, row.seq); continue; }
          if (row.message_id !== null) this.q('INSERT OR IGNORE INTO corrections (seq, chat_id, tx_hash, message_id, thread_id) VALUES (?, ?, ?, ?, ?)')
            .run(row.seq, row.chat_id, row.tx_hash, row.message_id, row.thread_id);
          this.q("UPDATE deliveries SET state = 'orphaned', body = NULL, digest = NULL WHERE seq = ?").run(row.seq);
        }
        this.store.cursor = Math.min(this.store.cursor, ancestor);
        // Metadata derived from the abandoned history must be refreshed too.
        this.q('DELETE FROM names').run(); this.q('DELETE FROM seen').run();
        this.bot.names.reset(); this.bot.prices.reset();
        if (ancestor < floor) this.notice('Chain reorganization exceeds retained history. Rescanning the retained window; older alerts cannot be verified. Check the RPC and restore a backup for a full audit.');
      });
    }
    // Initial start records only its head. Subsequent passes retain every new header in the bounded window.
    const start = oldTop === null ? head.block_number : Math.max(floor, Math.min(oldTop + 1, head.block_number));
    for (let n = start; n <= head.block_number; n++) await read(n);
    this.store.transaction(() => {
      if (fork) this.q('DELETE FROM headers WHERE number > ?').run(ancestor);
      for (const [n, hash] of fresh) this.q('INSERT OR REPLACE INTO headers (number, hash) VALUES (?, ?)').run(n, hash);
      this.q('DELETE FROM headers WHERE number < ? OR number > ?').run(floor, head.block_number);
    });
    this.reorgBlocked = false;
  }
  skipGap(target) {
    if (target - this.store.cursor <= this.config.maxGap) return;
    this.store.transaction(() => {
      const skipped = target - this.store.cursor;
      this.store.cursor = target;
      this.notice(`Skipped a gap of ${skipped} blocks to confirmed block ${target}. Events in this gap were not scanned; monitoring resumes with the next block.`);
    });
  }
  async deliver() {
    for (const row of this.q("SELECT * FROM corrections WHERE state = 'pending' ORDER BY seq").all()) {
      if (this.bot.subs.isPaused(row.chat_id)) continue;
      // Telegram offers no idempotency key: claim before sending, never retry an ambiguous correction.
      this.q("UPDATE corrections SET state = 'claimed' WHERE seq = ?").run(row.seq);
      const r = await this.bot.send(row.chat_id, 'Correction: this transaction is no longer on the canonical chain after a reorganization. The earlier alert no longer applies.',
        { reply_parameters: { message_id: row.message_id, allow_sending_without_reply: true }, ...(row.thread_id === null ? {} : { message_thread_id: row.thread_id }) });
      if (r.blocked) this.q("UPDATE corrections SET state = 'pending' WHERE seq = ?").run(row.seq);
      else this.q("UPDATE corrections SET state = 'sent' WHERE seq = ?").run(row.seq);
    }
    for (const row of this.q("SELECT * FROM notices WHERE state = 'pending' ORDER BY id").all()) {
      if (this.bot.subs.isPaused(row.chat_id)) continue;
      this.q("UPDATE notices SET state = 'claimed' WHERE id = ?").run(row.id);
      const r = await this.bot.send(row.chat_id, row.body, row.thread_id === null ? {} : { message_thread_id: row.thread_id });
      if (r.blocked) this.q("UPDATE notices SET state = 'pending' WHERE id = ?").run(row.id);
      else this.q('DELETE FROM notices WHERE id = ?').run(row.id);
    }
  }
}
