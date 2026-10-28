import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { CairnError, EndpointLost, log, NodeBusy, RpcError, TelegramDown, TelegramRefused } from './errors.mjs';
import { decodeChain, normalize } from './felt.mjs';

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
// getEvents is the scanner's one chain-wide filter; getTransactionByHash gives the sender for the fee rule.
const READ_METHODS = new Set(['starknet_chainId', 'starknet_specVersion', 'starknet_blockNumber',
  'starknet_getBlockWithTxHashes', 'starknet_getClassHashAt', 'starknet_call',
  'starknet_getTransactionStatus', 'starknet_getTransactionReceipt', 'starknet_getTransactionByHash',
  'starknet_getEvents']);

function validBlockId(value) {
  if (value === 'latest') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) return false;
  if (Object.hasOwn(value, 'block_number')) return Number.isSafeInteger(value.block_number) && value.block_number >= 0;
  if (Object.hasOwn(value, 'block_hash')) {
    try { normalize(value.block_hash, 'hash'); return true; } catch { return false; }
  }
  return false;
}

/**
 * The Starknet endpoints (round 4: STARKNET_RPC_URLS, in order). A call goes to the endpoint that last answered;
 * one that fails (connection, timeout, 429, 5xx, malformed answer) hands the call to the next at once, and a
 * round of every endpoint is tried three times with backoff before the call is node busy. With one endpoint this
 * is round 1's three tries. Each endpoint's chain id is checked before Cairn reads anything else from it, so a
 * fallback on another chain stops Cairn (exit 2) instead of mixing chains. After FAILBACK_MS on a fallback, calls
 * start from the first endpoint again. JSON-RPC errors are answers, not failures: they never fail over.
 */
