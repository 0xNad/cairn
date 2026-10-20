import { FIELD, normalize, SELECTORS, u256, unsigned } from './felt.mjs';
import { NodeBusy, RpcError } from './errors.mjs';
import { amount, escapeHtml, short } from './format.mjs';

export const METADATA_TTL = 7 * 24 * 60 * 60;
export const MAX_U256 = (1n << 256n) - 1n;

export function decimalAmount(input, decimals) {
  if (typeof input !== 'string' || input.length > 120 || !/^\d+(?:\.\d+)?$/.test(input)) {
    throw new Error('Use a non-negative decimal amount, without exponent notation.');
  }
  const [whole, fraction = ''] = input.split('.');
  if (fraction.length > decimals) throw new Error(`This token supports at most ${decimals} decimal places.`);
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (value > MAX_U256) throw new Error('Amount exceeds the ERC-20 u256 range.');
  return value.toString();
}

function bytes(value, length) {
  const n = unsigned(value, 1n << BigInt(length * 8));
  return Buffer.from(n.toString(16).padStart(length * 2, '0'), 'hex');
}
export function decodeSymbol(words) {
  if (!Array.isArray(words) || !words.length || words.length > 131) throw new Error('Invalid symbol.');
  let data;
  if (words.length === 1) {
    const n = unsigned(words[0], 1n << 248n);
    const hex = n.toString(16);
    data = Buffer.from(hex.padStart(hex.length + hex.length % 2, '0'), 'hex');
  } else {
    const count = Number(unsigned(words[0], 129n));
    if (words.length !== count + 3) throw new Error('Invalid ByteArray.');
    const pending = Number(unsigned(words.at(-1), 31n));
    const chunks = words.slice(1, count + 1).map(word => bytes(word, 31));
    if (pending) chunks.push(bytes(words[count + 1], pending));
    else if (unsigned(words[count + 1], FIELD) !== 0n) throw new Error('Invalid pending word.');
    data = Buffer.concat(chunks);
  }
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(data);
  // Remove controls, bidi overrides and invisible formatting that could impersonate a verified asset.
  const safe = decoded.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
  return [...safe].slice(0, 11).join('') || 'TOKEN';
}

export function contractLink(address, context, caption = short(address)) {
  if (BigInt(address) === 0n) return '<code>0x0</code>';
  return `<a href="${escapeHtml(context.clean(`${context.config.explorer}/contract/${address}`))}">${escapeHtml(context.clean(caption))}</a>`;
}
export function tokenText(token, context) {
  const symbol = escapeHtml(context.clean(token.symbol));
  return token.verified ? symbol :
    `<code>${symbol}</code> · unverified ${contractLink(token.address, context)}`;
}
export function tokenAmount(value, token, context) {
  return `${escapeHtml(amount(value, token.decimals, '').trim())} ${tokenText(token, context)}`;
}

export class Tokens {
  constructor(context) { this.context = context; }
  async get(input) {
    const { config, store, rpc, head, clean } = this.context;
    const known = config.tokens.find(t => t.symbol.toLowerCase() === String(input).toLowerCase());
    const address = known?.address ?? normalize(input);
    const verified = config.tokens.find(t => t.address === address);
    if (verified) return { ...verified, verified: true };
    if (!head) throw new NodeBusy();
    const cache = store.state.metadata[address];
    if (cache && head.timestamp >= cache.at && head.timestamp - cache.at < METADATA_TTL) return cache.token;
    const block_id = { block_number: head.block_number };
    const call = selector => rpc.call('starknet_call', {
      request: { contract_address: address, entry_point_selector: selector, calldata: [] }, block_id,
    });
    let token = null;
    try {
      const result = await call(SELECTORS.decimals);
      if (Array.isArray(result) && result.length === 1) {
        const decimals = Number(unsigned(result[0], 37n));
        let symbol = 'TOKEN';
        try { symbol = decodeSymbol(await call(SELECTORS.symbol)); }
        catch (error) {
          if (error instanceof NodeBusy || this.context.signal.aborted) throw error;
          if (error instanceof RpcError && ![20, 21, 40].includes(error.code)) throw error;
        }
        token = { address, decimals, symbol: [...clean(symbol)].slice(0, 11).join(''), verified: false };
      }
    } catch (error) {
      if (error instanceof NodeBusy || this.context.signal.aborted) throw error;
      if (error instanceof RpcError && ![20, 21, 40].includes(error.code)) throw error;
    }
    store.state.metadata[address] = { at: head.timestamp, token };
    return token;
  }
}

export async function balanceOf(rpc, address, token, blockNumber) {
  const params = { request: { contract_address: token.address, entry_point_selector: SELECTORS.balance_of, calldata: [address] },
    block_id: { block_number: blockNumber } };
  try { return u256(await rpc.call('starknet_call', params)); }
  catch (error) {
    if (!(error instanceof RpcError && error.code === 21)) throw error;
    params.request.entry_point_selector = SELECTORS.balanceOf;
    return u256(await rpc.call('starknet_call', params));
  }
}
