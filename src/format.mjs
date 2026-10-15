// Output conventions (ARCHITECTURE.md, "Output conventions"): HTML escaping, exact amounts, addresses, times
// and message splitting. Pure functions, no I/O.
import { shortHex } from "./felt.mjs";

/** Telegram counts a message's length after it parses the entities: UTF-16 code units of the plain text. */
export const TELEGRAM_LIMIT = 4096;
/** Replies are cut a little under the limit, so that a miscount never makes Telegram refuse one. */
const SPLIT_AT = 4000;

/** Escapes an outside string for Telegram's HTML parse mode (text and attribute values alike). */
export const esc = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `<a href>` with both parts escaped. */
export const link = (url, text) => `<a href="${esc(url)}">${esc(text)}</a>`;

/** An address as its short form, linked to the explorer. `h64` is a normalised address. */
export const addressLink = (explorer, h64) => link(`${explorer}/contract/${h64}`, shortHex(h64));
/** A transaction hash as its short form, linked to the explorer. `h64` is a normalised hash. */
export const txLink = (explorer, h64) => link(`${explorer}/tx/${h64}`, shortHex(h64));

/** A whole number with `,` between groups of three digits. */
export const groupDigits = (digits) => String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** An integer (bigint, number or digits) grouped by thousands: `41,234,567,890,123`. */
export const formatInt = (value) => groupDigits(BigInt(value).toString());

/**
 * An exact decimal from `value` / 10^decimals, computed with BigInt: trailing zeros trimmed, no exponent,
 * and `,` groups in the integer part only.
 */
export function formatUnits(value, decimals) {
  const v = BigInt(value);
  const digits = (v < 0n ? -v : v).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${v < 0n ? "-" : ""}${groupDigits(whole)}${fraction ? `.${fraction}` : ""}`;
}

/** `1,234.5 STRK`. */
export const formatAmount = (value, decimals, symbol) => `${formatUnits(value, decimals)} ${symbol}`;

/** `YYYY-MM-DD HH:MM:SS UTC` from seconds since the epoch. */
export function formatUtc(seconds) {
  const d = new Date(Number(seconds) * 1000);
  if (Number.isNaN(d.getTime())) return "unknown time";
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"' };
/** The text a reader sees: tags removed, the four entities decoded. */
export const plainText = (html) =>
  html.replace(/<[^>]*>/g, "").replace(/&(lt|gt|amp|quot);/g, (_, name) => ENTITIES[name]);
/** A message's length as Telegram counts it. */
export const plainLength = (html) => plainText(html).length;

/**
 * Splits an HTML reply at line breaks into messages of at most 4000 characters. A tag that is open at a
 * break (a `<pre>`, a `<blockquote>`) is closed there and opened again in the next message, so that every
 * message is valid HTML on its own.
 * @returns {string[]} at least one message; none is empty
 */
export function splitMessage(html) {
  const chunks = [];
  let current = "";
  let length = 0;
  let started = false;
  const open = []; // the tags open at the end of `current`: { name, tag }

  const close = () => open.map((t) => `</${t.name}>`).reverse().join("");
  const reopen = () => open.map((t) => t.tag).join("");
  const track = (line) => {
    for (const m of line.matchAll(/<(\/?)([a-z][a-z0-9-]*)(?:\s[^>]*)?>/gi)) {
      if (m[1]) open.pop();
      else open.push({ name: m[2].toLowerCase(), tag: m[0] });
    }
  };

  for (const line of html.split("\n")) {
    const size = plainLength(line);
    if (started && length + 1 + size > SPLIT_AT) {
      chunks.push(current + close());
      current = reopen();
      length = 0;
      started = false;
    }
    current += `${started ? "\n" : ""}${line}`;
    length += (started ? 1 : 0) + size;
    started = true;
    track(line);
  }
  chunks.push(current + close());

  // A piece that is still too long (one enormous line) is sent as escaped plain text, cut: never invalid HTML.
  return chunks
    .filter((c) => plainText(c).trim() !== "")
    .map((c) => (plainLength(c) > TELEGRAM_LIMIT ? esc(plainText(c).slice(0, SPLIT_AT)) : c));
}
