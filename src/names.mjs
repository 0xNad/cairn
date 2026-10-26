// Starknet ID names: `.stark` labels encoded as ARCHITECTURE.md freezes them (starknetid.js 5.0.0's encode and
// decode, MIT, Copyright (c) 2023 Starknet.id), the forward lookup, and reverse names that are shown only when
// they resolve back to the same address.
import { FIELD, hex64, unsigned } from './felt.mjs';

export const NAME_SELECTORS = Object.freeze({
  domain_to_address: '0x02e269d930f6d7ab92b15ce8ff9f5e63709391617e3465fff79ba6baf278ce60',
  address_to_domain: '0x038b679fb029cc3f953635ed16ae4123da8214e726943920ba7706a0473e326a',
});

const basicAlphabet = 'abcdefghijklmnopqrstuvwxyz0123456789-';
const basicSizePlusOne = BigInt(basicAlphabet.length + 1); // 38
const bigAlphabet = '这来';
const basicAlphabetSize = BigInt(basicAlphabet.length); // 37
const bigAlphabetSize = BigInt(bigAlphabet.length); // 2
const bigAlphabetSizePlusOne = BigInt(bigAlphabet.length + 1); // 3
const MAX_LABELS = 10; // a reverse answer with more labels than this is not a name Cairn shows

function extractStars(str) {
  let k = 0;
  while (str.endsWith(bigAlphabet[bigAlphabet.length - 1])) {
    str = str.substring(0, str.length - 1);
    k += 1;
  }
  return [str, k];
}

/** One label's text from its felt. */
export function decodeLabel(felt) {
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

/** One label's felt: base 38, little-endian, a trailing `a` written as 37. */
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
    if (index !== -1) {
      if (i === decoded.length - 1 && decoded[i] === basicAlphabet[0]) {
        encoded += multiplier * basicAlphabetSize;
        multiplier *= basicSizePlusOne;
        multiplier *= basicSizePlusOne;
      } else {
        encoded += multiplier * BigInt(index);
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

/** True when the text looks like a name rather than an address or a label. */
export const looksLikeName = (text) => /\.stark$/i.test(String(text ?? '').trim());

/**
 * A name a person typed: exactly one `[a-z0-9-]` label and `.stark`. Returns { name, label, encoded } or
 * { error }; subdomains are not supported, and a label whose felt is not below P cannot exist on chain.
 */
export function parseStarkName(text) {
  const value = String(text ?? '').trim();
  const match = /^(.*)\.stark$/.exec(value);
  if (!match || !match[1]) return { error: 'Invalid name: use one label and .stark, such as ben.stark.' };
  const label = match[1];
  if (label.includes('.')) return { error: 'Subdomains are not supported: use one label and .stark, such as ben.stark.' };
  if (!/^[a-z0-9-]+$/.test(label)) return { error: 'Invalid name: a label uses only lowercase letters, digits and hyphens.' };
  const encoded = encodeLabel(label);
  if (encoded >= FIELD) return { error: 'Name too long: its label does not fit in one felt.' };
  return { name: `${label}.stark`, label, encoded };
}

const hex = (n) => `0x${n.toString(16)}`;

/** `domain_to_address(labels, [])`: the address a name points to, or null when it points nowhere. Errors propagate. */
export async function resolveName(rpc, naming, labels) {
  const answer = await rpc.call('starknet_call', { request: {
    contract_address: naming, entry_point_selector: NAME_SELECTORS.domain_to_address,
    calldata: [hex(BigInt(labels.length)), ...labels.map(hex), '0x0'],
  }, block_id: 'latest' });
  if (!Array.isArray(answer) || answer.length !== 1) return null;
  const address = unsigned(answer[0], FIELD);
  return address === 0n ? null : hex64(answer[0]);
}

/**
 * The address's reverse name, such as `b.ben.stark`, only when every label in reading order resolves back to
 * exactly this address. Any failure, an empty answer or a mismatch gives null: the caller shows the address.
 */
export async function reverseName(rpc, naming, address) {
  try {
    const answer = await rpc.call('starknet_call', { request: {
      contract_address: naming, entry_point_selector: NAME_SELECTORS.address_to_domain, calldata: [address, '0x0'],
    }, block_id: 'latest' });
    if (!Array.isArray(answer) || answer.length < 2) return null;
    const n = unsigned(answer[0], FIELD);
    if (n === 0n || n > BigInt(MAX_LABELS) || answer.length !== Number(n) + 1) return null;
    const labels = answer.slice(1).map((w) => unsigned(w, FIELD));
    if (labels.some((l) => l === 0n)) return null;
    const name = `${labels.map(decodeLabel).join('.')}.stark`;
    const back = await resolveName(rpc, naming, labels);
    return back !== null && back === hex64(address) ? name : null;
  } catch { return null; }
}

/** Reverse names for one scan pass, each address looked up once; null when there is no naming contract. */
export function reverseNames(rpc, config) {
  if (!config.contracts.naming) return null;
  const cache = new Map();
  return {
    async reverse(address) {
      if (!cache.has(address)) cache.set(address, await reverseName(rpc, config.contracts.naming, address));
      return cache.get(address);
    },
  };
}
