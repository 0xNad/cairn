import { CairnError, Migration, log } from './errors.mjs';
import { messages } from './format.mjs';
import { METADATA_TTL } from './tokens.mjs';

export function newChat() {
  return { watches: [], whales: [], minimums: {}, tracks: [], muted: [],
    paused: false, callbacks: {}, rates: {}, deliveries: {} };
}
export function chatState(store, id) {
  return store.state.chats[String(id)] ??= newChat();
}
export function enqueue(chat, key, lines, details = {}) {
  enqueueParts(chat, key, messages(lines), details);
}
export function enqueueParts(chat, key, parts, details = {}) {
  if (Object.hasOwn(chat.deliveries, key)) return;
  chat.deliveries[key] = { ...details, parts: parts.map(text => ({ text, message_id: null })) };
}
export function prune(store, chainTime) {
  for (const chat of Object.values(store.state.chats)) {
    for (const [key, record] of Object.entries(chat.deliveries)) {
      if (Number.isSafeInteger(record.at) && chainTime - record.at >= METADATA_TTL &&
          record.parts.every(part => part.message_id !== null)) delete chat.deliveries[key];
    }
  }
  for (const [address, metadata] of Object.entries(store.state.metadata)) {
    if (chainTime - metadata.at >= METADATA_TTL) delete store.state.metadata[address];
  }
}
export function migrate(store, oldId, newId) {
  if (oldId === newId) return;
  const old = store.state.chats[String(oldId)];
  if (!old) return;
  const next = store.state.chats[String(newId)] ?? newChat();
  // Preserve data already configured under the destination id. Its explicit settings win collisions.
  for (const field of ['watches', 'whales', 'tracks']) {
    const identity = field === 'tracks' ? 'hash' : 'address';
    next[field] = [...next[field], ...old[field].filter(a => !next[field].some(b => a[identity] === b[identity]))];
  }
  next.minimums = { ...old.minimums, ...next.minimums };
  next.muted = [...new Set([...next.muted, ...old.muted])];
  next.deliveries = { ...old.deliveries, ...next.deliveries };
  // A callback capability is scoped to the original chat and must not be carried to another one.
  next.callbacks = {};
  next.rates = {};
  next.paused = false;
  store.state.chats[String(newId)] = next;
  delete store.state.chats[String(oldId)];
  store.save();
}

export const messageParams = (chatId, text) => ({
  chat_id: Number(chatId), text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
});

export async function sendReply(context, id, lines, extra = {}) {
  let chatId = id, sent = 0;
  for (const text of messages(lines)) {
    for (let migrations = 0; migrations < 3; migrations++) {
      try {
        const result = await context.tg.call('sendMessage', { ...messageParams(chatId, text), ...extra });
        if (result === null) {
          chatState(context.store, chatId).paused = true;
          context.store.save();
          return sent;
        }
        sent++;
        break;
      } catch (error) {
        if (!(error instanceof Migration)) throw error;
        migrate(context.store, chatId, error.chatId);
        chatId = error.chatId;
      }
    }
  }
  return sent;
}

export async function deliver(context) {
  const { store, tg, signal } = context;
  let sent = 0;
  // Snapshot IDs, because migration can replace an entry while it is being delivered.
  for (const initialId of Object.keys(store.state.chats)) {
    let id = initialId;
    let chat = store.state.chats[id];
    if (!chat || chat.paused) continue;
    const entries = Object.keys(chat.deliveries);
    let blocked = false;
    for (const key of entries) {
      if (blocked) break;
      let record = chat.deliveries[key];
      for (let index = 0; index < record.parts.length; index++) {
        if (record.parts[index].message_id !== null) continue;
        for (let migrations = 0; migrations < 3; migrations++) {
          try {
            // A migration may merge this transaction into a destination that already confirmed it.
            if (record.parts[index]?.message_id !== null) break;
            const part = record.parts[index];
            const result = await tg.call('sendMessage', messageParams(id, part.text));
            if (result === null) {
              chat.paused = true;
              store.save();
              blocked = true;
              break;
            }
            if (!Number.isSafeInteger(result?.message_id)) throw new CairnError('Telegram returned an invalid delivery confirmation.');
            part.message_id = result.message_id;
            // Keep the event indexes and message IDs for future corrections; discard delivered text.
            delete part.text;
            store.save();
            sent++;
            break;
          } catch (error) {
            if (signal.aborted || error instanceof CairnError && [3].includes(error.exitCode) ||
                /conflict \(409\)/.test(error.message)) throw error;
            if (error instanceof Migration) {
              migrate(store, id, error.chatId);
              id = String(error.chatId);
              chat = store.state.chats[id];
              record = chat.deliveries[key];
              if (migrations === 2) blocked = true;
              continue;
            }
            // Do not allow a failed chat to block others or later scans. Within this chat retain order.
            log('warn', 'Alert delivery deferred; pending data retained.');
            blocked = true;
            break;
          }
        }
        if (blocked) break;
      }
    }
  }
  return sent;
}
