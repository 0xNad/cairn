// Felts: parsing user input, normalising, u256 and short strings. Every value is a BigInt; it is
// written as 0x and 64 lowercase digits for people and links, and without leading zeros for the node.

// Addresses are below 2^251 - 256; hashes are felts, below P = 2^251 + 17·2^192 + 1.
export const ADDRESS_BOUND = 2n ** 251n - 256n;
export const P = 2n ** 251n + 17n * 2n ** 192n + 1n;

// "0x" and 64 lowercase hex digits: how Cairn shows and links an address or a hash.
export const hex64 = (v) => `0x${BigInt(v).toString(16).padStart(64, "0")}`;
// "0x" and no leading zeros: how Cairn sends a felt to the node (the RPC spec's FELT pattern).
export const felt = (v) => `0x${BigInt(v).toString(16)}`;
// "0x0471…938d": 0x, the first 4 and the last 4 of the 64 digits.
export const shortHex = (v) => {
  const h = hex64(v);
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
};

// A felt from the node (hex or decimal string, or number), or null if it is not one.
export function toBig(v) {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
    if (typeof v === "string" && /^(0x[0-9a-f]+|\d+)$/i.test(v.trim())) return BigInt(v.trim());
  } catch {}
  return null;
}

// u256 = low + high·2^128.
export const u256 = (low, high) => BigInt(low) + (BigInt(high) << 128n);

// A short string felt as ASCII ("0x534e5f4d41494e" is "SN_MAIN"), or null if it is not printable ASCII.
export function shortString(v) {
  let n = toBig(v);
  if (n === null || n < 0n) return null;
  let s = "";
  while (n > 0n) {
    const c = Number(n & 0xffn);
    if (c < 0x20 || c > 0x7e) return null;
    s = String.fromCharCode(c) + s;
    n >>= 8n;
  }
  return s;
}

// Parses what a user typed as a felt: 0x and 1 to 64 hex digits in any case, 0 < v < `bound`.
// Returns { value } or { error }, the error a sentence fragment naming `a` (the noun with its article).
function parseFelt(input, a, noun, bound, tooLarge) {
  const s = String(input ?? "").trim();
  if (s === "") return { error: `no ${noun} given` };
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.stark$/i.test(s)) return { error: `names like ${s.length > 40 ? "this one" : s} are not supported yet, send the 0x ${noun}` };
  if (!/^0x/i.test(s)) return { error: `${a} starts with 0x` };
  const digits = s.slice(2);
  if (digits === "" || !/^[0-9a-f]+$/i.test(digits)) return { error: `${a} is 0x followed by hex digits (0-9, a-f)` };
  if (digits.length > 64) return { error: `${a} has at most 64 hex digits, this one has ${digits.length}` };
  const value = BigInt(`0x${digits}`);
  if (value === 0n) return { error: `0x0 is not ${a}` };
  if (value >= bound) return { error: `it is ${tooLarge}` };
  return { value };
}

export const parseAddress = (input) => parseFelt(input, "an address", "address", ADDRESS_BOUND, "too large for a Starknet address (the largest is 2^251 - 257)");
export const parseTxHash = (input) => parseFelt(input, "a transaction hash", "transaction hash", P, "too large for a Starknet transaction hash (it must be below the field prime)");
