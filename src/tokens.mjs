import { NodeBusy, RpcError } from './errors.mjs';
import { cairoString, normalize, SELECTORS, STRK_ADDRESS, u256, unsigned } from './felt.mjs';
import { plainText } from './format.mjs';

export const METADATA_TTL = 7 * 24 * 3600; // seconds of chain time
const SYMBOL_MAX = 11;
/** The node errors that are the contract's own answer: not deployed, no such entrypoint, or the call failed. */
const NO_ANSWER = new Set([20, 21, 40]);

/**
 * What Cairn knows about tokens. The registry lists the verified ones; any other contract is read from the
 * chain the first time one of its events matters (`symbol`, `decimals`) and cached in CAIRN_DATA for seven
 * days of chain time, "not a coin" included. A token is { address, symbol, decimals, verified }.
 */
export class Tokens {
  constructor(config, store, rpc) {
    this.store = store;
    this.rpc = rpc;
    this.registry = new Map(config.tokens.map((t) => [t.address, { ...t, verified: true }]));
    this.strk = config.tokens.find((t) => t.symbol.toUpperCase() === 'STRK')?.address ?? STRK_ADDRESS;
  }
  bySymbol(symbol) {
    const wanted = String(symbol).toLowerCase();
    for (const token of this.registry.values()) if (token.symbol.toLowerCase() === wanted) return token;
    return null;
  }
  /** The token at `address`, or null when its contract is not a coin. Throws NodeBusy when the node fails. */
  async get(address, now) {
    const known = this.registry.get(address);
    if (known) return known;
    const cached = this.store.sql('SELECT symbol, decimals, checked_at FROM tokens WHERE address = ?').get(address);
    if (cached && now - cached.checked_at < METADATA_TTL) {
      return cached.decimals === null ? null : { address, symbol: cached.symbol, decimals: cached.decimals, verified: false };
    }
    const decimals = await this.#decimals(address);
    const symbol = decimals === null ? null : await this.#symbol(address);
    this.store.transaction(() => this.store.sql(`INSERT INTO tokens (address, symbol, decimals, checked_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (address) DO UPDATE SET symbol = excluded.symbol, decimals = excluded.decimals, checked_at = excluded.checked_at`)
      .run(address, symbol, decimals, now));
    return decimals === null ? null : { address, symbol, decimals, verified: false };
  }
  /** What the cache knows of a token outside the registry, without a chain call. */
  cached(address) {
    const row = this.store.sql('SELECT symbol, decimals FROM tokens WHERE address = ?').get(address);
    return row && row.decimals !== null ? { address, symbol: row.symbol, decimals: row.decimals, verified: false } : null;
  }
  /** Forgets cache entries older than the TTL. */
  prune(now) { this.store.sql('DELETE FROM tokens WHERE checked_at < ?').run(now - METADATA_TTL); }
  /**
   * A token a person named: a registry symbol or any token address. Returns { token } or { error }.
   * Throws NodeBusy when the node fails.
   */
  async resolve(argument, now) {
    let value = String(argument ?? '').trim();
    if (value.endsWith('.stark') && this.names) {
      try { value = await this.names.resolve(value); } catch (e) { return { error: e.message }; }
    }
    if (!value) return { error: 'Name a token: a registry symbol such as STRK, or a token contract address.' };
    if (/^0x/i.test(value)) {
      let address;
      try { address = normalize(value); } catch (error) { return { error: error.message.replace('address', 'token address') }; }
      const token = await this.get(address, now);
      return token ? { token } : { error: 'That contract is not an ERC-20 token: it does not answer decimals from 0 to 36.' };
    }
    const token = this.bySymbol(value);
    if (token) return { token };
    const list = [...this.registry.values()].map((t) => t.symbol).join(', ');
    return { error: `Unknown symbol. Verified tokens: ${list}. For any other token, give its contract address.` };
  }
  async #call(address, selector) {
    try {
      return await this.rpc.call('starknet_call', { request: { contract_address: address, entry_point_selector: selector, calldata: [] }, block_id: 'latest' });
    } catch (error) {
      if (error instanceof RpcError && NO_ANSWER.has(error.code)) return null;
      // Any other error (an internal error, a provider limit) says nothing about the token: it is not cached
      // as "not a coin" for a week, and the caller tries again.
      if (error instanceof RpcError) throw new NodeBusy();
      throw error;
    }
  }
  async #decimals(address) {
    const result = await this.#call(address, SELECTORS.decimals);
    try {
      if (!Array.isArray(result) || result.length !== 1) return null;
      const d = unsigned(result[0]);
      return d <= 36n ? Number(d) : null;
    } catch { return null; }
  }
  async #symbol(address) {
    const text = cairoString(await this.#call(address, SELECTORS.symbol));
    return plainText(text ?? '', SYMBOL_MAX) || '?';
  }
}

/** `balance_of(owner)`, or `balanceOf` when the entrypoint does not exist (error 21), at `block_id`. */
export async function balanceOf(rpc, token, owner, block_id) {
  const params = { request: { contract_address: token, entry_point_selector: SELECTORS.balance_of, calldata: [owner] }, block_id };
  try { return u256(await rpc.call('starknet_call', params)); }
  catch (error) {
    if (!(error instanceof RpcError && error.code === 21)) throw error;
    params.request.entry_point_selector = SELECTORS.balanceOf;
    return u256(await rpc.call('starknet_call', params));
  }
}
