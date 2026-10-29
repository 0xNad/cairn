import { readFileSync } from 'node:fs';

const WORDS = new Set(readFileSync(new URL('../resources/bip39-english.txt', import.meta.url), 'utf8').trim().split('\n'));
/** Words separated by whitespace form a run; punctuation and nonwords break it. No input is retained. */
export function containsSeed(text) {
  let run = 0;
  for (const token of String(text).normalize('NFKD').toLowerCase().split(/\s+/u)) {
    // Wrapping punctuation (quotes, brackets or a trailing full stop) is not part of a word.
    const word = token.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, '');
    run = WORDS.has(word) ? run + 1 : 0;
    if (run >= 12) return true; // every supported length contains a 12-word run; no checksum needed
  }
  return false;
}
export function blockedLink(text, entities, hosts) {
  const urls = [...String(text).matchAll(/(?:https?:\/\/|www\.)[^\s<>"\u0000-\u001f]+/gi)].map(m => m[0]);
  for (const e of entities ?? []) {
    if (e.type === 'text_link' && typeof e.url === 'string') urls.push(e.url);
    if (e.type === 'url' && Number.isInteger(e.offset) && Number.isInteger(e.length)) urls.push(text.slice(e.offset, e.offset + e.length));
  }
  // Telegram also recognizes bare domains. Require a DNS-label boundary, then parse the full authority.
  for (const m of String(text).matchAll(/(?:^|\s)((?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[^\s<>]*)?)/gi)) urls.push(m[1]);
  return urls.some(value => {
    try {
      const u = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
      if (!['http:', 'https:'].includes(u.protocol)) return false;
      const host = u.hostname.toLowerCase().replace(/\.$/, '');
      return hosts.some(domain => host === domain || host.endsWith(`.${domain}`));
    } catch { return false; }
  });
}
export function guarded(message, settings, hosts) {
  for (const [body, entities] of [[message.text, message.entities], [message.caption, message.caption_entities]]) {
    if (typeof body !== 'string') continue;
    if (settings.seed && containsSeed(body)) return 'seed';
    if (settings.links && blockedLink(body, entities, hosts)) return 'links';
  }
  return null;
}
