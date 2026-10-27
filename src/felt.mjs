export const FIELD = (1n << 251n) + 17n * (1n << 192n) + 1n;
const ADDRESS_BOUND = (1n << 251n) - 256n;
export const U128 = 1n << 128n;
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
/** A felt from the node as 0x and 64 lowercase digits, for comparing; zero is allowed (mints and burns). */
export function hex64(value) {
  return `0x${unsigned(value, FIELD).toString(16).padStart(64, '0')}`;
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
  return unsigned(words[0], U128) + (unsigned(words[1], U128) << 128n);
}
/** A Cairo i129 (Ekubo's signed amount): a u128 magnitude felt and a sign felt, 1 meaning negative. */
export function i129(magnitude, sign) {
  const value = unsigned(magnitude, U128), negative = unsigned(sign, 2n);
  return negative === 1n ? -value : value;
}
/** A Cairo short string (at most 31 ASCII characters) as a felt, such as a Pragma pair: STRK/USD is 0x5354524b2f555344. */
export function shortString(text) {
  return `0x${Buffer.from(text, 'latin1').toString('hex') || '0'}`;
}
export function decodeChain(value) {
  const hex = unsigned(value, FIELD).toString(16);
  const text = Buffer.from(hex.padStart(hex.length + hex.length % 2, '0'), 'hex').toString('utf8');
  return /^[A-Z0-9_]{1,32}$/.test(text) ? text : 'unknown chain';
}
// Big-endian bytes of a bounded felt: its own length, or exactly `length` bytes.
const bytesOf = (value, length) => {
  const hex = value.toString(16);
  return Buffer.from(hex.padStart(length === undefined ? hex.length + hex.length % 2 : 2 * length, '0'), 'hex');
};
/**
 * A Cairo string answer as text: one felt is a short string, otherwise a ByteArray
 * [n_full_words, words…, pending_word, pending_len]. Returns null for any other shape.
 */
export function cairoString(felts) {
  try {
    if (!Array.isArray(felts)) return null;
    if (felts.length === 1) {
      const value = unsigned(felts[0], FIELD);
      return value === 0n ? '' : bytesOf(value).toString('utf8');
    }
    if (felts.length < 3) return null;
    const words = Number(unsigned(felts[0], 1n << 32n));
    if (felts.length !== words + 3) return null;
    const length = Number(unsigned(felts[words + 2], 31n));
    const parts = felts.slice(1, words + 1).map((w) => bytesOf(unsigned(w, 1n << 248n), 31));
    const pending = unsigned(felts[words + 1], 1n << 248n);
    if (pending >> BigInt(8 * length) !== 0n) return null;
    if (length) parts.push(bytesOf(pending, length));
    return Buffer.concat(parts).toString('utf8');
  } catch { return null; }
}
export const SELECTORS = Object.freeze({
  Transfer: '0x0099cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9',
  Approval: '0x0134692b230b9e1ffa39098904722134159652b09c5bc41d88d6698779d228ff',
  balance_of: '0x035a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33',
  balanceOf: '0x02e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e',
  decimals: '0x004c4fb1ab068f6039d5780c68dd0fa2f8742cceb3426d19667778ca7f3518a9',
  symbol: '0x0216b05c387bab9ac31918a3e61672f4618601f3c598a2f3f2710f37053e1ea4',
  Swapped: '0x0157717768aca88da4ac4279765f09f4d0151823d573537fbbeb950cdbd9a870',
  Swap: '0x00e316f0d9d2a3affa97de1d99bb2aac0538e2666d0d8545545ead241ef0ccab',
  get_data_median: '0x0024b869ce68dd257b370701ca16e4aaf9c6483ff6805d04ba7661f3a0b6ce59',
  domain_to_address: '0x02e269d930f6d7ab92b15ce8ff9f5e63709391617e3465fff79ba6baf278ce60',
  address_to_domain: '0x038b679fb029cc3f953635ed16ae4123da8214e726943920ba7706a0473e326a',
});
/** STRK pays every fee; the registry's STRK wins when it lists one. */
export const STRK_ADDRESS = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
