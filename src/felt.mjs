// Felts, addresses, hashes and u256 values: pure functions, no I/O. ARCHITECTURE.md, "Input validation".

/** The Starknet field prime: a felt is below it. */
export const P = 2n ** 251n + 17n * 2n ** 192n + 1n;
/** An address is below this. */
export const ADDRESS_LIMIT = 2n ** 251n - 256n;

const HEX = /^0[xX]([0-9a-fA-F]+)$/;

/** `0x` and exactly 64 lowercase hex digits. */
export const hex64 = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
/** The shortest form a node takes (no leading zeros): what is sent over JSON-RPC. */
export const toFelt = (value) => `0x${BigInt(value).toString(16)}`;
/** `0x0471…938d`: `0x`, the first and the last 4 of the 64 digits. */
export const shortHex = (h64) => `${h64.slice(0, 6)}…${h64.slice(-4)}`;

/**
 * Reads `text` as a 0x-prefixed value of 1 to 64 hex digits, strictly between 0 and `limit`.
 * @returns {{ ok: true, value: string, int: bigint } | { ok: false, reason: string }} `value` is normalised;
 *   `reason` is plain words that name `what`.
 */
function parseHexValue(text, limit, what, limitText) {
  const a = /^[aeiou]/.test(what) ? "an" : "a";
  if (typeof text !== "string" || text === "") return { ok: false, reason: `no ${what} was given` };
  const m = HEX.exec(text);
  if (!m) return { ok: false, reason: `${a} ${what} is 0x followed by 1 to 64 hexadecimal digits` };
  if (m[1].length > 64) return { ok: false, reason: `${a} ${what} has at most 64 hexadecimal digits` };
  const int = BigInt(`0x${m[1]}`);
  if (int === 0n) return { ok: false, reason: `zero is not a valid ${what}` };
  if (int >= limit) return { ok: false, reason: `that value is too large for ${a} ${what} (it must be below ${limitText})` };
  return { ok: true, value: hex64(int), int };
}

/** An address: 0 < v < 2^251 - 256. */
export const parseAddress = (text) => parseHexValue(text, ADDRESS_LIMIT, "address", "2^251 - 256");
/** A transaction hash: a felt, 0 < v < P. */
export const parseHash = (text) => parseHexValue(text, P, "transaction hash", "the Starknet field prime");

const TWO_128 = 2n ** 128n;

/** A felt from a node's answer (a hex string): throws a TypeError when it is not one. */
export function feltOf(text) {
  if (typeof text !== "string" || !HEX.test(text)) throw new TypeError("not a felt");
  const v = BigInt(text);
  if (v >= P) throw new TypeError("not a felt");
  return v;
}

/** u256 = low + high * 2^128, from the two felts a node answers. Throws a TypeError when they are not that. */
export function u256Of(felts) {
  if (!Array.isArray(felts) || felts.length < 2) throw new TypeError("not a u256");
  const low = feltOf(felts[0]);
  const high = feltOf(felts[1]);
  if (low >= TWO_128 || high >= TWO_128) throw new TypeError("not a u256");
  return low + high * TWO_128;
}

/** A felt that holds a short string (such as a chain id) as text, or null when it is not printable ASCII. */
export function shortString(hex) {
  let digits = String(hex).replace(/^0[xX]/, "");
  if (!/^[0-9a-fA-F]+$/.test(digits)) return null;
  if (digits.length % 2) digits = `0${digits}`;
  const bytes = Buffer.from(digits, "hex");
  if (bytes.length === 0 || !bytes.every((b) => b >= 0x20 && b < 0x7f)) return null;
  return bytes.toString("latin1");
}

/** The numbers of a JSON-RPC spec version ("0.10.3", "0.10.0-rc.1"), or null. */
export function parseSpec(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether version `a` is at least version `b` (both [major, minor, patch]). */
export function atLeast(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}
