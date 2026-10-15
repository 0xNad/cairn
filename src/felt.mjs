// Felts, addresses, hashes, u256 and Cairo short strings. Pure functions, no I/O.

/** The Starknet field prime: a transaction hash is a felt below it. */
export const P = 2n ** 251n + 17n * 2n ** 192n + 1n;
/** Contract addresses are below 2^251 - 256. */
export const ADDRESS_BOUND = 2n ** 251n - 256n;

const HEX = /^0x[0-9a-fA-F]+$/;

/** A felt as 0x and 64 lowercase hex digits: the normalised form Cairn shows and links. */
export const hex64 = (v) => `0x${BigInt(v).toString(16).padStart(64, "0")}`;
/** A felt as the RPC writes it: 0x and lowercase hex, no leading zeros. */
export const toFelt = (v) => `0x${BigInt(v).toString(16)}`;

/** A felt from a node's answer (hex string or number). Throws on anything else. */
export function fromFelt(v) {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && HEX.test(v)) return BigInt(v);
  throw new TypeError(`not a felt: ${JSON.stringify(v)?.slice(0, 40)}`);
}

/** A u256 from its two felts: low + high·2^128. */
export const u256 = (low, high) => fromFelt(low) + (fromFelt(high) << 128n);

/**
 * Checks a user-supplied hex value: `0x` and 1 to 64 hex digits, in any case, with `min <= v < bound`.
 * Returns { value } or { problem } in plain words, without echoing the input.
 */
function parseHex(text, bound, tooBig) {
  if (typeof text !== "string" || text === "") return { problem: "missing" };
  if (!/^0x/i.test(text) || !/^0[xX][0-9a-fA-F]*$/.test(text)) return { problem: "it is not 0x followed by hex digits" };
  const digits = text.length - 2;
  if (digits === 0) return { problem: "there are no hex digits after 0x" };
  if (digits > 64) return { problem: `it has ${digits} hex digits, at most 64 are allowed` };
  const value = BigInt(`0x${text.slice(2)}`);
  if (value === 0n) return { problem: "it is zero" };
  if (value >= bound) return { problem: tooBig };
  return { value };
}

/** A contract or account address: 0 < v < 2^251 - 256. */
export const parseAddress = (text) => parseHex(text, ADDRESS_BOUND, "it is above the largest Starknet address (2^251 - 256)");
/** A transaction hash: a felt, 0 < v < P. */
export const parseTxHash = (text) => parseHex(text, P, "it is not below the Starknet field prime");

/** A Cairo short string (ASCII bytes, big-endian) as text, or null when it is not printable ASCII. */
export function decodeShortString(v) {
  let n = fromFelt(v);
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  if (!bytes.length || bytes.some((b) => b < 0x20 || b > 0x7e)) return null;
  return String.fromCharCode(...bytes);
}
