// Starknet ID codec: starknetid.js 5.0.0, MIT, Copyright (c) 2023 Starknet.id.
import { FIELD, normalize, SELECTORS, unsigned } from './felt.mjs';

const basicAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789-";
const basicSizePlusOne = BigInt(basicAlphabet.length + 1); // 38
const bigAlphabet = "这来";
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

export function decodeLabel(felt) {
  let decoded = "";
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
  if (k)
    decoded = str + (k % 2 === 0
      ? bigAlphabet[bigAlphabet.length - 1].repeat(k / 2 - 1) + bigAlphabet[0] + basicAlphabet[1]
      : bigAlphabet[bigAlphabet.length - 1].repeat((k - 1) / 2 + 1));
  return decoded;
}

export function encodeLabel(decoded) {
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

export class Names {
  constructor(config, rpc) { this.address = config.contracts?.naming; this.rpc = rpc; this.reset(); }
  reset() { this.cache = new Map(); }
  async call(selector, calldata, block = 'latest') {
    return this.rpc.call('starknet_call', { request: { contract_address: this.address, entry_point_selector: selector, calldata }, block_id: block });
  }
  async resolve(value) {
    if (!value.endsWith('.stark')) return normalize(value);
    if (!/^[a-z0-9-]+\.stark$/.test(value) || value.length > 60) throw new Error('Invalid name: use one lowercase label followed by .stark.');
    const felt = encodeLabel(value.slice(0, -6));
    if (felt >= FIELD) throw new Error('Invalid name: too long to fit in a Starknet felt.');
    if (!this.address) throw new Error('Names unavailable: the naming contract is not configured.');
    let answer;
    try { answer = await this.call(SELECTORS.domain_to_address, ['0x1', `0x${felt.toString(16)}`, '0x0']); }
    catch { throw new Error('Name lookup unavailable. Please try again.'); }
    try { if (answer.length !== 1) throw new Error(); return normalize(answer[0]); }
    catch { throw new Error('Unknown name: Starknet ID has no valid address for it.'); }
  }
  async reverse(address, block = 'latest') {
    if (!this.address) return null;
    const key = `${address}:${JSON.stringify(block)}`;
    if (!this.cache.has(key)) this.cache.set(key, (async () => {
      try {
        const r = await this.call(SELECTORS.address_to_domain, [address, '0x0'], block);
        if (!Array.isArray(r) || !r.length) return null;
        const count = Number(unsigned(r[0], 17n));
        if (!count || r.length !== count + 1) return null;
        const values = r.slice(1).map(v => unsigned(v, FIELD));
        const labels = values.map(decodeLabel);
        if (labels.some((s, i) => !s || encodeLabel(s) !== values[i])) return null;
        const forward = await this.call(SELECTORS.domain_to_address, [r[0], ...r.slice(1), '0x0'], block);
        if (!Array.isArray(forward) || forward.length !== 1 || normalize(forward[0]) !== address) return null;
        const name = `${labels.join('.')}.stark`;
        return name.length <= 128 ? name : null;
      } catch { return null; }
    })());
    return this.cache.get(key);
  }
}
