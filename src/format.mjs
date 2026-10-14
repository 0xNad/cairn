// Message formatting: HTML escaping, amounts, addresses, times, and splitting a reply into messages of at
// most 4096 characters. Pure functions, no I/O.
import { hex64 } from "./felt.mjs";

/** Telegram's message limit, in UTF-16 code units after entity parsing. */
export const MAX_MESSAGE = 4096;

/** Escapes an outside string for Telegram HTML: `&`, `<`, `>` and `"`. */
export const escapeHtml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** `1234567` → `1,234,567`. */
export const groupDigits = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** An integer (number or bigint) with grouping commas. */
export const formatInt = (n) => groupDigits(BigInt(n).toString());

/** An exact decimal from a raw integer amount and its decimals, trailing zeros trimmed: `1,234.5`. */
export function formatUnits(raw, decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const fraction = decimals > 0 ? (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return `${groupDigits(whole.toString())}${fraction ? `.${fraction}` : ""}`;
}

/** `0x0471…938d`: 0x, the first 4 and the last 4 of the 64 digits. */
export const shortHex = (v) => {
  const h = hex64(v);
  return `${h.slice(0, 6)}…${h.slice(-4)}`;
};

/** A chain timestamp (seconds) as `YYYY-MM-DD HH:MM:SS UTC`. */
export const utcTime = (seconds) => new Date(Number(seconds) * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");

/** A link; `html` is already HTML, `href` is escaped here. */
export const link = (href, html) => `<a href="${escapeHtml(href)}">${html}</a>`;

/** Explorer links: `${CAIRN_EXPLORER_URL}/contract/<64 hex>` and `/tx/<64 hex>`. */
export const contractLink = (explorer, address) => link(`${explorer}/contract/${hex64(address)}`, shortHex(address));
export const txLink = (explorer, hash) => link(`${explorer}/tx/${hex64(hash)}`, shortHex(hash));

/** How long `html` is once Telegram parses it (only the tags and entities Cairn writes). */
export const plainLength = (html) => html.replace(/<[^>]*>/g, "").replace(/&(?:lt|gt|amp|quot);/g, "x").length;

/**
 * A quoted block of outside text (a revert reason): each line escaped, long lines cut into pieces, inside an
 * expandable blockquote so that a long trace stays folded in a busy group. Returned as a block for split().
 */
export function quote(text, { piece = 1000 } = {}) {
  const lines = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (line === "") continue;
    for (let i = 0; i < line.length; i += piece) lines.push(escapeHtml(line.slice(i, i + piece)));
  }
  return { open: "<blockquote expandable>", close: "</blockquote>", lines: lines.length ? lines : [escapeHtml("(empty)")] };
}

/**
 * Splits a reply into messages of at most `limit` characters, at line breaks. A reply is a list of lines
 * (each balanced HTML) and blocks from quote(); a block cut between two messages is closed at the end of the
 * first and opened again at the start of the next.
 */
export function split(reply, limit = MAX_MESSAGE) {
  const items = [];
  for (const part of reply) {
    if (typeof part === "string") items.push({ html: part, wrap: null });
    else for (const line of part.lines) items.push({ html: line, wrap: part });
  }
  // Tags count for nothing once parsed: only the text and the line breaks count toward the limit.
  const messages = [];
  let lines = [], size = 0, wrap = null;
  const close = () => {
    if (wrap) lines[lines.length - 1] += wrap.close;
    wrap = null;
  };
  const flush = () => {
    close();
    const text = lines.join("\n").trim();
    if (text.replace(/<[^>]*>/g, "").trim() !== "") messages.push(text);
    lines = [];
    size = 0;
  };
  for (const item of items) {
    const cost = plainLength(item.html) + (lines.length ? 1 : 0);
    if (lines.length && size + cost > limit) flush();
    let line = item.html;
    if (item.wrap !== wrap) {
      close();
      if (item.wrap) line = item.wrap.open + line;
      wrap = item.wrap;
    }
    size += plainLength(item.html) + (lines.length ? 1 : 0);
    lines.push(line);
  }
  if (lines.length) flush();
  return messages;
}
