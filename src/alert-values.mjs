import { normalize, unsigned, u256 } from "./felt.mjs";

export const TRANSFER =
  "0x0099cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9";
export const APPROVAL =
  "0x0134692b230b9e1ffa39098904722134159652b09c5bc41d88d6698779d228ff";
export const SYMBOL =
  "0x0216b05c387bab9ac31918a3e61672f4618601f3c598a2f3f2710f37053e1ea4";
export const DECIMALS =
  "0x004c4fb1ab068f6039d5780c68dd0fa2f8742cceb3426d19667778ca7f3518a9";
export const CACHE_SECONDS = 7 * 24 * 60 * 60;
export const same = (a, b) => {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
};
const address = (value) =>
  BigInt(value) === 0n ? `0x${"0".repeat(64)}` : normalize(value);

/** Decode shapes only; metadata decides whether a legacy contract is a coin. */
export function eventShape(event) {
  try {
    const modern = event.keys?.length === 3 && event.data?.length === 2;
    const legacy = event.keys?.length === 1 && event.data?.length === 4;
    if (!modern && !legacy) return null;
    const isTransfer = same(event.keys[0], TRANSFER);
    if (!isTransfer && !same(event.keys[0], APPROVAL)) return null;
    return {
      contract: normalize(event.from_address),
      a: address(modern ? event.keys[1] : event.data[0]),
      b: address(modern ? event.keys[2] : event.data[1]),
      value: u256(modern ? event.data : event.data.slice(2)),
      isTransfer,
    };
  } catch {
    return null;
  }
}

function word(value, length) {
  const n = unsigned(value);
  if (
    !Number.isInteger(length) ||
    length < 0 ||
    length > 31 ||
    n >= 1n << BigInt(8 * length)
  )
    throw new Error("Invalid symbol word.");
  return length
    ? Buffer.from(n.toString(16).padStart(length * 2, "0"), "hex")
    : Buffer.alloc(0);
}
export function decodeSymbol(words) {
  if (!Array.isArray(words) || words.length === 0)
    throw new Error("Missing token symbol.");
  let data;
  if (words.length === 1) {
    const n = unsigned(words[0]);
    data = word(words[0], Math.ceil(n.toString(16).length / 2));
  } else {
    const n = Number(unsigned(words[0]));
    const pending = Number(unsigned(words.at(-1)));
    if (
      !Number.isSafeInteger(n) ||
      n > 100 ||
      words.length !== n + 3 ||
      pending > 30
    )
      throw new Error("Invalid symbol ByteArray.");
    data = Buffer.concat([
      ...words.slice(1, n + 1).map((v) => word(v, 31)),
      word(words.at(-2), pending),
    ]);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  // Controls and bidi overrides cannot impersonate a verified token in an alert.
  const safe = text.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  if (!safe) throw new Error("Empty token symbol.");
  return [...safe].slice(0, 11).join("");
}
export function units(text, decimals) {
  if (
    typeof text !== "string" ||
    text.length > 160 ||
    !/^\d+(?:\.\d+)?$/.test(text)
  )
    throw new Error("Amount must be a nonnegative decimal.");
  const [a, b = ""] = text.split(".");
  if (b.length > decimals)
    throw new Error("Amount has too many decimal places.");
  const value =
    BigInt(a) * 10n ** BigInt(decimals) +
    BigInt(b.padEnd(decimals, "0") || "0");
  if (value >= 1n << 256n) throw new Error("Amount exceeds u256.");
  return value.toString();
}
