// Message formatting: Telegram HTML, exact amounts, links, times, and splitting replies into messages of
// at most 4096 characters at line breaks.
import { hex64, shortHex } from "./felt.mjs";

export const MAX_MESSAGE = 4096;

// Every outside string goes through these: labels, symbols, names, revert reasons.
export const escapeHtml = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export const escapeAttr = (s) => escapeHtml(s).replaceAll('"', "&quot;");
export const link = (href, html) => `<a href="${escapeAttr(href)}">${html}</a>`;

// Explorer links, built from CAIRN_EXPLORER_URL and never fetched.
export const contractUrl = (explorer, address) => `${explorer}/contract/${hex64(address)}`;
export const txUrl = (explorer, hash) => `${explorer}/tx/${hex64(hash)}`;
export const addressLink = (explorer, address) => link(contractUrl(explorer, address), shortHex(address));
export const txLink = (explorer, hash) => link(txUrl(explorer, hash), shortHex(hash));

// 1234567 → "1,234,567" (BigInt, number or digit string).
export const groupDigits = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// An exact decimal from a BigInt and its decimals: trailing zeros trimmed, grouped by thousands.
// formatUnits(1234500000000000000000n, 18) is "1,234.5".
export function formatUnits(value, decimals) {
  const v = BigInt(value);
  const sign = v < 0n ? "-" : "";
  const abs = v < 0n ? -v : v;
  const scale = 10n ** BigInt(decimals);
  const whole = groupDigits(abs / scale);
  const frac = decimals > 0 ? (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return `${sign}${whole}${frac ? `.${frac}` : ""}`;
}

// Unix seconds → "YYYY-MM-DD HH:MM:SS UTC".
export const formatTime = (seconds) => `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`;

// Packs lines into messages of at most `limit` characters, splitting only between lines. Each line must
// be balanced HTML; the HTML length bounds the length Telegram counts (the text after entity parsing).
export function pack(lines, limit = MAX_MESSAGE) {
  const out = [];
  let cur = "";
  const flush = () => {
    const text = cur.replace(/^\n+|\n+$/g, "");
    if (text.trim() !== "") out.push(text);
    cur = "";
  };
  for (const line of lines) {
    if (cur !== "" && cur.length + 1 + line.length > limit) flush();
    // A single line over the limit cannot be split safely: the builders never make one (see preBlocks).
    cur = cur === "" ? line.slice(0, limit) : `${cur}\n${line}`;
  }
  flush();
  return out;
}

// Preformatted text as one or more <pre> blocks, each at most `max` characters of HTML, split at line
// breaks (or, for a single longer line, between characters).
export function preBlocks(text, max = 3000) {
  const blocks = [];
  let cur = "";
  const push = () => {
    if (cur !== "") blocks.push(`<pre>${escapeHtml(cur)}</pre>`);
    cur = "";
  };
  for (const line of String(text).split("\n")) {
    const next = cur === "" ? line : `${cur}\n${line}`;
    if (escapeHtml(next).length <= max) {
      cur = next;
      continue;
    }
    push();
    let rest = [...line]; // code points, so that a surrogate pair is never cut
    while (escapeHtml(rest.join("")).length > max) {
      let n = 0, size = 0;
      while (n < rest.length && size + escapeHtml(rest[n]).length <= max) size += escapeHtml(rest[n++]).length;
      cur = rest.slice(0, n).join("");
      push();
      rest = rest.slice(n);
    }
    cur = rest.join("");
  }
  push();
  return blocks;
}

// The text Telegram would show for our HTML: for the plain-text fallback when Telegram refuses the HTML.
export const htmlToText = (html) => String(html).replace(/<[^>]*>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