const FAILBACK_MS = 5 * 60_000;
export class Rpc {
  #times = [];
  #id = 0;
  constructor(config, signal) {
    this.config = config;
    this.signal = signal;
    this.endpoints = (config.rpcUrls ?? [config.rpcUrl]).map((url, i) => ({ url, number: i + 1, chain: null }));
    this.current = 0; // the endpoint calls start from
    this.since = 0; // when calls left the first endpoint
    this.answered = 0; // the endpoint that answered the last call: a paged read stays on it
    this.stats = { requests: 0, errors: 0, failovers: 0 };
  }
  async #slot() {
    for (;;) {
      const now = performance.now();
      this.#times = this.#times.filter((t) => now - t < 1010);
      if (this.#times.length < this.config.rpcRps) { this.#times.push(now); return; }
      await sleep(Math.max(1, 1010 - (now - this.#times[0])), this.signal);
    }
  }
  /** One request to one endpoint: { result }, { error } (a JSON-RPC error), or { failed, wait } to try elsewhere. */
  async #send(endpoint, method, params) {
    await this.#slot();
    this.stats.requests++;
    let wait = 0;
    try {
      const id = ++this.#id;
      const { response, json } = await post(endpoint.url, { jsonrpc: '2.0', id, method, params }, this.config.rpcTimeout, this.signal);
      if (response.status === 429 || response.status >= 500) {
        const retry = response.headers.get('retry-after');
        if (retry !== null) {
          const seconds = Number(retry);
          const ms = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retry) - Date.now());
          if (Number.isFinite(ms)) wait = ms;
        }
      } else if (!response.ok) {
        this.stats.errors++;
        return { failed: true, wait, refused: true };
      } else if (json?.jsonrpc === '2.0' && json.id === id) {
        if (json.error) return { error: new RpcError(json.error.code) };
        if (Object.hasOwn(json, 'result')) return { result: json.result };
      }
    } catch (error) {
      if (this.signal.aborted || error instanceof NodeBusy) throw error;
      // Interrupted connections, timeouts and malformed bodies are retried, never logged verbatim.
    }
    this.stats.errors++;
    return { failed: true, wait };
  }
  /** The endpoint's chain id, read once: true when it is CAIRN_CHAIN, false when it did not answer. */
  async #verify(endpoint) {
    if (endpoint.chain !== null || this.endpoints.length === 1) return true; // one endpoint: the handshake checks it
    const r = await this.#send(endpoint, 'starknet_chainId', {});
    if (r.failed || r.error) return false;
    let chain = 'unknown chain';
    try { chain = decodeChain(r.result); } catch { /* shown as unknown */ }
    if (chain !== this.config.chain) {
      throw new CairnError(`STARKNET_RPC_URLS endpoint ${endpoint.number} is on chain ${chain}, not ${this.config.chain}: every endpoint must serve CAIRN_CHAIN.`, 2);
    }
    endpoint.chain = chain;
    return true;
  }
  /** Startup: the chain id of every endpoint that answers, so a misconfigured fallback exits 2 before it is needed. */
  async verifyAll() {
    if (this.endpoints.length < 2) return;
    for (const endpoint of this.endpoints) await this.#verify(endpoint);
  }
  /**
   * A read. `endpoint` pins it to one endpoint (by index): a paged read whose continuation token only that
   * endpoint understands. When the pinned endpoint fails, the call throws EndpointLost and the next call
   * starts on the following endpoint.
   */
  async call(method, params = {}, { endpoint } = {}) {
    if (!READ_METHODS.has(method)) throw new CairnError('Unsupported RPC method.');
    if (params.block_id !== undefined && !validBlockId(params.block_id)) {
      throw new CairnError('Unsupported block identifier.');
    }
    const n = this.endpoints.length;
    if (endpoint === undefined && this.current !== 0 && performance.now() - this.since >= FAILBACK_MS) this.current = 0;
    const order = endpoint === undefined ? Array.from({ length: n }, (_, k) => (this.current + k) % n) : [endpoint];
    for (let attempt = 0; attempt < 3; attempt++) {
      let wait = 200 * 2 ** attempt;
      for (const index of order) {
        const target = this.endpoints[index];
        const ready = method === 'starknet_chainId' || await this.#verify(target);
        const r = ready ? await this.#send(target, method, params) : { failed: true, wait: 0 };
        if (!r.failed) {
          this.#answered(index);
          if (r.error) throw r.error;
          return r.result;
        }
        if (r.refused && n === 1) throw new NodeBusy(); // a 4xx from the only endpoint: retrying will not help
        wait = Math.max(wait, r.wait);
        if (n > 1) this.#rotate((index + 1) % n);
        if (endpoint !== undefined && n > 1) throw new EndpointLost();
      }
      if (attempt < 2) await sleep(wait, this.signal);
    }
    throw new NodeBusy();
  }
  #rotate(index) {
    if (this.current === 0 && index !== 0) this.since = performance.now();
    this.current = index;
  }
  #answered(index) {
    this.#rotate(index);
    if (index !== this.answered) {
      this.stats.failovers++;
      log('warn', `RPC endpoint ${this.endpoints[this.answered].number} failed; endpoint ${this.endpoints[index].number} answers now.`);
    }
    this.answered = index;
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
        throw new TelegramDown('Telegram unreachable; check TELEGRAM_API_ROOT and connectivity.');
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
          if (!Number.isFinite(seconds) || seconds < 0 || attempt === 2) throw new TelegramDown('Telegram rate limit; retry_after missing or retries exhausted.');
          await sleep(seconds * 1000, this.signal);
          break;
        }
        default:
          if (code >= 500 && json?.ok === false && Number.isInteger(json.error_code) && attempt < 2) {
            await sleep(200 * 2 ** attempt, this.signal);
            break;
          }
          if (Number.isInteger(code) && code >= 400 && code < 500 && json?.ok === false) throw new TelegramRefused(method, code, json);
          // A 5xx or an answer that is not the Bot API's: Telegram is having trouble, and `run` waits it out.
          throw new (Number.isInteger(code) && code < 500 ? CairnError : TelegramDown)(`Telegram request ${method} failed (${Number.isInteger(code) ? code : 'invalid response'}).`);
      }
    }
    throw new TelegramDown('Telegram retry budget exhausted.');
  }
}
