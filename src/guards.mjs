import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CairnError, log } from './errors.mjs';
import { escapeHtml } from './format.mjs';

// The member guards (round 4), on by default in every chat; /guard seed|links on|off for administrators.
// - Seed phrases: a message holding a run of BIP-39 words as long as the shortest seed phrase (12; 15, 18, 21 and
//   24 words hold such a run too) is deleted. Its words are never stored, logged or repeated: the warning is built
//   from words outside the list, so it cannot quote one.
// - Links: a message linking to a host that is, or sits under, a domain of the blocklist (CAIRN_BLOCKLIST) is
//   deleted. Hosts are read the way a browser reads them, so userinfo, paths and look-alike suffixes never match.

export const WORDLIST = fileURLToPath(new URL('../wordlists/bip39-english.txt', import.meta.url));
export const BLOCKLIST = fileURLToPath(new URL('../blocklist/domains.txt', import.meta.url));
export const SEED_RUN = 12;

/** The BIP-39 English list, checked: 2048 distinct words of 3 to 8 lower-case letters, as the standard has. */
export function loadWordlist(path = WORDLIST) {
  let words;
  try { words = readFileSync(path, 'utf8').split('\n').map((w) => w.trim()).filter(Boolean); }
  catch { throw new CairnError(`${path}: missing or unreadable; restore it from the repository.`, 2); }
  const set = new Set(words);
  if (words.length !== 2048 || set.size !== 2048 || !words.every((w) => /^[a-z]{3,8}$/.test(w))) {
    throw new CairnError(`${path}: not the BIP-39 English list (2048 distinct lower-case words); restore it from the repository.`, 2);
  }
  return set;
}

const LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;
/** A domain as a browser would compare it: lower case, punycode, no trailing dot; null when it is not one. */
function domainOf(text) {
  let url;
  try { url = new URL(`http://${text}/`); } catch { return null; }
  const host = url.hostname.replace(/\.$/, '');
  if (url.pathname !== '/' || url.port || url.username || url.password || url.search || url.hash) return null;
  return host.split('.').every((label) => LABEL.test(label)) ? host : null;
}

/**
 * The blocklist file: one domain per line, `#` starting a comment, as ARCHITECTURE.md fixes. A line may also read
 * `*.domain` or `.domain` (the same thing: subdomains are always covered) or come from a hosts file
 * (`0.0.0.0 domain`). A line that is none of these exits 2, naming the file and the line.
 */
