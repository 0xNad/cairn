// Felts, addresses and hashes (ARCHITECTURE.md, "Input validation" and "Call layouts"). Every value is a
// BigInt inside Cairn; strings exist only at the edges: what a user typed, what the node answered.

/** The Starknet field prime: a hash is a felt below it. */
export const P = 2n ** 251n + 17n * 2n ** 192n + 1n;
/** Addresses are below 2^251 − 256. */
export const ADDRESS_BOUND = 2n ** 251n - 256n;
const MASK128 = 2n ** 128n - 1n;

/** 0x and 64 lowercase hex digits: how Cairn shows and links an address or a hash. */
export const hex64 = (v) => `0x${v.toString(16).padStart(64, "0")}`;
/** 0x and lowercase hex without leading zeros: how Cairn sends a felt to the node. */
export const felt = (v) => `0x${BigInt(v).toString(16)}`;

/**
 * Reads a felt the node sent ("0x…" hex, or a decimal string or number some nodes use). Throws on anything
 * else, so that a malformed answer is never shown as a number.
 */
export function toBig(v) {
  if (typeof v === "bigint" && v >= 0n) return v;
  if (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v)) return BigInt(v);
  if (typeof v === "string" && /^\d{1,78}$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new TypeError(`not a felt: ${String(typeof v === "string" ? JSON.stringify(v) : typeof v).slice(0, 40)}`);
}

/** A u256 from its two felts: low + high·2^128. */
export const u256 = (low, high) => (toBig(low) & MASK128) + (toBig(high) << 128n);

/**
 * Reads hex the way users type it: 0x (or 0X) and 1 to 64 hex digits in any case. Returns { value } or
 * { error } with the reason in plain words; `what` names the thing ("an address", "a transaction hash").
 */
function readHex(text, what) {
  if (typeof text !== "string" || text === "") return { error: `is missing: ${what} is 0x followed by 1 to 64 hex digits` };
  const m = /^0[xX]([0-9a-fA-F]*)$/.exec(text);
  if (!m || m[1] === "") return { error: `is not ${what}: ${what} is 0x followed by 1 to 64 hex digits` };
  if (m[1].length > 64) return { error: `has ${m[1].length} hex digits: ${what} has at most 64` };
  return { value: BigInt(`0x${m[1]}`) };
}

/** An address: 0 < v < 2^251 − 256. Returns { value, hex } or { error }. */
export function parseAddress(text) {
  const r = readHex(text, "an address");
  if (r.error) return r;
  if (r.value === 0n) return { error: "is zero, which is not an address" };
  if (r.value >= ADDRESS_BOUND) return { error: "is out of range: an address is below 2^251 − 256" };
  return { value: r.value, hex: hex64(r.value) };
}

/** A transaction hash: a felt, 0 < v < P. Returns { value, hex } or { error }. */
export function parseHash(text) {
  const r = readHex(text, "a transaction hash");
  if (r.error) return r;
  if (r.value === 0n) return { error: "is zero, which is not a transaction hash" };
  if (r.value >= P) return { error: "is out of range: a transaction hash is a felt, below P = 2^251 + 17·2^192 + 1" };
  return { value: r.value, hex: hex64(r.value) };
}

/** A Cairo short string (ASCII bytes read as one big-endian number), or null if it is not printable ASCII. */
export function shortString(v) {
  let hex = toBig(v).toString(16);
  if (hex === "0") return "";
  if (hex.length % 2) hex = `0${hex}`;
  const s = Buffer.from(hex, "hex").toString("latin1");
  return /^[\x20-\x7e]+$/.test(s) ? s : null;
}
