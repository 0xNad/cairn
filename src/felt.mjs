export const FIELD = (1n << 251n) + 17n * (1n << 192n) + 1n;
const ADDRESS_BOUND = (1n << 251n) - 256n;
export function normalize(value, kind = 'address') {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(value)) {
    throw new Error(`Invalid ${kind}: use 0x followed by 1 to 64 hexadecimal digits.`);
  }
  const number = BigInt(value);
  if (number === 0n || number >= (kind === 'address' ? ADDRESS_BOUND : FIELD)) {
    throw new Error(`Invalid ${kind}: must be nonzero and below the Starknet ${kind === 'address' ? 'address bound' : 'field prime'}.`);
  }
  return `0x${number.toString(16).padStart(64, '0')}`;
}
export class NodeValueError extends Error {
  constructor() { super('Invalid numeric response from node'); }
}
export function unsigned(value, bound) {
  if (typeof value !== 'string' || !/^(0x[0-9a-f]+|[0-9]+)$/i.test(value)) throw new NodeValueError();
  const n = BigInt(value);
  if (bound !== undefined && n >= bound) throw new NodeValueError();
  return n;
}
export function u256(words) {
  if (!Array.isArray(words) || words.length !== 2) throw new NodeValueError();
  return unsigned(words[0], 1n << 128n) + (unsigned(words[1], 1n << 128n) << 128n);
}
export function decodeChain(value) {
  const hex = unsigned(value, FIELD).toString(16);
  const text = Buffer.from(hex.padStart(hex.length + hex.length % 2, '0'), 'hex').toString('utf8');
  return /^[A-Z0-9_]{1,32}$/.test(text) ? text : 'unknown chain';
}
export const SELECTORS = Object.freeze({
  balance_of: '0x035a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33',
  balanceOf: '0x02e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e',
});
const U256 = 1n << 256n;
// An exact decimal amount of a token with `decimals` places, as its raw integer: "2.000001" with 6 decimals is
// 2000001n. Refuses signs, exponents, more places than the token has, and anything that does not fit a u256.
export function parseAmount(text, decimals) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text ?? '');
  if (!match) throw new Error('Invalid amount: use a plain decimal number such as 2.5 (no sign, no exponent).');
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) throw new Error(`Invalid amount: this token has ${decimals} decimal places.`);
  const raw = BigInt(match[1] + fraction.padEnd(decimals, '0'));
  if (raw === 0n) throw new Error('Invalid amount: it must be above zero.');
  if (raw >= U256) throw new Error('Invalid amount: too large for a token amount.');
  return raw;
}
// The exact decimal of a raw amount, without grouping: what /export shows.
export function plainAmount(raw, decimals) {
  const scale = 10n ** BigInt(decimals);
  const fraction = decimals ? (raw % scale).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${raw / scale}${fraction ? `.${fraction}` : ''}`;
}
// A Cairo string returned by a call: one felt for a short string, or a ByteArray
// [n_full_words, words…, pending_word, pending_len] of 31-byte words. Null when it is neither.
export function cairoString(felts) {
  try {
    const words = felts.map((f) => unsigned(f, FIELD));
    const bytes = (value, length) => Buffer.from(value.toString(16).padStart(length * 2, '0').slice(-length * 2), 'hex');
    if (words.length === 1) return bytes(words[0], Math.ceil(words[0].toString(16).length / 2)).toString('utf8');
    const full = Number(words[0]);
    if (!Number.isSafeInteger(full) || words.length !== full + 3 || words[full + 2] > 30n) return null;
    const parts = words.slice(1, full + 1).map((w) => bytes(w, 31));
    parts.push(bytes(words[full + 1], Number(words[full + 2])));
    return Buffer.concat(parts).toString('utf8');
  } catch { return null; }
}
// Any felt (zero included) as 0x and 64 lowercase digits: event fields, keys of the state.
export const felt64 = (value) => `0x${unsigned(value, FIELD).toString(16).padStart(64, '0')}`;
