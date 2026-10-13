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