export function loadBlocklist(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { throw new CairnError(`${path}: missing or unreadable blocklist (CAIRN_BLOCKLIST).`, 2); }
  const domains = new Set();
  text.split(/\r?\n/).forEach((line, i) => {
    let value = line.replace(/#.*/, '').trim().toLowerCase();
    if (!value) return;
    const hosts = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s+(\S+)$/.exec(value);
    if (hosts) value = hosts[1];
    const domain = domainOf(value.replace(/^\*?\./, ''));
    if (!domain) throw new CairnError(`${path}: line ${i + 1}: "${value.slice(0, 60)}" is not a domain name.`, 2);
    domains.add(domain);
  });
  return domains;
}

/**
 * The longest run of consecutive BIP-39 words in `text`, compared in lower case. Numbers, bullets and punctuation
 * around or between the words (a numbered list, a comma-separated paste) neither count nor break a run; any other
 * word breaks it.
 */
export function longestRun(text, words) {
  let run = 0, best = 0;
  for (const token of String(text).split(/[\s,;:|/\\_.\-–—•·]+/u)) {
    const core = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').toLowerCase();
    if (!core) continue;
    if (words.has(core)) best = Math.max(best, ++run);
    else run = 0;
  }
  return best;
}

const SCHEME_URL = /\b[a-z][a-z0-9+.-]{0,20}:\/\/[^\s<>"'`]+/giu;
const TRAILING = /[).,;:!?'"\]}>»”’]+$/u;
// A host written without a scheme, as Telegram links "example.com/path" too: it starts a word (never inside a
// path, a query or an address like name@host) and ends at the end of its last label.
const BARE_HOST = /(?<=^|[\s(\[{<"'«“‘])((?:[\p{L}\p{N}_](?:[\p{L}\p{N}_-]{0,61}[\p{L}\p{N}_])?\.)+(?:\p{L}{2,63}|xn--[a-z0-9-]{1,59}))(?=$|[\s/:?#)\]}>,;!"'»”’]|\.(?:$|[^\p{L}\p{N}]))/giu;

/**
 * The hosts every link of a message points to: URLs in its text or caption, hosts written without a scheme, the
 * hidden targets of text links, Telegram's own link entities and the URL buttons of a message sent via a bot.
 */
export function linkHosts(message) {
  const hosts = new Set();
  const add = (raw) => {
    const candidate = String(raw).replace(TRAILING, '');
    let url;
    try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `http://${candidate}`); } catch { return; }
    const host = url.hostname.replace(/\.$/, '').toLowerCase();
    if (host) hosts.add(host);
  };
  for (const [text, entities] of [[message?.text, message?.entities], [message?.caption, message?.caption_entities]]) {
    if (typeof text !== 'string') continue;
    for (const e of Array.isArray(entities) ? entities : []) {
      if (e?.type === 'text_link' && typeof e.url === 'string') add(e.url);
      if (e?.type === 'url' && Number.isSafeInteger(e.offset) && Number.isSafeInteger(e.length)) add(text.substr(e.offset, e.length));
    }
    const rest = text.replace(SCHEME_URL, (found) => { add(found); return ' '; });
    for (const m of rest.matchAll(BARE_HOST)) add(m[1]);
  }
  for (const row of Array.isArray(message?.reply_markup?.inline_keyboard) ? message.reply_markup.inline_keyboard : []) {
    for (const button of Array.isArray(row) ? row : []) if (typeof button?.url === 'string') add(button.url);
  }
  return hosts;
}

/** The blocklisted domain `host` is, or sits under, or null. */
export function listed(host, blocklist) {
  const labels = host.split('.');
  for (let i = 0; i < labels.length; i++) {
    const domain = labels.slice(i).join('.');
    if (blocklist.has(domain)) return domain;
  }
  return null;
}

/** A domain shown without becoming a link again: starknet-bot[.]com, in code. */
const defanged = (domain) => `<code>${escapeHtml(domain.replaceAll('.', '[.]'))}</code>`;

/**
 * The warning after a guarded message: `deleted` says whether Telegram let Cairn delete it, and when it did not, the
 * warning names the right Cairn needs. A seed warning uses no BIP-39 word at all (test/round4.test.mjs checks it),
 * so it can never repeat one of the words it protects; it is never sent as a reply, whose preview would quote them.
 */
export function warning(found, deleted) {
  if (found.guard === 'seed') {
    return deleted
      ? `🛡 Deleted: it held ${found.words} recovery words. Whoever reads them controls the wallet. If those words secure funds, sweep everything to a new wallet straightaway. Nobody legitimate requests them: not admins, moderators or bots.`
      : `🛡 Cairn could not delete it, though it holds ${found.words} recovery words: Cairn lacks the Delete messages permission. An administrator should delete it manually, immediately, and assign Cairn the Delete messages permission.`;
  }
  return deleted
    ? `🛡 Deleted: it linked to ${defanged(found.domain)}, a domain on this bot's phishing blocklist. Never connect a wallet or sign anything there.`
    : `⚠️ That message links to ${defanged(found.domain)}, a domain on this bot's phishing blocklist, but Cairn could not delete it: Cairn lacks the Delete messages permission. An administrator should delete it and give Cairn that right. Do not open the link.`;
}

/** The guards of one process: the word list and the blocklist, which `refresh` reloads when its file changes. */
export class Guards {
  constructor(config) {
    this.words = config.wordlist;
    this.blocklist = config.blocklist;
    this.path = config.blocklistPath ?? null;
    this.stamp = this.#stamp();
  }
  #stamp() {
    try { const s = statSync(this.path); return `${s.mtimeMs} ${s.size}`; } catch { return null; }
  }
  /** Picks up an edited blocklist without a restart; a broken edit keeps the list in use, with a warning. */
  refresh() {
    if (!this.path) return;
    const stamp = this.#stamp();
    if (stamp === this.stamp) return;
    this.stamp = stamp;
    try {
      this.blocklist = loadBlocklist(this.path);
      log('info', 'blocklist reloaded', { domains: this.blocklist.size });
    } catch (error) { log('warn', `blocklist unchanged: ${error.message}`); }
  }
  /** Why a message must go, or null: { guard: 'seed', words } or { guard: 'links', domain }, for the chat's settings. */
  inspect(message, { seed = true, links = true } = {}) {
    if (seed) {
      const words = Math.max(0, ...[message?.text, message?.caption].filter((t) => typeof t === 'string').map((t) => longestRun(t, this.words)));
      if (words >= SEED_RUN) return { guard: 'seed', words };
    }
    if (links && this.blocklist.size) {
      for (const host of linkHosts(message)) {
        const domain = listed(host, this.blocklist);
        if (domain) return { guard: 'links', domain };
      }
    }
    return null;
  }
}
