// Tokens. The registry (the network file) lists the verified ones. Any other contract is read the first time one
// of its events matters: `decimals` (0 to 36, or it is not a coin and its events are ignored) and `symbol` (a
// short string or a ByteArray). Both answers are cached in the state for 7 days of chain time.
import { NodeBusy, RpcError } from './errors.mjs';
import { cairoString, NodeValueError, normalize, SELECTORS, u256, unsigned } from './felt.mjs';
import { amount, escapeHtml, short } from './format.mjs';

const WEEK = 7 * 24 * 3600;
const SYMBOL = '0x0216b05c387bab9ac31918a3e61672f4618601f3c598a2f3f2710f37053e1ea4';
const DECIMALS = '0x004c4fb1ab068f6039d5780c68dd0fa2f8742cceb3426d19667778ca7f3518a9';
const SYMBOL_CHARS = 11; // an unverified symbol is shown cut to this many characters
// The answers that say a contract has no such entrypoint: no contract, no entrypoint, a failing call, or a
// value of the wrong shape. Any other error (a busy or broken node) is thrown, and nothing is cached.
const noAnswer = (error) => (error instanceof RpcError && [20, 21, 40].includes(error.code)) || error instanceof NodeValueError;

export class Tokens {
  /** `cache` is the state's token map, measured in chain time. */
  constructor(config, rpc, cache) {
    this.rpc = rpc;
    this.cache = cache;
    this.registry = new Map(config.tokens.map((t) => [t.address, { ...t, verified: true }]));
  }

  /** The registry token at this address, or undefined. */
  verified(address) { return this.registry.get(address); }

  /** The registry token with this symbol, ignoring case, or null. */
  bySymbol(symbol) {
    const wanted = String(symbol).toLowerCase();
    return [...this.registry.values()].find((t) => t.symbol.toLowerCase() === wanted) ?? null;
  }

  /** A token a user named, by registry symbol or contract address: { token } or { error }. `now` is null when the node is busy. */
  async resolve(input, now) {
    const known = this.bySymbol(input);
    if (known) return { token: known };
    let address;
    try { address = normalize(input, 'address'); }
    catch {
      const shown = [...input].length > 24 ? `${[...input].slice(0, 24).join('')}…` : input;
      return { error: `Unknown token "${shown}": use a symbol of the registry (${[...this.registry.values()].map((t) => t.symbol).join(', ')}) or a token contract address.` };
    }
    if (now === null) throw new NodeBusy();
    const token = await this.get(address, now);
    return token ? { token } : { error: `${short(address)} is not a token: it answers no decimals from 0 to 36.` };
  }

  /** The token at `address` (0x and 64 digits): { address, symbol, decimals, verified, lookalike }, or null if it is no coin. */
  async get(address, now) {
    const known = this.registry.get(address);
    if (known) return known;
    let cached = this.cache[address];
    if (!cached || now - cached.at >= WEEK) cached = this.cache[address] = await this.#read(address, now);
    if (cached.coin === false) return null;
    // A symbol that copies a verified one names it, so that it is flagged wherever it is shown.
    return { address, symbol: cached.symbol, decimals: cached.decimals, verified: false, lookalike: this.bySymbol(cached.symbol)?.symbol ?? null };
  }

  async #read(address, now) {
    const call = (selector) => this.rpc.call('starknet_call', { request: { contract_address: address, entry_point_selector: selector, calldata: [] }, block_id: 'latest' });
    let decimals = NaN;
    try {
      const answer = await call(DECIMALS);
      if (Array.isArray(answer) && answer.length === 1) decimals = Number(unsigned(answer[0]));
    } catch (error) { if (!noAnswer(error)) throw error; }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return { coin: false, at: now };
    let symbol = null;
    try { symbol = cairoString(await call(SYMBOL)); } catch (error) { if (!noAnswer(error)) throw error; }
    // Invisible and control characters are dropped; a coin without a readable symbol shows "?".
    symbol = (symbol ?? '').replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim() || '?';
    return { symbol, decimals, at: now };
  }

  /** Drops the metadata older than 7 days of chain time. */
  prune(now) {
    for (const [address, entry] of Object.entries(this.cache)) if (now - entry.at >= WEEK) delete this.cache[address];
  }

  /** The balance of `owner` in `token`: balance_of, or balanceOf when the contract has no balance_of (error 21). */
  async balance(token, owner, block_id) {
    const params = { request: { contract_address: token.address, entry_point_selector: SELECTORS.balance_of, calldata: [owner] }, block_id };
    try { return u256(await this.rpc.call('starknet_call', params)); }
    catch (error) {
      if (!(error instanceof RpcError && error.code === 21)) throw error;
      params.request.entry_point_selector = SELECTORS.balanceOf;
      return u256(await this.rpc.call('starknet_call', params));
    }
  }
}

/**
 * A token's name in a message: a verified symbol in bold; any other in <code> (escaped, cut, never a link), then
 * "(unverified token <its contract, linked>)". A copy of a verified symbol also says it is not that token.
 */
export function tokenName(token, link) {
  if (token.verified) return `<b>${escapeHtml(token.symbol)}</b>`;
  const symbol = [...token.symbol].slice(0, SYMBOL_CHARS).join('');
  const warning = token.lookalike ? `, not the verified ${escapeHtml(token.lookalike)}` : '';
  return `<code>${escapeHtml(symbol)}</code> (unverified token ${link('contract', token.address)}${warning})`;
}

/** An exact amount of a token, as HTML: "1,234.5 <b>STRK</b>". */
export const tokenAmount = (raw, token, link) => `${amount(raw, token.decimals, '').trim()} ${tokenName(token, link)}`;
