import { readFileSync } from 'node:fs';
const words = new Set(readFileSync(new URL('./bip39-english.txt', import.meta.url), 'utf8').trim().split('\n'));
/** Look for consecutive dictionary words; checksum is deliberately unnecessary for exposure prevention. */
export function seedRun(text) {
  let run = 0;
  for (const word of text.toLowerCase().split(/\s+/)) {
    run = words.has(word.replace(/^[.,:;!?()\[\]\"']+|[.,:;!?()\[\]\"']+$/g, '')) ? run + 1 : 0;
    if (run >= 12) return true;
  }
  return false;
}
export function blockedLink(message, domains) {
  const text = message.text ?? message.caption ?? '';
  const candidates = [...text.matchAll(/(?:https?:\/\/|www\.)[^\s<>]+/gi)].map(m => m[0]);
  for (const e of [...(message.entities ?? []), ...(message.caption_entities ?? [])]) {
    if (e.type === 'text_link' && e.url) candidates.push(e.url);
    if (e.type === 'url') { const value = text.slice(e.offset, e.offset + e.length); candidates.push(/^https?:/i.test(value) ? value : `https://${value}`); }
  }
  return candidates.some(raw => {
    try {
      const host = new URL(raw.startsWith('www.') ? `https://${raw}` : raw).hostname.toLowerCase().replace(/\.$/, '');
      return domains.some(d => host === d || host.endsWith(`.${d}`));
    } catch { return false; }
  });
}
