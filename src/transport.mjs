import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { CairnError, NodeBusy, RpcError } from './errors.mjs';
import { normalize } from './felt.mjs';

const TIMER_MAX = 2147483647;
export async function sleep(ms, signal) {
  do {
    const chunk = Math.min(ms, TIMER_MAX);
    await delay(chunk, undefined, { signal });
    ms -= chunk;
  } while (ms > 0);
}

function deadline(milliseconds) {
  const controller = new AbortController();
  let timer;
  const schedule = () => {
    const chunk = Math.min(milliseconds, TIMER_MAX);
    milliseconds -= chunk;
    timer = setTimeout(() => milliseconds > 0 ? schedule() : controller.abort(), chunk);
    timer.unref();
  };
  schedule();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function post(url, body, timeout, signal) {
  const limit = deadline(timeout);
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.any([signal, limit.signal]),
    });
    let json;
    try { json = await response.json(); } catch { json = null; }
    return { response, json };
  } finally { limit.clear(); }
}
const READ_METHODS = new Set(['starknet_chainId', 'starknet_specVersion', 'starknet_blockNumber',
  'starknet_getBlockWithTxHashes', 'starknet_getClassHashAt', 'starknet_call',
  'starknet_getTransactionStatus', 'starknet_getTransactionReceipt',
  // Round 2: the chain-wide event scan, and a transaction's sender for the fee rule.
  'starknet_getEvents', 'starknet_getTransactionByHash']);

function validBlockId(value) {
  if (value === 'latest') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) return false;
  if (Object.hasOwn(value, 'block_number')) return Number.isSafeInteger(value.block_number) && value.block_number >= 0;
  if (Object.hasOwn(value, 'block_hash')) {
    try { normalize(value.block_hash, 'hash'); return true; } catch { return false; }
  }
  return false;
}

export class Rpc {
  #times = [];
  #id = 0;
  constructor(config, signal) { this.config = config; this.signal = signal; }
  async #slot() {
    for (;;) {
      const now = performance.now();
      this.#times = this.#times.filter((t) => now - t < 1010);
      if (this.#times.length < this.config.rpcRps) { this.#times.push(now); return; }
      await sleep(Math.max(1, 1010 - (now - this.#times[0])), this.signal);
    }
  }
  async call(method, params = {}) {
    if (!READ_METHODS.has(method)) throw new CairnError('Unsupported RPC method.');
    if (params.block_id !== undefined && !validBlockId(params.block_id)) {
      throw new CairnError('Unsupported block identifier.');
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.#slot();
      let wait = 200 * 2 ** attempt;
      try {
        const id = ++this.#id;
        const { response, json } = await post(this.config.rpcUrl, { jsonrpc: '2.0', id, method, params }, this.config.rpcTimeout, this.signal);
        if (response.status === 429 || response.status >= 500) {
          const retry = response.headers.get('retry-after');
          if (retry !== null) {
            const seconds = Number(retry);
            const ms = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retry) - Date.now());
            if (Number.isFinite(ms)) wait = Math.max(wait, ms);
          }
        } else if (!response.ok) {
          throw new NodeBusy();
        } else if (json?.jsonrpc === '2.0' && json.id === id) {
          if (json.error) throw new RpcError(json.error.code);
          if (Object.hasOwn(json, 'result')) return json.result;
        }
      } catch (error) {
        if (this.signal.aborted || error instanceof RpcError || error instanceof NodeBusy) throw error;
        // Interrupted connections, timeouts and malformed bodies are retried, never logged verbatim.
      }
      if (attempt < 2) await sleep(wait, this.signal);
    }
    throw new NodeBusy();
  }
}
// Telegram kept answering 429: what was to be sent waits for a later pass.
export class TelegramLimited extends CairnError {
  constructor() { super('Telegram rate limit; retry_after missing or retries exhausted.'); }
}
// Telegram refused a request for a reason the caller may handle: a group that became a supergroup
// (parameters.migrate_to_chat_id), an edit that changes nothing, a button that expired.
export class TelegramRefusal extends CairnError {
  constructor(method, code, description, parameters) {
    super(`Telegram request ${method} failed (${code}).`);
    this.code = code;
    this.description = typeof description === 'string' ? description : '';
    this.parameters = parameters ?? {};
  }
}
export class Telegram {
  constructor(config, signal) { this.config = config; this.signal = signal; }
  async call(method, params = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let result;
      try {
        result = await post(`${this.config.telegramRoot}/bot${this.config.token}/${method}`, params,
          (params.timeout ?? 0) * 1000 + 5000, this.signal);
      } catch (error) {
        if (this.signal.aborted) throw error;
        // A send may have been accepted before connection failure. Never resend ambiguously.
        throw new CairnError('Telegram unreachable; check TELEGRAM_API_ROOT and connectivity.');
      }
      const { response, json } = result;
      if (response.ok && json?.ok === true) return json.result;
      const code = json?.error_code ?? response.status;
      switch (code) {
        case 401: throw new CairnError('Telegram rejected the token (401); replace it through BotFather.', 3);
        case 409: throw new CairnError('Telegram conflict (409): another instance is running.');
        case 403: return null;
        case 429: {
          const seconds = json?.parameters?.retry_after;
          if (!Number.isFinite(seconds) || seconds < 0 || attempt === 2) throw new TelegramLimited();
          await sleep(seconds * 1000, this.signal);
          break;
        }
        default:
          if (code >= 500 && json?.ok === false && Number.isInteger(json.error_code) && attempt < 2) {
            await sleep(200 * 2 ** attempt, this.signal);
            break;
          }
          if (Number.isInteger(code) && code >= 400 && code < 500) throw new TelegramRefusal(method, code, json?.description, json?.parameters);
          throw new CairnError(`Telegram request ${method} failed (${Number.isInteger(code) ? code : 'invalid response'}).`);
      }
    }
    throw new CairnError('Telegram retry budget exhausted.');
  }
}
