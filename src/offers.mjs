// The Watch and Track buttons under the reply to an address or a hash pasted in a private chat. A button's
// callback_data is `<verb>:<server id>`; the id names an offer kept here, for its chat, for one day of chain
// time (or until it is used): the pasted value is stored for that long, and only for its button.
const DAY = 24 * 3600;
const PER_CHAT = 10; // a chat's newest offers; older buttons expire

/** Offers `value` ('watch' an address, 'track' a hash) in a chat: the button's callback_data. */
export function offer(state, chat, kind, value, at) {
  const mine = Object.entries(state.offers).filter(([, o]) => o.chat === String(chat)).sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [id] of mine.slice(0, Math.max(0, mine.length - PER_CHAT + 1))) delete state.offers[id];
  const id = state.nextId++;
  state.offers[id] = { chat: String(chat), kind, value, at };
  return `${kind === 'watch' ? 'w' : 't'}:${id}`;
}

/** Takes the offer a button names, if it is this chat's and of this kind: its value, or null. */
export function take(state, chat, kind, id) {
  const found = state.offers[id];
  if (!found || found.chat !== String(chat) || found.kind !== kind) return null;
  delete state.offers[id];
  return found.value;
}

/** Drops the offers older than a day of chain time. */
export function expire(state, now) {
  for (const [id, o] of Object.entries(state.offers)) if (now - o.at > DAY) delete state.offers[id];
}
