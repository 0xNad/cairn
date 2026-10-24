import { NodeBusy, RpcError } from './errors.mjs';
import { FIELD, normalize, SELECTORS, unsigned } from './felt.mjs';

// Starknet ID names (round 3). A name Cairn accepts is one label of [a-z0-9-] followed by .stark; an address
// is shown by its reverse name only when that name resolves back to the same address.

// encode() and decode() are copied from starknetid.js 5.0.0 (packages/core/dist/utils.js), MIT,
// Copyright (c) 2023 Starknet.id, unchanged except for formatting, as ARCHITECTURE.md settles. Each label is
// one felt, base 38 and little-endian over the alphabet below; a final `a` takes the escape digit 37.
const basicAlphabet = 'abcdefghijklmnopqrstuvwxyz0123456789-';
const basicSizePlusOne = BigInt(basicAlphabet.length + 1); // 38
const bigAlphabet = '这来';
const basicAlphabetSize = BigInt(basicAlphabet.length); // 37
const bigAlphabetSize = BigInt(bigAlphabet.length); // 2
const bigAlphabetSizePlusOne = BigInt(bigAlphabet.length + 1); // 3

function extractStars(str) {
  let k = 0;
  while (str.endsWith(bigAlphabet[bigAlphabet.length - 1])) {
    str = str.substring(0, str.length - 1);
    k += 1;
  }
  return [str, k];
}

/** A label's felt back to its text. */
export function decode(felt) {
  let decoded = '';
  while (felt !== 0n) {
    const code = felt % basicSizePlusOne;
    felt /= basicSizePlusOne;
    if (code === BigInt(basicAlphabet.length)) {
      const nextSubdomain = felt / bigAlphabetSizePlusOne;
      if (nextSubdomain === 0n) {
        const code2 = felt % bigAlphabetSizePlusOne;
        felt = nextSubdomain;
        if (code2 === 0n) decoded += basicAlphabet[0];
        else decoded += bigAlphabet[Number(code2) - 1];
      } else {
        const code2 = felt % bigAlphabetSize;
        decoded += bigAlphabet[Number(code2)];
        felt /= bigAlphabetSize;
      }
    } else decoded += basicAlphabet[Number(code)];
  }
  const [str, k] = extractStars(decoded);
  if (k) {
    decoded = str + (k % 2 === 0
      ? bigAlphabet[bigAlphabet.length - 1].repeat(k / 2 - 1) + bigAlphabet[0] + basicAlphabet[1]
      : bigAlphabet[bigAlphabet.length - 1].repeat((k - 1) / 2 + 1));
  }
  return decoded;
}

/** A label's text as its felt. */
export function encode(decoded) {
  let encoded = 0n;
  let multiplier = 1n;
  if (!decoded) return encoded;
  if (decoded.endsWith(bigAlphabet[0] + basicAlphabet[1])) {
    const [str, k] = extractStars(decoded.substring(0, decoded.length - 2));
    decoded = str + bigAlphabet[bigAlphabet.length - 1].repeat(2 * (k + 1));
  } else {
    const [str, k] = extractStars(decoded);
    if (k) decoded = str + bigAlphabet[bigAlphabet.length - 1].repeat(1 + 2 * (k - 1));
  }
  for (let i = 0; i < decoded.length; i += 1) {
    const char = decoded[i];
    const index = basicAlphabet.indexOf(char);
    const bnIndex = BigInt(basicAlphabet.indexOf(char));
    if (index !== -1) {
      if (i === decoded.length - 1 && decoded[i] === basicAlphabet[0]) {
        encoded += multiplier * basicAlphabetSize;
        multiplier *= basicSizePlusOne;
        multiplier *= basicSizePlusOne;
      } else {
        encoded += multiplier * bnIndex;
        multiplier *= basicSizePlusOne;
      }
    } else if (bigAlphabet.indexOf(char) !== -1) {
      encoded += multiplier * basicAlphabetSize;
      multiplier *= basicSizePlusOne;
      const newid = (i === decoded.length - 1 ? 1 : 0) + bigAlphabet.indexOf(char);
      encoded += multiplier * BigInt(newid);
      multiplier *= bigAlphabetSize;
    }
  }
  return encoded;
}

/** Whether a person's input is meant as a name rather than an address. */
export const looksLikeName = (text) => /\.stark$/i.test(String(text ?? '').trim());

/**
 * A name a person typed: { name, labels } with the labels' felts, or { error } saying why it cannot exist.
 * Only one label of [a-z0-9-] is accepted (subdomains are not, in round 3), and its felt must be below P.
 */
export function parseName(text) {
  const value = String(text ?? '').trim();
  const label = value.slice(0, -'.stark'.length);
  if (label.includes('.')) return { error: `Subdomains such as ${value} are not supported: give one label, like ben.stark, or the 0x address.` };
  if (!/^[a-z0-9-]+$/.test(label) || !value.endsWith('.stark')) {
    const hint = /^[A-Za-z0-9-]+$/.test(label) ? ` Names are lowercase: try ${label.toLowerCase()}.stark.` : '';
    return { error: `Invalid name: a .stark name is lowercase letters, digits and "-", like ben.stark.${hint}` };
  }
  const felt = encode(label);
  if (felt >= FIELD) return { error: 'That name is too long to exist on Starknet: Cairn refuses it like an unknown name.' };
  return { name: `${label}.stark`, labels: [felt] };
}

/** The labels of a name in reading order, as `domain_to_address` takes them: [n, label…, 0] (an empty hint). */
const forwardCalldata = (labels) => [`0x${labels.length.toString(16)}`, ...labels.map((l) => `0x${l.toString(16)}`), '0x0'];
/** The contract's own answers: not deployed, no such entrypoint, or the call failed. */
const NO_ANSWER = new Set([20, 21, 40]);
const NAME_TTL = 24 * 3600; // seconds of chain time a reverse lookup is kept; the forward check runs every pass
const MAX_LOOKUPS = 25; // reverse lookups a pass may start, so a busy wallet's many counterparties never stall it

