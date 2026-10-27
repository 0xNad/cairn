import { readFileSync } from 'node:fs';
import { CairnError } from './errors.mjs';

const words = new Set(readFileSync(new URL('../wordlists/bip39-english.txt', import.meta.url), 'utf8').trim().split('\n'));
/** Numbering and punctuation separate words; any other word interrupts the run. */
export function seedRun(text) {
  let count = 0;
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) {
    if (/^\d+$/.test(token)) continue;
    if (words.has(token)) { if (++count >= 12) return true; }
    else count = 0;
  }
  return false;
}
export function readBlocklist(path) {
  try {
    return readFileSync(path, 'utf8').split('\n').map(l => l.split('#')[0].trim().toLowerCase()).filter(Boolean).map(domain => {
      if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw Error();
      return domain;
    });
  } catch { throw new CairnError('CAIRN_BLOCKLIST: unreadable file or invalid domain.', 2); }
}
/** URL parsing makes userinfo, paths and host boundaries unambiguous. */
export function blockedLink(text, domains) {
  for (const match of text.matchAll(/https?:\/\/[^\s<>]+|(?<![\w@.-])(?:[a-z0-9-]+\.)+[a-z]{2,}[^\s<>]*/gi)) {
    try {
      const host = new URL(/^https?:\/\//i.test(match[0]) ? match[0].replace(/[.,;!?)\]}]+$/, '') : `https://${match[0].replace(/[.,;!?)\]}]+$/, '')}`).hostname.toLowerCase().replace(/\.$/, '');
      if (domains.some(d => host === d || host.endsWith(`.${d}`))) return true;
    } catch { /* not a URL */ }
  }
  return false;
}
export class Guards {
  constructor(store, domains) { this.store = store; this.domains = domains; }
  settings(chatId) { return this.store.sql('SELECT seed, links FROM protection WHERE chat_id = ?').get(chatId) ?? { seed: 1, links: 1 }; }
  set(chat, key, on) {
    if (!['seed', 'links'].includes(key)) throw Error('Unknown setting');
    this.store.sql('INSERT OR IGNORE INTO protection (chat_id) VALUES (?)').run(chat.id);
    this.store.sql(`UPDATE protection SET ${key} = ? WHERE chat_id = ?`).run(Number(on), chat.id);
    this.store.sql('INSERT OR IGNORE INTO chats (chat_id, type) VALUES (?, ?)').run(chat.id, chat.type);
  }
  match(message) {
    const s = this.settings(message.chat.id), text = message.text ?? message.caption ?? '';
    if (s.seed && seedRun(text)) return 'seed';
    const urls = [...(message.entities ?? []), ...(message.caption_entities ?? [])].filter(e => e.type === 'text_link').map(e => e.url).join(' ');
    if (s.links && blockedLink(`${text} ${urls}`, this.domains)) return 'links';
    return null;
  }
}

/** Fixed templates never interpolate inspected content. */
export function guardWarning(kind, removed) {
  const subject = kind === 'seed' ? 'a wallet recovery phrase' : 'a blocked link (known phishing domain)';
  return removed
    ? [`🛡 Deleted a message ${kind === 'seed' ? 'that looked like' : 'with'} ${subject}.`,
      kind === 'seed' ? 'Never share yours: admins and support will never ask for it.' : "Don't open it."]
    : [`🛡 This message looks like ${subject}.`,
      "I couldn't delete it: make me an admin with the “Delete messages” right."];
}
