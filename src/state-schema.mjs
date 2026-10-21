// Validate persisted structures before using an offset or cursor. A damaged ledger must never be
// silently replaced with an empty one, since that would replay or lose alerts.
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const integer = x => Number.isSafeInteger(x) && x >= 0;
const address = x => typeof x === 'string' && /^0x[0-9a-f]{64}$/.test(x);
const value = x => typeof x === 'string' && /^\d{1,78}$/.test(x) && BigInt(x) < (1n << 256n);
const entries = (x, validate) => object(x) && Object.entries(x).every(([key, v]) => validate(v, key));
const array = (x, validate) => Array.isArray(x) && x.every(validate);
const token = t => t === null || object(t) && address(t.address) && integer(t.decimals) && t.decimals <= 36 &&
  typeof t.symbol === 'string' && [...t.symbol].length <= 11 && t.verified === false;

function chat(c) {
  return object(c) && typeof c.paused === 'boolean' &&
    array(c.watches, w => object(w) && address(w.address) && typeof w.label === 'string' &&
      [...w.label].length <= 32 && integer(w.since_block) && array(w.seen, address)) &&
    array(c.whales, w => object(w) && address(w.address) && value(w.amount) && integer(w.since_block)) &&
    entries(c.minimums, (v, key) => address(key) && value(v)) &&
    array(c.tracks, t => object(t) && address(t.hash) && integer(t.since_time) && typeof t.l2 === 'boolean') &&
    array(c.muted, address) &&
    entries(c.callbacks, (b, key) => /^[a-f0-9]{24}$/.test(key) && object(b) &&
      ['remove', 'watch', 'track'].includes(b.verb) && address(b.address)) &&
    entries(c.rates, (r, key) => /^\d+$/.test(key) && Number.isSafeInteger(Number(key)) && object(r) &&
      array(r.dates, integer) && (r.notice === null || integer(r.notice))) &&
    entries(c.deliveries, r => object(r) && array(r.parts, p => object(p) &&
      (p.message_id === null ? typeof p.text === 'string' && p.text.length > 0 && p.text.length <= 4096 : integer(p.message_id))) &&
      r.parts.length > 0 && (r.event_indexes === undefined || array(r.event_indexes, integer)) &&
      (r.at === undefined || integer(r.at)));
}
export function validState(state) {
  return object(state) && (state.cursor === null || integer(state.cursor)) &&
    entries(state.chats, (c, key) => /^-?\d+$/.test(key) && Number.isSafeInteger(Number(key)) && chat(c)) &&
    entries(state.metadata, (m, key) => address(key) && object(m) && integer(m.at) && token(m.token));
}
