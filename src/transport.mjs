import { setTimeout as delay } from 'node:timers/promises';
import { Failure } from './config.mjs';

export async function sleep(ms, signal) {
  // Node timers overflow above 2^31-1; large configured waits must stay waits.
  do {
    const part = Math.min(ms, 2147483647);
    await delay(part, undefined, { signal });
    ms -= part;
  } while (ms > 0);
}

// No redirects, proxy environment, fallback hosts, or raw error bodies leave this boundary.
async function post(url, body, timeout, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeout, 2147483647));
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), redirect: 'manual', signal: AbortSignal.any([signal, controller.signal]) });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of res.body) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) throw new Error('Response too large');
      chunks.push(chunk);
    }
    let json;
    try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
    return { status: res.status, headers: Object.fromEntries(res.headers), json };
  } finally { clearTimeout(timer); }
}

export class RpcError extends Error {
  constructor(code) { super('Node busy. Please try again.'); this.code = code; }
}

const RPC_METHODS = new Set(['starknet_chainId', 'starknet_specVersion', 'starknet_blockNumber',
  'starknet_getBlockWithTxHashes', 'starknet_call', 'starknet_getClassHashAt',
  'starknet_getTransactionStatus', 'starknet_getTransactionReceipt']);

export function rpcClient(c, signal) {
  let id = 0, ready, chain, spec;
  const calls = [];
  async function rpc(method, params = {}) {
    if (!RPC_METHODS.has(method)) throw new Failure('Unsupported RPC method');
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      while (calls.length && performance.now() - calls[0] >= 1005) calls.shift();
      if (calls.length >= c.rps) {
        await sleep(Math.max(1, 1005 - (performance.now() - calls[0])), signal);
        while (calls.length && performance.now() - calls[0] >= 1005) calls.shift();
      }
      calls.push(performance.now());
      let response;
      const requestId = ++id;
      try { response = await post(c.rpc, { jsonrpc: '2.0', id: requestId, method, params }, c.rpcTimeout, signal); }
      catch { signal.throwIfAborted(); }
      if (response?.status === 200 && response.json?.jsonrpc === '2.0' && response.json.id === requestId) {
        if (response.json.error) throw new RpcError(response.json.error.code);
        if (Object.hasOwn(response.json, 'result')) return response.json.result;
      }
      const status = response?.status;
      if (status && status !== 200 && status !== 429 && status < 500) throw new RpcError();
      if (attempt === 2) throw new RpcError();
      const after = response?.headers['retry-after'];
      const retryMs = /^\d+(\.\d+)?$/.test(after ?? '') ? Number(after) * 1000 : Math.max(0, Date.parse(after) - Date.now()) || 0;
      await sleep(Math.max(250 * 2 ** attempt, retryMs), signal);
    }
  }
  async function handshake() {
    // Retry a failed startup check on a later pass; a successful check is once per process.
    if (!ready) ready = (async () => {
      const felt = await rpc('starknet_chainId');
      if (typeof felt !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(felt)) throw new RpcError();
      let hex = felt.slice(2); if (hex.length % 2) hex = `0${hex}`;
      chain = Buffer.from(hex, 'hex').toString('utf8');
      if (chain !== c.chain) throw new Failure(`Node reported chain ${chain}; expected ${c.chain}`, 2);
      spec = await rpc('starknet_specVersion');
      const v = typeof spec === 'string' && /^(\d+)\.(\d+)\.(\d+)$/.exec(spec);
      if (!v || (Number(v[1]) === 0 && Number(v[2]) < 10)) throw new Failure(`Node reported RPC spec ${typeof spec === 'string' ? spec : 'invalid'}; need 0.10.0 or later`, 2);
      return { chain, spec };
    })().catch(e => { ready = undefined; throw e; });
    return ready;
  }
  return { handshake, get spec() { return spec; }, async call(method, params) { await handshake(); return rpc(method, params); } };
}

export function telegramClient(c, signal) {
  return async (method, params = {}) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      let r;
      try { r = await post(`${c.telegram}/bot${c.token}/${method}`, params, (params.timeout ?? 0) * 1000 + 10000, signal); }
      catch { signal.throwIfAborted(); throw new Failure('Telegram unreachable; check TELEGRAM_API_ROOT and network access'); }
      const code = r.json?.error_code ?? r.status;
      if (code === 401) throw new Failure('Telegram rejected TELEGRAM_BOT_TOKEN (401)', 3);
      if (code === 409) throw new Failure('Telegram conflict (409): another instance is running');
      if (r.status === 200 && r.json?.ok === true) return r.json.result;
      if (code === 403 && method === 'sendMessage') return null;
      if (code === 429 && attempt < 2) {
        const seconds = r.json?.parameters?.retry_after;
        if (Number.isFinite(seconds) && seconds >= 0) { await sleep(seconds * 1000, signal); continue; }
      }
      if (code >= 500 && attempt < 2) { await sleep(250 * 2 ** attempt, signal); continue; }
      throw new Failure(`Telegram ${method} failed (${Number.isInteger(code) ? code : 'invalid response'}); check bot access and retry`);
    }
  };
}
