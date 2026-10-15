import { CairnError, NodeBusy, RpcError, stopped } from './errors.mjs';
import { post, pause, retryAfter } from './http.mjs';

const READ_METHODS = new Set(['starknet_chainId', 'starknet_specVersion', 'starknet_blockNumber',
  'starknet_getBlockWithTxHashes', 'starknet_call', 'starknet_getClassHashAt',
  'starknet_getTransactionStatus', 'starknet_getTransactionReceipt']);

export class Starknet {
  constructor(config, signal, log) {
    this.config = config;
    this.signal = signal;
    this.log = log;
    this.times = [];
    this.id = 0;
    this.queue = Promise.resolve();
    this.identity = null;
  }

  // Serialize dispatch reservations. Responses can overlap; retries consume the same rolling budget.
  async reserve() {
    const previous = this.queue;
    let unlock;
    this.queue = new Promise((resolve) => { unlock = resolve; });
    await previous;
    try {
      stopped(this.signal);
      while (true) {
        const now = performance.now();
        this.times = this.times.filter((at) => now - at < 1010);
        if (this.times.length < this.config.rpcRps) { this.times.push(now); return; }
        await pause(1010 - (now - this.times[0]), this.signal);
      }
    } finally { unlock(); }
  }

  async call(method, params = {}) {
    if (!READ_METHODS.has(method)) throw new CairnError('Unsupported RPC method.', 2);
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.reserve();
      let wait = 200 * 2 ** attempt;
      const id = ++this.id;
      try {
        const { response, json } = await post(this.config.rpc, { jsonrpc: '2.0', id, method, params }, this.config.rpcTimeout, this.signal);
        if (response.status === 429 || response.status >= 500) {
          wait = Math.max(wait, retryAfter(response.headers.get('retry-after')));
        } else {
          if (!response.ok || !json || json.jsonrpc !== '2.0' || json.id !== id) throw new NodeBusy();
          if (json.error) throw new RpcError(Number(json.error.code));
          if (!Object.hasOwn(json, 'result')) throw new NodeBusy();
          return json.result;
        }
      } catch (error) {
        stopped(this.signal);
        if (error instanceof RpcError) throw error;
      }
      this.log('warn', 'rpc_retry', { method, attempt: attempt + 1 });
      if (attempt < 2) await pause(wait, this.signal);
    }
    throw new NodeBusy();
  }

  async validate() {
    if (this.identity) return this.identity;
    const raw = await this.call('starknet_chainId');
    let chain;
    try {
      const hex = BigInt(raw).toString(16);
      chain = Buffer.from(hex.padStart(Math.ceil(hex.length / 2) * 2, '0'), 'hex').toString('ascii');
    } catch { throw new CairnError('Node reported an invalid chain id.', 2); }
    if (chain !== this.config.chain) throw new CairnError(`Node chain is ${this.config.clean(chain)}; expected ${this.config.chain}.`, 2);
    const spec = await this.call('starknet_specVersion');
    const parts = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(spec));
    if (!parts || (Number(parts[1]) === 0 && Number(parts[2]) < 10)) {
      throw new CairnError(`Node spec is ${this.config.clean(spec)}; RPC 0.10.0 or later is required.`, 2);
    }
    this.identity = { chain, spec: String(spec) };
    return this.identity;
  }

  async head() {
    await this.validate();
    const header = await this.call('starknet_getBlockWithTxHashes', { block_id: 'latest' });
    if (!Number.isSafeInteger(header?.block_number) || !Number.isSafeInteger(header?.timestamp)) throw new NodeBusy();
    return header;
  }
}
