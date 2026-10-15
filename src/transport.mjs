import { setTimeout as delay } from 'node:timers/promises';
import { CairnError, RpcError, busy } from './errors.mjs';

export const wait = (ms, signal) => delay(ms, undefined, { signal });

export async function post(url, body, timeout, signal) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)])
  });
  return response;
}

function retryAfter(header) {
  if (!header) return 0;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(header) - Date.now()) || 0;
}

const RPC_METHODS = new Set(['starknet_chainId', 'starknet_specVersion', 'starknet_blockNumber',
  'starknet_getBlockWithTxHashes', 'starknet_call', 'starknet_getClassHashAt',
  'starknet_getTransactionStatus', 'starknet_getTransactionReceipt']);

export class Rpc {
  constructor(config, signal) {
    this.config = config;
    this.signal = signal;
    this.starts = [];
    this.id = 0;
    this.queue = Promise.resolve();
    this.checked = false;
  }

  // Serialize admission, not network I/O. Each attempt, including retries, consumes one slot.
  async slot() {
    const task = this.queue.then(async () => {
      for (;;) {
        this.signal.throwIfAborted();
        const now = performance.now();
        this.starts = this.starts.filter((t) => now - t < 1010);
        if (this.starts.length < this.config.rpcRps) { this.starts.push(now); return; }
        await wait(Math.ceil(1010 - (now - this.starts[0])), this.signal);
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async call(method, params = {}) {
    if (!RPC_METHODS.has(method)) throw new Error('RPC method is not read-only or not supported');
    if ('block_id' in params && params.block_id !== 'latest' &&
      !(params.block_id && (Number.isSafeInteger(params.block_id.block_number) || /^0x[0-9a-f]+$/i.test(params.block_id.block_hash ?? '')))) throw new Error('invalid block id');
    const id = ++this.id;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.slot();
      let backoff = 150 * 2 ** attempt;
      try {
        const res = await post(this.config.rpcUrl, { jsonrpc: '2.0', id, method, params }, this.config.rpcTimeout, this.signal);
        backoff = Math.max(backoff, retryAfter(res.headers.get('retry-after')));
        if (!res.ok) { await res.body?.cancel(); throw busy(); }
        const answer = await res.json();
        if (answer?.jsonrpc !== '2.0' || answer.id !== id) throw busy();
        if (answer.error) throw new RpcError(answer.error.code);
        if (!Object.hasOwn(answer, 'result')) throw busy();
        return answer.result;
      } catch (e) {
        this.signal.throwIfAborted();
        if (e instanceof RpcError) throw e;
        if (attempt === 2) throw busy();
        await wait(backoff, this.signal);
      }
    }
  }

  async check() {
    if (this.checked) return;
    const chainHex = await this.call('starknet_chainId');
    let chain;
    try {
      if (typeof chainHex !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(chainHex)) throw new Error();
      const hex = BigInt(chainHex).toString(16);
      chain = Buffer.from(hex.padStart(hex.length + hex.length % 2, '0'), 'hex').toString('ascii');
    } catch { throw busy(); }
    if (chain !== this.config.chain) throw new CairnError(`node reports chain ${this.config.redact(chain)}; expected ${this.config.chain}`, 2);
    const spec = await this.call('starknet_specVersion');
    const parts = typeof spec === 'string' ? /^(\d+)\.(\d+)\.(\d+)$/.exec(spec) : null;
    if (!parts || (Number(parts[1]) === 0 && Number(parts[2]) < 10)) {
      throw new CairnError(`node reports RPC spec ${this.config.redact(String(spec))}; require 0.10.0 or later`, 2);
    }
    this.chain = chain;
    this.spec = spec;
    this.checked = true;
  }

  async head() {
    await this.check();
    const block = await this.call('starknet_getBlockWithTxHashes', { block_id: 'latest' });
    if (!Number.isSafeInteger(block?.block_number) || block.block_number < 0 || !Number.isSafeInteger(block.timestamp)) throw busy();
    return block;
  }
}

export class Telegram {
  constructor(config, signal) { this.config = config; this.signal = signal; }

  async call(method, params = {}, { timeout = 10000 } = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let code, answer;
      try {
        const res = await post(`${this.config.tgRoot}/bot${this.config.token}/${method}`, params, timeout, this.signal);
        code = res.status;
        answer = await res.json();
        if (res.ok && answer?.ok === true) return answer.result;
        code = answer?.error_code ?? code;
      } catch {
        this.signal.throwIfAborted();
        // A send may have been accepted: retrying an ambiguous response would risk a duplicate.
        throw new CairnError('Telegram unreachable; check the API origin and connection');
      }
      if (code === 401) throw new CairnError('Telegram rejected the bot token (401)', 3);
      if (code === 409) throw new CairnError('another instance is running (Telegram 409)');
      if (code === 403 && method === 'sendMessage') return null;
      if (code === 429 && attempt === 0) {
        const seconds = answer?.parameters?.retry_after;
        if (!Number.isFinite(seconds) || seconds < 0) throw new CairnError('Telegram returned an invalid retry_after');
        await wait(seconds * 1000, this.signal);
        continue;
      }
      if (code >= 500 && attempt < 2) { await wait(150 * 2 ** attempt, this.signal); continue; }
      throw new CairnError(`Telegram ${method} failed (HTTP ${Number.isInteger(code) ? code : 'error'})`);
    }
  }

  updates(offset, timeout, limit = 100) {
    return this.call('getUpdates', { offset, timeout, limit, allowed_updates: ['message'] }, { timeout: timeout * 1000 + 10000 });
  }

  send(message, text) {
    return this.call('sendMessage', {
      chat_id: message.chat.id, text: this.config.redact(text), parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {})
    });
  }
}
