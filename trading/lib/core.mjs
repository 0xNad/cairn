// Shared by the API and browser. No signer, credential, or transaction submission lives here.
export const CHAIN = '0x534e5f4d41494e';
export const EXCHANGE = '0x4270219d365d6b017231b52e92b3fb5d7c8378b05e9abc97724537a80e93b0f';
export const EXCHANGE_CLASS = '0x210cb6607c5d290d71584040936e0c429618c2d08765e5f7ccb71252595fb1b';
export const TOKENS = Object.freeze([
  { symbol: 'STRK', name: 'Starknet', decimals: 18, address: '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d' },
  { symbol: 'ETH', name: 'Ether', decimals: 18, address: '0x49d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7' },
  { symbol: 'USDC', name: 'USDC · native', decimals: 6, address: '0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb' },
  { symbol: 'USDC.e', name: 'USDC · bridged', decimals: 6, address: '0x53c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8' },
  { symbol: 'USDT', name: 'Tether', decimals: 6, address: '0x68f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8' },
  { symbol: 'WBTC', name: 'Wrapped Bitcoin', decimals: 8, address: '0x3fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac' },
]);
const FIELD = (1n << 251n) + 17n * (1n << 192n) + 1n;
export function felt(x) {
  if (typeof x !== 'string' || !/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(x)) throw new Error('Invalid Starknet value.');
  const n = BigInt(x); if (n < 0n || n >= FIELD) throw new Error('Starknet value is out of range.');
  return '0x' + n.toString(16);
}
export function address(x) { const a = felt(x); if (a === '0x0') throw new Error('Enter a nonzero wallet address.'); return a; }
export function token(x) {
  const t = TOKENS.find(t => t.symbol.toLowerCase() === String(x).toLowerCase() || t.address === String(x).toLowerCase());
  if (!t) throw new Error('Choose one of the supported tokens.'); return t;
}
export function units(x, decimals) {
  if (typeof x !== 'string' || x.length > 100 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(x)) throw new Error('Enter a positive decimal amount, without commas or exponents.');
  const [whole, fraction = ''] = x.split('.');
  if (fraction.length > decimals) throw new Error(`This token supports ${decimals} decimal places.`);
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (value <= 0n || value >= 1n << 256n) throw new Error('Amount is out of range.'); return value;
}
export function format(x, decimals, places = decimals) {
  const n = BigInt(x), base = 10n ** BigInt(decimals), tail = (n % base).toString().padStart(decimals, '0').slice(0, places).replace(/0+$/, '');
  return (n / base).toString() + (tail ? '.' + tail : '');
}
export function slippage(x) { if (!Number.isInteger(x) || x < 10 || x > 100) throw new Error('Choose slippage from 0.1% to 1%.'); return x; }
export function minReceived(buy, bps) { return BigInt(buy) * BigInt(10000 - slippage(bps)) / 10000n; }
export function input(raw) {
  const sell = token(raw.sell), buy = token(raw.buy), owner = address(raw.owner);
  if (sell === buy) throw new Error('Choose two different tokens.');
  return { sell, buy, owner, amount: units(raw.amount, sell.decimals).toString(), slippageBps: slippage(raw.slippageBps) };
}
function u256(lo, hi) {
  const l = BigInt(felt(lo)), h = BigInt(felt(hi));
  if (l >= 1n << 128n || h >= 1n << 128n) throw new Error('Invalid u256 limbs.'); return l + (h << 128n);
}
// Decode the pinned Exchange ABI, including the variable route tail. Unknown calls fail closed.
export function validateCalls(built, q) {
  if (felt(built.chainId) !== CHAIN || built.executorAddress) throw new Error('Unexpected trade network or executor.');
  const calls = built.calls;
  if (!Array.isArray(calls) || calls.length !== 2) throw new Error('Trade must contain only an exact approval and swap.');
  for (const c of calls) {
    if (!Array.isArray(c.calldata) || c.calldata.length > 4096) throw new Error('Invalid transaction calldata.');
    c.calldata.forEach(felt);
  }
  const [approval, swap] = calls;
  if (address(approval.contractAddress) !== q.sell.address || approval.entrypoint !== 'approve' || approval.calldata.length !== 3
    || address(approval.calldata[0]) !== EXCHANGE || u256(...approval.calldata.slice(1)) !== BigInt(q.amount)) throw new Error('Unexpected approval token, spender or amount.');
  if (address(swap.contractAddress) !== EXCHANGE || swap.entrypoint !== 'multi_route_swap') throw new Error('Unexpected swap contract or method.');
  const d = swap.calldata;
  if (d.length < 18 || address(d[0]) !== q.sell.address || u256(d[1], d[2]) !== BigInt(q.amount)
    || address(d[3]) !== q.buy.address || u256(d[4], d[5]) !== BigInt(q.buyAmount)
    || u256(d[6], d[7]) !== BigInt(q.minimumReceived) || address(d[8]) !== q.owner
    || BigInt(d[9]) !== 0n || BigInt(d[10]) !== 0n) throw new Error('Swap differs from the reviewed trade.');
  let pos = 11;
  const count = (max) => { const n = Number(BigInt(d[pos++])); if (!Number.isSafeInteger(n) || n < 0 || n > max) throw new Error('Invalid route length.'); return n; };
  const direct = () => { address(d[pos++]); const percent = BigInt(d[pos++]); if (percent <= 0n || percent > 1000000000000n) throw new Error('Invalid route allocation.'); const n = count(1024); pos += n; if (pos > d.length) throw new Error('Truncated route.'); };
  const n = count(64); if (!n) throw new Error('Empty trade route.');
  for (let i = 0; i < n; i++) {
    address(d[pos++]); address(d[pos++]);
    // RouteSwapSerde: Direct has no tag; Branch starts with felt("branch").
    const branch = BigInt(d[pos]) === 108243400418152n;
    if (branch) pos++;
    direct();
    if (branch) { const alternatives = count(32); for (let j = 0; j < alternatives; j++) direct(); }
  }
  if (pos !== d.length) throw new Error('Unexpected trailing calldata.');
  return calls.map(c => ({ contractAddress: address(c.contractAddress), entrypoint: c.entrypoint, calldata: c.calldata.map(felt) }));
}
export function validateBundle(b, expected, now = Date.now()) {
  if (!b || b.version !== 1 || felt(b.chainId) !== CHAIN || felt(b.exchangeClass) !== EXCHANGE_CLASS) throw new Error('Unsupported trade response.');
  const e = input(expected);
  if (b.owner !== e.owner || b.sell?.address !== e.sell.address || b.buy?.address !== e.buy.address || b.amount !== e.amount || b.slippageBps !== e.slippageBps) throw new Error('Quote does not match your wallet and inputs.');
  if (!Number.isSafeInteger(b.createdAt) || !Number.isSafeInteger(b.expiresAt) || b.createdAt > now + 1000 || b.expiresAt <= now
    || b.expiresAt > b.createdAt + 30000) throw new Error('Quote expired. Get a fresh quote.');
  if (BigInt(b.buyAmount) <= 0n || BigInt(b.buyAmount) >= 1n << 256n || BigInt(b.minimumReceived) <= 0n || b.minimumReceived !== minReceived(b.buyAmount, e.slippageBps).toString()) throw new Error('Invalid minimum received.');
  return validateCalls(b, b);
}
export function tradeStatus(r) {
  if (!r) return { state: 'unknown', label: 'Status unavailable — check your wallet before retrying' };
  const finality = r.finality_status, execution = r.execution_status;
  if (execution === 'REVERTED') return { state: 'reverted', label: 'Trade reverted — network fees may still apply' };
  if (execution === 'SUCCEEDED' && finality === 'ACCEPTED_ON_L1') return { state: 'settled', label: 'Confirmed on Ethereum' };
  if (execution === 'SUCCEEDED' && finality === 'ACCEPTED_ON_L2') return { state: 'confirmed', label: 'Swap confirmed on Starknet' };
  return { state: 'pending', label: finality === 'PRE_CONFIRMED' ? 'Executed — awaiting Starknet confirmation' : 'Submitted — waiting for confirmation' };
}
export function verifySwap(receipt, expected, minimum) {
  const selector = '0xe316f0d9d2a3affa97de1d99bb2aac0538e2666d0d8545545ead241ef0ccab';
  for (const e of receipt.events ?? []) {
    try {
      if (address(e.from_address) !== EXCHANGE || felt(e.keys?.[0]) !== selector || e.data?.length !== 8) continue;
      const d=e.data, received=u256(d[5],d[6]);
      if (address(d[0]) === expected.owner && address(d[1]) === expected.sell.address && u256(d[2],d[3]) === BigInt(expected.amount)
        && address(d[4]) === expected.buy.address && address(d[7]) === expected.owner && received >= BigInt(minimum)) return received.toString();
    } catch { /* An unrelated/malformed event cannot verify this trade. */ }
  }
  return null;
}
