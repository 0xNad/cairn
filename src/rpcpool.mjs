import { Rpc } from './transport.mjs';
import { log, NodeBusy, RpcError } from './errors.mjs';

/** Sticky failover. A pagination token belongs only to the endpoint that issued it. */
export class RpcPool {
  constructor(config, signal) {
    const rate = { times: [] };
    this.clients = (config.rpcUrls ?? [config.rpcUrl]).map(rpcUrl => new Rpc({ ...config, rpcUrl }, signal, rate));
    this.active = 0;
    this.generation = 0; // Detect switches even if failover eventually returns to the same endpoint.
    this.errors = 0;
    this.verified = new Set();
    this.verify = null;
  }
  async identify(verify) {
    this.verify = verify;
    let identity;
    for (let i = 0; i < this.clients.length; i++) {
      try { const result = await verify(this.clients[i]); this.verified.add(i); identity ??= result; }
      catch (error) { if (!(error instanceof NodeBusy)) throw error; this.errors++; }
    }
    if (!identity) throw new NodeBusy();
    return identity;
  }
  async call(method, params = {}) {
    for (let n = 0; n < this.clients.length; n++) {
      const i = this.active;
      try {
        if (this.verify && !this.verified.has(i)) { await this.verify(this.clients[i]); this.verified.add(i); }
        const result = await this.clients[i].call(method, params);
        return result;
      } catch (error) {
        if (!(error instanceof NodeBusy)) throw error;
        this.errors++;
        log('warn', `RPC endpoint ${i + 1} unreachable.`);
        this.generation++;
        this.active = (i + 1) % this.clients.length;
        if (n + 1 < this.clients.length && params.filter?.continuation_token) throw new RpcError(33);
      }
    }
    throw new NodeBusy();
  }
}
