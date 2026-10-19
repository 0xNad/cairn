// Chats and what they subscribe to, in the state: watches (an address and its label), whale thresholds, floors
// (/min), muted tokens and tracked transactions. Every entry has a server id, which the Remove buttons carry
// instead of an address. Amounts are kept raw, as decimal strings, with their token's decimals. A paused chat
// (it blocked or removed the bot) keeps its alerts pending until it writes again or adds the bot back.
import { plainAmount } from './felt.mjs';
import { dropChat, rekey } from './ledger.mjs';

export const LIMITS = Object.freeze({ whales: 5, tracks: 10, minimums: 50, muted: 50, label: 32 });
const LISTS = ['watches', 'whales', 'minimums', 'muted', 'tracks'];

/** The chat's entry, created empty when missing. */
export const chatOf = (state, id) => (state.chats[String(id)] ??= { paused: false, watches: [], whales: [], minimums: [], muted: [], tracks: [] });

/** A new server id, for an entry and its Remove button. */
export const newId = (state) => state.nextId++;

/** Deletes a chat's entry once it holds nothing: no subscription, no pause. */
export function tidy(state, id) {
  const chat = state.chats[String(id)];
  if (chat && !chat.paused && LISTS.every((list) => chat[list].length === 0)) delete state.chats[String(id)];
}

/** The entry with server id `id` in a chat, as [list name, index], or null. */
export function findEntry(chat, id) {
  for (const list of LISTS) {
    const index = chat[list].findIndex((e) => e.id === id);
    if (index >= 0) return [list, index];
  }
  return null;
}

/** The chat blocked or removed the bot: its alerts wait. */
export function pause(state, id) {
  const key = String(id);
  if (state.chats[key] || Object.values(state.ledger).some((e) => e.chat === key && e.status === 'pending')) chatOf(state, id).paused = true;
}

/** The chat wrote again, or added the bot back. */
export function resume(state, id) {
  const chat = state.chats[String(id)];
  if (!chat?.paused) return;
  chat.paused = false;
  tidy(state, id);
}

/** Everything stored for a chat, as /export shows it. */
export function exportOf(state, id) {
  const chat = state.chats[String(id)];
  const min = (e) => plainAmount(BigInt(e.min), e.decimals);
  const alerts = { pending: 0, sent: 0, failed: 0 };
  for (const entry of Object.values(state.ledger)) if (entry.chat === String(id)) alerts[entry.status]++;
  return {
    chat_id: Number(id),
    watches: (chat?.watches ?? []).map((w) => ({ address: w.address, label: w.label, since_block: w.since_block, seen_tokens: w.seen })),
    whales: (chat?.whales ?? []).map((w) => ({ token: w.token, symbol: w.symbol, verified: w.verified, min: min(w), since_block: w.since_block })),
    minimums: Object.fromEntries((chat?.minimums ?? []).map((m) => [m.token, min(m)])),
    tracks: (chat?.tracks ?? []).map((t) => ({ hash: t.hash, since_block: t.since_block, stage: t.stage })),
    muted: (chat?.muted ?? []).map((m) => m.token),
    paused: chat?.paused ?? false,
    // The delivery ledger's entries for this chat (transaction hashes and message ids, kept 7 days), and the
    // buttons under replies to pasted inputs (kept a day).
    alerts,
    buttons: Object.values(state.offers).filter((o) => o.chat === String(id)).map((o) => ({ [o.kind]: o.value })),
  };
}

/** Deletes everything stored for a chat: its subscriptions, its alerts, pending or sent, and its buttons. */
export function forget(state, id) {
  delete state.chats[String(id)];
  dropChat(state, id);
  for (const [key, o] of Object.entries(state.offers)) if (o.chat === String(id)) delete state.offers[key];
}

/** Moves a chat to the id Telegram gave it as a supergroup, merged into anything already there. */
export function migrate(state, from, to) {
  const old = state.chats[String(from)];
  if (old) {
    const target = chatOf(state, to);
    const merge = (list, same) => { for (const e of old[list]) if (!target[list].some((x) => same(x, e))) target[list].push(e); };
    merge('watches', (x, e) => x.address === e.address);
    merge('whales', (x, e) => x.token === e.token);
    merge('minimums', (x, e) => x.token === e.token);
    merge('muted', (x, e) => x.token === e.token);
    merge('tracks', (x, e) => x.hash === e.hash);
    target.paused = false;
    delete state.chats[String(from)];
  }
  rekey(state, from, to);
  for (const o of Object.values(state.offers)) if (o.chat === String(from)) o.chat = String(to);
}
