// Message formats (ARCHITECTURE.md, "Output conventions"): Telegram HTML, escaping, exact amounts, short
// addresses, explorer links, UTC times, and splitting a reply into messages of at most 4096 characters.

/** Escapes an outside string for Telegram HTML: &, <, > and ", so it is safe in text and in attributes. */
export const escape = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Digits grouped by thousands: 1234567 → 1,234,567. */
export const group = (v) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** An exact decimal from a raw integer amount: trailing zeros trimmed, no rounding, no scientific notation. */
export function units(raw, decimals) {
  const sign = raw < 0n ? "-" : "";
  const v = raw < 0n ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${group(v / base)}${frac ? `.${frac}` : ""}`;
}

/** 0x0471…938d: 0x, the first 4 and the last 4 of the 64 digits. */
export const shortHex = (hex64) => `${hex64.slice(0, 6)}…${hex64.slice(-4)}`;

export const link = (url, html) => `<a href="${escape(url)}">${html}</a>`;
/** An address shown short and linked to the explorer's contract page. */
export const contractLink = (explorer, hex64, html = shortHex(hex64)) => link(`${explorer}/contract/${hex64}`, html);
/** A transaction hash shown short and linked to the explorer's transaction page. */
export const txLink = (explorer, hex64, html = shortHex(hex64)) => link(`${explorer}/tx/${hex64}`, html);

/** Chain time (Unix seconds) as YYYY-MM-DD HH:MM:SS UTC. */
export const utc = (seconds) => new Date(Number(seconds) * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");

/** The length Telegram counts for a message Cairn wrote: UTF-16 units of its text, tags removed. */
export const plainLength = (html) => html.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot);/g, "&").length;

/**
 * Splits a reply into Telegram messages of at most `limit` characters, at line breaks. A reply is a list
 * of blocks: a line of HTML with balanced tags, or { quote: text }, outside text shown escaped in an
 * expandable quote, split at its own line breaks (or inside a line too long for one message) and closed and
 * reopened across messages.
 */
export function paginate(blocks, limit = 4096) {
  const items = [];
  for (const b of blocks) {
    if (typeof b === "string") items.push({ html: b, len: plainLength(b) });
    else for (const line of pieces(String(b.quote), limit - 64)) items.push({ html: escape(line), len: line.length, quote: true });
  }
  const pages = [];
  let page = [], size = 0;
  for (const it of items) {
    if (page.length && size + 1 + it.len > limit) {
      pages.push(page);
      page = [];
      size = 0;
    }
    size += (page.length ? 1 : 0) + it.len;
    page.push(it);
  }
  if (page.length) pages.push(page);
  return pages.map(render).filter((html) => html.replace(/<[^>]*>/g, "").trim() !== "");
}

function render(items) {
  const out = [];
  let quote = null;
  for (const it of items) {
    if (it.quote) {
      (quote ??= []).push(it.html);
      continue;
    }
    if (quote) out.push(`<blockquote expandable>${quote.join("\n")}</blockquote>`);
    quote = null;
    out.push(it.html);
  }
  if (quote) out.push(`<blockquote expandable>${quote.join("\n")}</blockquote>`);
  return out.join("\n").trim();
}

/** The lines of `text`, each cut into pieces of at most `max` UTF-16 units, never inside a surrogate pair. */
function pieces(text, max) {
  const out = [];
  for (let line of text.split("\n")) {
    while (line.length > max) {
      let cut = max;
      if (/[\udc00-\udfff]/.test(line[cut])) cut--;
      out.push(line.slice(0, cut));
      line = line.slice(cut);
    }
    out.push(line);
  }
  return out;
}
