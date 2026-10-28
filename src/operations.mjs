import { createServer } from 'node:http';
import { RpcError } from './errors.mjs';
/** Operational state shares the bot's durable store and single scheduling loop. */
export class Operations {
  constructor(bot) { this.bot = bot; this.rpcFailed = true; this.telegramFailed = false; this.server = null; }
  get store() { return this.bot.store; }
  get config() { return this.bot.config; }
  async broadcast(text) {
    for (const row of this.store.sql('SELECT p.chat_id, p.thread_id FROM protection p LEFT JOIN chats c USING(chat_id) WHERE p.network = 1 AND coalesce(c.paused,0) = 0').all()) {
      await this.bot.send(row.chat_id, text, row.thread_id === null ? {} : {message_thread_id: row.thread_id});
    }
  }
  async failed() {
    this.rpcFailed = true;
    if (!this.store.get('rpc_outage')) {
      this.store.set('rpc_outage', '1');
      if (this.config.operatorChat) await this.bot.send(this.config.operatorChat, 'RPC outage: all configured endpoints are unavailable. Cairn will retry; chain scans are paused.');
    }
  }
  async head(block) {
    this.rpcFailed = false;
    this.store.set('rpc_outage', '');
    const now = Date.now(), prior = this.store.get('head_hash'), changed = Number(this.store.get('head_changed') ?? now);
    if (prior !== block.block_hash) {
      if (this.store.get('stalled') === '1') await this.broadcast(`Blocks resumed. Recovery after ${((now - changed) / 1000).toFixed(1)} seconds without a new head.`);
      this.store.set('head_hash', block.block_hash);
      this.store.set('head_changed', now);
      this.store.set('stalled', '0');
    } else if (now - changed >= this.config.stallSeconds * 1000 && this.store.get('stalled') !== '1') {
      await this.broadcast(`Network stalled: no new block for ${Math.floor((now - changed) / 1000)} seconds. Monitoring continues.`);
      this.store.set('stalled', '1');
    }
  }
  /** Validate only the retained horizon, then rewind the scanner atomically. Delivery keys survive a fork. */
  async reconcile() {
    const {head, rpc} = this.bot, floor = Math.max(0, head.block_number - this.config.reorgDepth);
    const rows = this.store.sql('SELECT number, hash FROM headers WHERE number >= ? ORDER BY number DESC').all(floor);
    let fork = false, ancestor = null;
    for (const row of rows) {
      if (row.number > head.block_number) { fork = true; continue; }
      const fresh = await rpc.call('starknet_getBlockWithTxHashes', {block_id: {block_number: row.number}});
      if (fresh.block_hash !== row.hash) fork = true;
      else { ancestor = row.number; break; }
    }
    if (fork) {
      // A fork beyond retention cannot be reconstructed: restart at the retained boundary and announce the gap.
      const rewind = ancestor ?? floor;
      if (ancestor === null) await this.broadcast('Reorg exceeds retained history. Rescanning the retained range; older events may need manual verification.');
      const affected = this.store.sql('SELECT seq, tx_hash, state, message_id FROM deliveries WHERE block > ?').all(rewind);
      for (const row of affected) {
        try { await rpc.call('starknet_getTransactionByHash', {transaction_hash: row.tx_hash}); }
        catch (error) {
          if (!(error instanceof RpcError && error.code === 29)) throw error;
          if (row.message_id !== null && ['sent','summarized'].includes(row.state)) this.store.sql('INSERT OR IGNORE INTO corrections(seq) VALUES (?)').run(row.seq);
          else this.bot.ledger.dropped(row.seq);
        }
      }
      this.store.transaction(() => {
        this.store.cursor = Math.min(this.store.cursor, rewind);
        this.store.sql('DELETE FROM headers WHERE number > ?').run(rewind);
      });
    }
    // Keep hashes for all blocks in the bounded horizon, even when nobody has a wallet subscription.
    const last = this.store.sql('SELECT max(number) AS n FROM headers').get().n;
    const start = last === null ? head.block_number : Math.max(floor, Number(last) + 1);
    const headers = [];
    for (let n = start; n <= head.block_number; n++) {
      const b = n === head.block_number ? head : await rpc.call('starknet_getBlockWithTxHashes', {block_id: {block_number:n}});
      headers.push([n, b.block_hash]);
    }
    this.store.transaction(() => {
      for (const [n,h] of headers) this.store.sql('INSERT OR REPLACE INTO headers VALUES (?,?)').run(n,h);
      this.store.sql('DELETE FROM headers WHERE number < ?').run(floor);
    });
    for (const row of this.store.sql("SELECT d.* FROM corrections c JOIN deliveries d ON d.seq=c.seq WHERE c.state='pending'").all()) {
      const r = await this.bot.send(row.chat_id, 'Chain correction: this transaction is no longer found after a reorg. Its earlier alert is no longer canonical.', {reply_parameters:{message_id:row.message_id}, ...(row.thread_id === null ? {} : {message_thread_id:row.thread_id})});
      if (r.message || r.refused) this.store.sql("UPDATE corrections SET state='sent' WHERE seq=?").run(row.seq);
    }
  }
  async listen() {
    if (this.config.httpPort === null) return;
    this.server = createServer((req,res) => {
      const json = value => {res.setHeader('content-type','application/json'); res.end(JSON.stringify(value));};
      if (req.method !== 'GET' || !['/healthz','/metrics'].includes(req.url)) {res.statusCode=404; res.end(); return;}
      const lag = Math.max(0, (Date.now()-Number(this.store.get('head_changed') ?? Date.now()))/1000);
      if (req.url === '/healthz') {
        const reason = this.rpcFailed ? 'rpc' : this.telegramFailed ? 'telegram' : lag >= this.config.stallSeconds ? 'stalled' : null;
        res.statusCode = reason ? 503 : 200;
        json(reason ? {ok:false,reason} : {ok:true,head:this.bot.head?.block_number,lag_s:lag});
      } else {
        res.setHeader('content-type','text/plain; version=0.0.4');
        res.end(Object.entries({head_block:this.bot.head?.block_number ?? 0,updates_total:this.bot.counts.updates,messages_sent_total:this.bot.counts.sent,alerts_total:this.bot.counts.alerts,rpc_errors_total:this.bot.rpc.errors}).map(([k,v])=>`cairn_${k} ${v}\n`).join(''));
      }
    });
    await new Promise((resolve,reject) => {this.server.once('error',reject); this.server.listen(this.config.httpPort,this.config.httpHost,resolve);});
    process.stderr.write(JSON.stringify({event:'http',port:this.server.address().port})+'\n');
  }
  close() { this.server?.close(); this.server?.closeAllConnections(); }
}
