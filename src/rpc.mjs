const allowed = new Set(['starknet_chainId', 'starknet_specVersion', 'starknet_blockNumber', 'starknet_getBlockWithTxHashes', 'starknet_call', 'starknet_getClassHashAt', 'starknet_getTransactionStatus', 'starknet_getTransactionReceipt']);
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
export class RpcError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
export function rpc(config) {
  const recent = [];
  let nextId = 0;
  async function slot() {
    for (;;) {
      const now = Date.now();
      while (recent.length && now - recent[0] >= 1000) recent.shift();
      if (recent.length < config.rps) { recent.push(now); return; }
      await sleep(Math.max(1, recent[0] + 1001 - now));
    }
  }
  async function call(method, params = {}) {
    if (!allowed.has(method)) throw new Error('RPC method not allowed');
    for (let attempt = 0; attempt < 3; attempt++) {
      await slot();
      let retry = 100 * (attempt + 1);
      try {
        const res = await fetch(config.rpcUrl, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
          signal: AbortSignal.timeout(config.rpcTimeoutMs),
          redirect: 'manual',
        });
        if (res.status === 429 || res.status >= 500) {
          const header = res.headers.get('retry-after');
          if (header) {
            const seconds = Number(header);
            retry = Math.max(retry, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now() || 0);
          }
          throw new RpcError('Node busy', 'retry');
        }
        if (!res.ok) throw new RpcError('Node unavailable', 'busy');
        const payload = await res.json();
        if (payload.error) throw new RpcError('RPC error', payload.error.code);
        if (!Object.hasOwn(payload, 'result')) throw new RpcError('Node unavailable', 'busy');
        return payload.result;
      } catch (e) {
        if (e instanceof RpcError && e.code !== 'retry') throw e;
        if (attempt === 2) throw new RpcError('Node busy', 'busy');
        await sleep(Math.max(0, retry));
      }
    }
  }
  async function verify() {
    const id = await call('starknet_chainId');
    let chain;
    try { chain = Buffer.from(BigInt(id).toString(16).padStart(2, '0'), 'hex').toString('ascii'); }
    catch { chain = String(id); }
    if (chain !== config.chain) throw new RpcError(`Node chain ${chain} (${id}) differs from ${config.chain}`, 'config');
    const spec = await call('starknet_specVersion');
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(spec));
    if (!match || Number(match[1]) < 0 || (Number(match[1]) === 0 && Number(match[2]) < 10)) throw new RpcError(`Node spec ${spec} is below 0.10.0`, 'config');
    return spec;
  }
  return { call, verify };
}
