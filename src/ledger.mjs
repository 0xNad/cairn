// The delivery ledger, keyed by (chat, transaction hash, event_index): one entry per alerted event, a tracked
// transaction's stage standing for its index. The entries of one message share its `seq`, the order of
// delivery, and the first holds its text until it is sent. Alerts are recorded as pending in the same write
// as the scanner's cursor, so that a scanned range is neither alerted twice nor lost, and marked sent, with
// their message_id, only once Telegram accepts the message. Entries are kept for 7 days of chain time: an
// event scanned again is not alerted again, and round 4's corrections reply to the stored message_id.
const WEEK = 7 * 24 * 3600;

export const alertKey = (chat, tx, index) => `${chat}|${tx}|${index}`;

/** Whether this event (or stage) of this transaction was already alerted to this chat. */
export const alerted = (state, chat, tx, index) => Object.hasOwn(state.ledger, alertKey(chat, tx, index));

/** Records one pending message { chat, tx, indexes, at, text } for the indexes not recorded yet; false if none. */
export function record(state, { chat, tx, indexes, at, text }) {
  const keys = indexes.map((index) => alertKey(chat, tx, index)).filter((key) => !Object.hasOwn(state.ledger, key));
  if (!keys.length) return false;
  const seq = ++state.seq;
  keys.forEach((key, n) => { state.ledger[key] = { chat: String(chat), tx, seq, at, status: 'pending', ...(n ? {} : { text }) }; });
  return true;
}

/** The pending messages, in the order they were recorded (chain order): [{ seq, chat, text, keys }]. */
export function pending(state) {
  const messages = new Map();
  for (const [key, entry] of Object.entries(state.ledger)) {
    if (entry.status !== 'pending') continue;
    const message = messages.get(entry.seq) ?? messages.set(entry.seq, { seq: entry.seq, chat: entry.chat, keys: [] }).get(entry.seq);
    message.keys.push(key);
    if (entry.text !== undefined) message.text = entry.text;
  }
  return [...messages.values()].sort((a, b) => a.seq - b.seq);
}

function conclude(state, message, status, messageId) {
  for (const key of message.keys) {
    const entry = state.ledger[key];
    if (!entry) continue;
    entry.status = status;
    if (Number.isSafeInteger(messageId)) entry.message_id = messageId;
    delete entry.text;
  }
}
/** Telegram accepted the message. */
export const markSent = (state, message, messageId) => conclude(state, message, 'sent', messageId);
/** Telegram refused the message for good (a 400 that is not a migration): it is not sent again. */
export const markFailed = (state, message) => conclude(state, message, 'failed');

/** Drops the entries older than 7 days of chain time (`now`, in seconds). */
export function prune(state, now) {
  for (const [key, entry] of Object.entries(state.ledger)) if (now - entry.at > WEEK) delete state.ledger[key];
}

/** Moves a chat's entries to the id Telegram gave it as a supergroup. */
export function rekey(state, from, to) {
  for (const [key, entry] of Object.entries(state.ledger)) {
    if (entry.chat !== String(from)) continue;
    delete state.ledger[key];
    state.ledger[`${to}${key.slice(String(from).length)}`] ??= { ...entry, chat: String(to) };
  }
}

/** Deletes a chat's entries, sent or not (/forget). */
export function dropChat(state, chat) {
  for (const [key, entry] of Object.entries(state.ledger)) if (entry.chat === String(chat)) delete state.ledger[key];
}
