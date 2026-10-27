import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { CairnError, EndpointLost, log, NodeBusy, RpcError, TelegramDown, TelegramRefused } from './errors.mjs';
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
// getEvents is the scanner's one chain-wide filter; getTransactionByHash gives the sender for the fee rule.
const READ_METHODS = new Set(['starknet_chainId', 'starknet_specVersion', 'starknet_blockNumber',
  'starknet_getBlockWithTxHashes', 'starknet_getClassHashAt', 'starknet_call',
  'starknet_getTransactionStatus', 'starknet_getTransactionReceipt', 'starknet_getTransactionByHash',
  'starknet_getEvents']);
const IDENTITY = new Set(['starknet_chainId', 'starknet_specVersion']);
/** JSON-RPC errors that say the endpoint cannot serve the call, rather than answer it: -32xxx, and the spec's UNEXPECTED_ERROR (63). */
const unserved = (code) => (Number.isInteger(code) && code < 0) || code === 63;
/** A failed endpoint goes to the back of the line for this long; then the list's order (the primary first) holds again. */
export const FAILBACK_MS = 60_000;

function validBlockId(value) {
  if (value === 'latest') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) return false;
  if (Object.hasOwn(value, 'block_number')) return Number.isSafeInteger(value.block_number) && value.block_number >= 0;
  if (Object.hasOwn(value, 'block_hash')) {
    try { normalize(value.block_hash, 'hash'); return true; } catch { return false; }
  }
  return false;
}
function retryAfterOf(response) {
  const retry = response.headers.get('retry-after');
  if (retry === null) return 0;
  const seconds = Number(retry);
  const ms = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(retry) - Date.now());
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * JSON-RPC over the configured endpoints: STARKNET_RPC_URL, or from round 4 the failover list STARKNET_RPC_URLS.
 * One rate limit covers them all. A call goes to the first endpoint that has not failed in the last minute, in
 * the list's order; an HTTP 429, 5xx, timeout or broken answer moves it to the next one, and each endpoint gets up
 * to 3 tries with backoff of at least its Retry-After. With one endpoint this is round 1's rule exactly. An endpoint
 * answers the chain and spec handshake (`identifyWith`) once, before its first other call; a request pinned to one
 * endpoint (a continuation token) never moves, and throws EndpointLost when that endpoint fails.
 */
export class Rpc {
  #times = [];
  #id = 0;
  constructor(config, signal) {
    this.config = config;
    this.signal = signal;
    const urls = config.rpcUrls ?? [config.rpcUrl];
    this.endpoints = urls.map((url, index) => ({ url, index, failedAt: -Infinity, notBefore: 0, identity: null, requests: 0, errors: 0 }));
    this.current = 0; // the endpoint that answered last
    this.check = null;
  }
  /** `check(index)` runs the handshake on one endpoint and returns its identity, or throws (exit 2 on a wrong chain). */
  identifyWith(check) { this.check = check; }
  /** The endpoint's identity, checked now if it has none yet. Throws NodeBusy when it cannot be reached. */
  async identify(index) {
    const endpoint = this.endpoints[index];
    endpoint.identity ??= await this.check(index);
    return endpoint.identity;
  }
  /** Sends an endpoint to the back of the line for `ms`: one whose head stopped moving while another's did not. */
  demote(index, ms = 10 * FAILBACK_MS) { this.endpoints[index].failedAt = performance.now() + ms - FAILBACK_MS; }
  /** "endpoint 2 of 3", or "the node" when there is only one: never its URL, which is a secret. */
  name(index) { return this.endpoints.length > 1 ? `endpoint ${index + 1} of ${this.endpoints.length}` : 'the node'; }

