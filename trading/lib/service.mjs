import { CHAIN, EXCHANGE, EXCHANGE_CLASS, TOKENS, address, felt, input, minReceived, validateCalls, tradeStatus } from './core.mjs';

export class ApiError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const BALANCE = '0x35a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33';
const BALANCE_LEGACY = '0x2e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e';
const AVNU = 'https://starknet.api.avnu.fi';
export function createService({ rpcUrls = [], fetcher = fetch, now = Date.now, version = 'development' } = {}) {
  async function json(url, body) {
    let r;
    try { r = await fetcher(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'user-agent': 'Cairn-Trading/1.0' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000) }); }
    catch { throw new ApiError('Trading provider is temporarily unavailable. No trade was submitted.', 503); }
    if (!r.ok) throw new ApiError(r.status === 429 ? 'Provider rate limit. Please wait and try again.' : 'Trading provider is unavailable. Please get a fresh quote.', 503);
    const text = await r.text(); if (text.length > 512000) throw new ApiError('Provider response is too large.', 502);
    try { return JSON.parse(text); } catch { throw new ApiError('Invalid provider response.', 502); }
  }
  async function rpc(method, params) {
    for (const url of rpcUrls) {
      try { const r = await json(url, { jsonrpc: '2.0', id: 1, method, params }); if (r.error) { const e = new Error('RPC request failed.'); e.code = r.error.code; throw e; } return r.result; }
      catch (e) { if (e.code === 20 || e.code === 21 || e.code === 29) throw e; }
    }
    throw new ApiError('Starknet RPC is unavailable. Check your wallet before retrying any trade.', 503);
  }
  async function identity() {
    const [chainId, classHash] = await Promise.all([rpc('starknet_chainId', {}), rpc('starknet_getClassHashAt', { block_id: 'latest', contract_address: EXCHANGE })]);
    if (felt(chainId) !== CHAIN || felt(classHash) !== EXCHANGE_CLASS) throw new ApiError('Trading is paused: the network or exchange version changed.', 503);
  }
  async function balance(owner, t) {
    const params = { request: { contract_address: t.address, entry_point_selector: BALANCE, calldata: [owner] }, block_id: 'latest' };
    let r;
    try { r = await rpc('starknet_call', params); }
    catch (e) { if (e.code !== 21) throw e; params.request.entry_point_selector = BALANCE_LEGACY; r = await rpc('starknet_call', params); }
    if (!Array.isArray(r) || r.length !== 2 || r.some(v => BigInt(felt(v)) >= 1n << 128n)) throw new ApiError('Token balance is unavailable.', 503);
    return (BigInt(r[0]) + (BigInt(r[1]) << 128n)).toString();
  }
  return {
    async config() { await identity(); return { version, chainId: CHAIN, exchange: EXCHANGE, exchangeClass: EXCHANGE_CLASS, tokens: TOKENS, integratorFeeBps: 0 }; },
    async account(raw) {
      const owner = address(raw.owner); await identity();
      let deployed = true;
      try { await rpc('starknet_getClassHashAt', { block_id: 'latest', contract_address: owner }); } catch (e) { if (e.code === 20) deployed = false; else throw e; }
      const balances = await Promise.all(TOKENS.map(async t => { try { return { symbol: t.symbol, amount: await balance(owner, t) }; } catch { return { symbol: t.symbol, amount: null }; } }));
      return { owner, deployed, balances };
    },
    async quote(raw) {
      const e = input(raw); await identity();
      const query = new URLSearchParams({ sellTokenAddress: e.sell.address, buyTokenAddress: e.buy.address, sellAmount: '0x' + BigInt(e.amount).toString(16), takerAddress: e.owner, size: '1' });
      const quotes = await json(AVNU + '/swap/v3/quotes?' + query);
      if (!Array.isArray(quotes) || !quotes.length) throw new ApiError('No route is available for this pair and amount.');
      const q = quotes[0];
      if (felt(q.chainId) !== CHAIN || address(q.sellTokenAddress) !== e.sell.address || address(q.buyTokenAddress) !== e.buy.address || BigInt(q.sellAmount) !== BigInt(e.amount)
        || typeof q.quoteId !== 'string' || q.quoteId.length > 100 || BigInt(q.buyAmount) <= 0n || BigInt(q.buyAmount) >= 1n << 256n) throw new ApiError('Provider quote differs from your requested trade.', 502);
      if (q.fee && BigInt(q.fee.integratorFees ?? '0') !== 0n) throw new ApiError('Unexpected application fee.', 502);
      const createdAt = now();
      const expiresAt = Math.min(createdAt + 30000, q.expiry ? q.expiry * 1000 : Infinity);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= createdAt + 3000) throw new ApiError('Quote expired. Please refresh it.');
      const built = await json(AVNU + '/swap/v3/build', { quoteId: q.quoteId, takerAddress: e.owner, slippage: e.slippageBps / 10000, includeApprove: true });
      const bundle = { ...e, version: 1, chainId: CHAIN, exchangeClass: EXCHANGE_CLASS, quoteId: q.quoteId,
        buyAmount: BigInt(q.buyAmount).toString(), minimumReceived: minReceived(q.buyAmount, e.slippageBps).toString(), createdAt, expiresAt,
        routes: Array.isArray(q.routes) ? [...new Set(q.routes.map(r => String(r.name).slice(0,40)))].slice(0,10) : [],
        fee: q.fee ? { token: felt(q.fee.feeToken), avnuAmount: BigInt(q.fee.avnuFees).toString(), integratorAmount: '0' } : null,
        gasEstimate: q.gasFees ? BigInt(q.gasFees).toString() : null,
        priceImpactBps: Number.isFinite(q.priceImpact) ? q.priceImpact : null,
        sellUsd: Number.isFinite(q.sellAmountInUsd) ? q.sellAmountInUsd : null,
        buyUsd: Number.isFinite(q.buyAmountInUsd) ? q.buyAmountInUsd : null };
      // Never allow provider fields to replace the validated trade metadata.
      bundle.calls = validateCalls(built, { ...bundle, ...e });
      bundle.chainId = CHAIN; bundle.executorAddress = null;
      if (expiresAt <= now()) throw new ApiError('Quote expired. Please refresh it.');
      return bundle;
    },
    async receipt(raw) {
      const hash = address(raw.hash);
      if (felt(await rpc('starknet_chainId', {})) !== CHAIN) throw new ApiError('Receipt network is unavailable.', 503);
      let receipt; try { receipt = await rpc('starknet_getTransactionReceipt', { transaction_hash: hash }); }
      catch (e) { if (e.code === 29) return { hash, ...tradeStatus(null) }; throw e; }
      if (!receipt || felt(receipt.transaction_hash) !== hash) throw new ApiError('Receipt does not match this transaction. Check your wallet.', 503);
      return { hash, ...tradeStatus(receipt), finality: receipt.finality_status ?? null, execution: receipt.execution_status ?? null,
        block: receipt.block_number ?? null, actualFee: receipt.actual_fee ?? null };
    },
  };
}

export function createHandler(service) {
  const limits = new Map();
  return async function handle(action, raw, client = 'local') {
    if (!['config', 'account', 'quote', 'receipt'].includes(action)) throw new ApiError('Not found.', 404);
    const at = Date.now(), window = Math.floor(at / 60000), key = client.slice(0,100), prior = limits.get(key);
    const slot = prior?.window === window ? prior : { window, count: 0 };
    if (++slot.count > 60) throw new ApiError('Too many requests. Please wait a minute.', 429);
    if (limits.size > 2000) limits.clear(); limits.set(key, slot);
    try { return await service[action](raw); }
    catch (e) { if (e instanceof ApiError) throw e; throw new ApiError(e.code ? 'Starknet could not read this account or transaction.' : e.message, e.code ? 503 : 400); }
  };
}