/**
 * Starknet ID through the naming contract, when the network file names one. `resolve` turns a typed name into
 * an address; `display` gives the verified reverse name of an address, or null: an address's reverse name is
 * shown only when `domain_to_address` on the same labels returns that same address, checked once per pass.
 * Reverse answers are cached in CAIRN_DATA for a day of chain time, "no name" included.
 */
export class Names {
  constructor(config, store, rpc) {
    this.contract = config.contracts?.naming ?? null;
    this.store = store;
    this.rpc = rpc;
    this.pass = new Map(); // address → name or null, for this pass
    this.lookups = 0;
  }
  get enabled() { return this.contract !== null; }
  /** Starts a new pass: forward checks run again. */
  reset() { this.pass.clear(); this.lookups = 0; }
  async #call(selector, calldata) {
    return this.rpc.call('starknet_call', { request: { contract_address: this.contract, entry_point_selector: selector, calldata }, block_id: 'latest' });
  }
  /** The address `labels` resolve to, or null for an unknown name (0x0). Throws RpcError or NodeBusy. */
  async #forward(labels) {
    const result = await this.#call(SELECTORS.domain_to_address, forwardCalldata(labels));
    if (!Array.isArray(result) || result.length !== 1) return null;
    const value = unsigned(result[0], FIELD);
    if (value === 0n) return null;
    try { return normalize(`0x${value.toString(16)}`); } catch { return null; }
  }
  /**
   * The address a typed name resolves to: { address, name }, or { error } for a name that is invalid, unknown or
   * cannot be read. Throws NodeBusy when the node fails, so that a command can say so.
   */
  async resolve(text) {
    if (!this.enabled) return { error: 'Names are off on this instance: its network file has no contracts.naming. Use the 0x address instead.' };
    const parsed = parseName(text);
    if (parsed.error) return parsed;
    let address;
    try { address = await this.#forward(parsed.labels); }
    catch (error) {
      if (error instanceof RpcError && NO_ANSWER.has(error.code)) return { error: `Starknet ID could not resolve ${parsed.name} (naming contract error ${error.code}). Use the 0x address instead.` };
      if (error instanceof RpcError) throw new NodeBusy();
      throw error;
    }
    if (!address) return { error: `${parsed.name} is not registered on Starknet ID (unknown name). Check the spelling, or use the 0x address.` };
    return { address, name: parsed.name };
  }
  /**
   * The verified name of `address` (such as ben.stark), or null when it has none, it does not resolve back, the
   * naming contract is missing or the node cannot say. Never throws: a name is only ever shown when proven.
   */
  async display(address, now) {
    if (!this.enabled) return null;
    if (this.pass.has(address)) return this.pass.get(address);
    let name = null;
    try { name = await this.#verified(address, now); } catch (error) { if (!(error instanceof RpcError || error instanceof NodeBusy)) throw error; }
    this.pass.set(address, name);
    return name;
  }
  async #verified(address, now) {
    const cached = this.store.sql('SELECT labels, checked_at FROM names WHERE address = ?').get(address);
    let labels;
    if (cached && now - cached.checked_at < NAME_TTL) labels = JSON.parse(cached.labels).map(BigInt);
    else {
      if (this.lookups >= MAX_LOOKUPS) return null;
      this.lookups++;
      try { labels = parseReverse(await this.#call(SELECTORS.address_to_domain, [address, '0x0'])); }
      catch (error) {
        // The contract's own refusal is an answer, kept as "no name"; a node failure is tried again next pass.
        if (!(error instanceof RpcError && NO_ANSWER.has(error.code))) throw error;
        labels = [];
      }
      if (labels === null) return null; // not an answer Cairn can read: nothing cached, tried again later
      this.#save(address, labels, now);
    }
    if (!labels.length) return null;
    const back = await this.#forward(labels);
    if (back !== address) {
      // The name moved, or never pointed here: remember "no name" so the next passes stay quiet.
      this.#save(address, [], now);
      return null;
    }
    const text = labels.map(decode);
    return text.every((t) => t.length) ? `${text.join('.')}.stark` : null;
  }
  #save(address, labels, now) {
    this.store.transaction(() => this.store.sql(`INSERT INTO names (address, labels, checked_at) VALUES (?, ?, ?)
      ON CONFLICT (address) DO UPDATE SET labels = excluded.labels, checked_at = excluded.checked_at`)
      .run(address, JSON.stringify(labels.map((l) => `0x${l.toString(16)}`)), now));
  }
  /** Forgets reverse answers older than a day of chain time. */
  prune(now) { this.store.sql('DELETE FROM names WHERE checked_at < ?').run(now - NAME_TTL); }
}

/** `address_to_domain`'s answer [n, label…] as label felts ([] for no name), or null for another shape. */
export function parseReverse(result) {
  try {
    if (!Array.isArray(result) || result.length < 1) return null;
    const n = Number(unsigned(result[0], 1n << 32n));
    if (result.length !== n + 1) return null;
    return result.slice(1).map((l) => unsigned(l, FIELD));
  } catch { return null; }
}

/** An address a person typed, or a name.stark resolved to one: { address, name? } or { error }. */
export async function addressInput(text, names, kind = 'address') {
  const value = String(text ?? '').trim();
  if (looksLikeName(value)) return names ? names.resolve(value) : { error: 'Names are off here: use the 0x address.' };
  try { return { address: normalize(value, kind) }; } catch (error) { return { error: error.message }; }
}
