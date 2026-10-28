import { readFileSync } from 'node:fs';

// Round 4's guards. Seed: a message holding a run of at least 12 BIP-39 English words (12, 15, 18, 21 and 24 are
// the phrase lengths; a longer run holds one) is deleted. Links: a message linking to a host that is, or sits
// under, a domain of the blocklist is deleted. Both are pure functions of the message: the bot deletes and warns,
// and nothing of the message is stored or logged. The word list is BIP-39's (wordlists/bip39-english.txt, MIT,
// see wordlists/BIP39-LICENSE), 2048 words, sha256 2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda.

export const SEED_RUN = 12;
const WORDS = new Set(readFileSync(new URL('../wordlists/bip39-english.txt', import.meta.url), 'utf8').split('\n').map((w) => w.trim()).filter(Boolean));
if (WORDS.size !== 2048) throw new Error('wordlists/bip39-english.txt must hold the 2048 BIP-39 words.');
/** A list number (1, 2., 12)) between words, as people paste phrases: it neither counts nor breaks a run. */
const NUMBERING = /^\d{1,2}$/;

/** The longest run of consecutive BIP-39 words in `text`; letters, digits and _ make a word, anything else splits. */
export function seedRun(text) {
  let run = 0, longest = 0;
  for (const token of String(text ?? '').toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (!token || NUMBERING.test(token)) continue;
    run = WORDS.has(token) ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}
export const holdsSeed = (text) => seedRun(text) >= SEED_RUN;

/** A domain as the blocklist and links compare it: lowercase ASCII (punycode), no trailing dot, or null. */
function hostOf(value) {
  try {
    const host = new URL(`http://${value}`).hostname.replace(/\.$/, '');
    return /^(?:[a-z0-9-]+\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/.test(host) ? host : null;
  } catch { return null; }
}
/** The blocklist file: { domains } or { error } naming the first bad line. */
export function parseBlocklist(text) {
  const domains = new Set();
  for (const [i, raw] of String(text).split('\n').entries()) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const host = /^[^\s/:@?#]+$/.test(line) ? hostOf(line) : null;
    if (!host) return { error: `line ${i + 1} is not a domain such as example.com.` };
    domains.add(host);
  }
  return { domains: [...domains] };
}

/** Every host a message links to: its url and text_link entities, and anything in its text that parses as a link. */
export function linkHosts(text, entities = []) {
  const candidates = [];
  const body = String(text ?? '');
  for (const e of Array.isArray(entities) ? entities : []) {
    if (e?.type === 'text_link' && typeof e.url === 'string') candidates.push(e.url);
    if (e?.type === 'url' && Number.isSafeInteger(e.offset) && Number.isSafeInteger(e.length)) candidates.push(body.slice(e.offset, e.offset + e.length));
  }
  for (const word of body.split(/\s+/)) {
    const token = word.replace(/^[<(["'`]+|[>)\]"'`.,;:!?]+$/g, '');
    if (token.includes('.')) candidates.push(token);
  }
  const hosts = new Set();
  for (const candidate of candidates) {
    let host = null;
    try {
      host = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? new URL(candidate).hostname.replace(/\.$/, '') : null;
    } catch { /* not a URL */ }
    if (host === null && /^[\p{L}\p{N}]/u.test(candidate)) host = hostOf(candidate);
    if (host) hosts.add(host.toLowerCase());
  }
  return [...hosts];
}
/** Whether any host the message links to is, or sits under, a listed domain. */
export function holdsListedLink(text, entities, blocklist) {
  if (!blocklist.length) return false;
  return linkHosts(text, entities).some((host) => blocklist.some((d) => host === d || host.endsWith(`.${d}`)));
}

/**
 * The warning that replaces a deleted message: what it was and why it went, never any of its words or its link.
 * `deleted` false means Telegram refused: the warning then names the right Cairn needs.
 */
export function warning(kind, deleted, group) {
  const what = kind === 'seed'
    ? '🛡 <b>Recovery phrase removed.</b> That message looked like a wallet seed phrase. Whoever holds those words controls the wallet: never post them, and no real admin or support will ask for them. If they were real, move the funds to a new wallet now.'
    : '🛡 <b>Link removed.</b> That message linked to a domain on this bot’s blocklist of known scam sites. Do not open it or connect a wallet to it.';
  if (deleted) return what;
  const fix = group
    ? 'Cairn could not delete it: make Cairn an administrator of this group with the “Delete messages” right, and delete it by hand for now.'
    : 'Cairn could not delete it: delete it yourself now.';
  return `${what}\n${fix}`;
}