  async #slot() {
    for (;;) {
      const now = performance.now();
      this.#times = this.#times.filter((t) => now - t < 1010);
      if (this.#times.length < this.config.rpcRps) { this.#times.push(now); return; }
      await sleep(Math.max(1, 1010 - (now - this.#times[0])), this.signal);
    }
  }
  #order(skip) {
    const now = performance.now(), fresh = (e) => now - e.failedAt >= FAILBACK_MS;
    return this.endpoints.filter((e) => !skip.has(e.index)).sort((a, b) => Number(fresh(b)) - Number(fresh(a)) || a.index - b.index);
  }
  /** One HTTP request to one endpoint: { result }, { rpcError }, { retry, wait } or { refused }. */
  async #attempt(endpoint, method, params, round) {
    await this.#slot();
    endpoint.requests++;
    const failed = (outcome) => {
      endpoint.errors++;
      endpoint.failedAt = performance.now();
      endpoint.notBefore = endpoint.failedAt + Math.max(200 * 2 ** round, outcome.retryAfter ?? 0);
      return outcome;
    };
    try {
      const id = ++this.#id;
      const { response, json } = await post(endpoint.url, { jsonrpc: '2.0', id, method, params }, this.config.rpcTimeout, this.signal);
      if (response.status === 429 || response.status >= 500) return failed({ retry: true, retryAfter: retryAfterOf(response) });
      if (!response.ok) return failed({ refused: true }); // no retry fixes it: try another endpoint
      if (json?.jsonrpc === '2.0' && json.id === id && (json.error || Object.hasOwn(json, 'result'))) {
        endpoint.failedAt = -Infinity;
        if (this.current !== endpoint.index && this.endpoints.length > 1) log('warn', 'rpc endpoint', { using: this.name(endpoint.index) });
        this.current = endpoint.index;
        return json.error ? { rpcError: json.error.code } : { result: json.result };
      }
    } catch (error) {
      if (this.signal.aborted) throw error;
      // Interrupted connections, timeouts and malformed bodies are retried, never logged verbatim.
    }
    return failed({ retry: true });
  }
  /** The result of `method`, and which endpoint gave it: { result, endpoint }. */
  async request(method, params = {}, { endpoint: pinned } = {}) {
    if (!READ_METHODS.has(method)) throw new CairnError('Unsupported RPC method.');
    if (params.block_id !== undefined && !validBlockId(params.block_id)) throw new CairnError('Unsupported block identifier.');
    const skip = new Set();
    let last = null;
    for (let round = 0; round < 3; round++) {
      const ready = pinned === undefined ? this.#order(skip) : skip.has(pinned) ? [] : [this.endpoints[pinned]];
      if (!ready.length) break;
      if (round > 0) await sleep(Math.max(0, Math.min(...ready.map((e) => e.notBefore)) - performance.now()), this.signal);
      const start = performance.now() + 10; // a timer may fire a few milliseconds early: the one awaited is due
      for (const endpoint of ready) {
        if (round > 0 && endpoint.notBefore > start) continue; // its backoff or Retry-After has not passed
        if (this.check && !endpoint.identity && !IDENTITY.has(method)) {
          try { await this.identify(endpoint.index); }
          catch (error) {
            if (this.signal.aborted || (error instanceof CairnError && error.exitCode === 2)) throw error; // a wrong chain or spec stops Cairn
            endpoint.failedAt = performance.now(); // unreachable, or no usable answer: the next endpoint goes first
            skip.add(endpoint.index);
            continue;
          }
        }
        const outcome = await this.#attempt(endpoint, method, params, round);
        if (Object.hasOwn(outcome, 'result')) return { result: outcome.result, endpoint: endpoint.index };
        if (Object.hasOwn(outcome, 'rpcError')) {
          // A JSON-RPC error of the endpoint itself (internal error, method not served, a provider's refusal) moves
          // to the next endpoint when there is one; the spec's own errors (not found, contract error…) are answers.
          if (pinned !== undefined || this.endpoints.length === 1 || !unserved(outcome.rpcError)) throw new RpcError(outcome.rpcError);
          last = new RpcError(outcome.rpcError);
          endpoint.errors++;
          endpoint.failedAt = performance.now();
          skip.add(endpoint.index);
        }
        if (outcome.refused) skip.add(endpoint.index);
      }
    }
    if (last && skip.size === this.endpoints.length) throw last;
    throw pinned === undefined ? new NodeBusy() : new EndpointLost();
  }
  async call(method, params = {}, options = {}) { return (await this.request(method, params, options)).result; }
}

export class Telegram {
  constructor(config, signal) {
    this.config = config;
    this.signal = signal;
    this.healthy = true; // false once a call failed for want of Telegram, until getUpdates answers again
    this.errors = 0;
  }
  async call(method, params = {}) {
    try {
      const result = await this.#call(method, params);
      if (method === 'getUpdates') this.healthy = true;
      return result;
    } catch (error) {
      if (error instanceof TelegramDown) { this.healthy = false; this.errors++; }
      throw error;
    }
  }
  async #call(method, params) {
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
          throw new TelegramDown(`Telegram request ${method} failed (${Number.isInteger(code) ? code : 'invalid response'}).`);
      }
    }
    throw new TelegramDown('Telegram retry budget exhausted.');
  }
}
