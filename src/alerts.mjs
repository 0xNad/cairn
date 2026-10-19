// The alert rules: what a scanned range means for each chat. scanner.mjs reads the chain's Transfer and Approval
// events and groups them by transaction; this module decides which of them each chat sees, and writes one
// message per chat per transaction:
//   In, Out, Between  a transfer from or to an address the chat watches (Between when both are), after the
//                     block the watch began at, unless it is under the chat's floor for its token (/min);
//   Approval          an approval by an owner the chat watches: the spender and the amount, or "unlimited";
//   Whale             a transfer at or above one of the chat's whale thresholds, mints and burns labelled.
// Never alerted: zero transfers (address poisoning), the fee payment (the STRK transfer from the sender to the
// block's sequencer, the transaction's last event), muted tokens, and contracts that are not coins.
// The rules cost nothing; only the events a chat would see cost calls: their block's header (its time and
// sequencer), their token's metadata (tokens.mjs) and, for a possible fee payment, the transaction's sender.
// An event the ledger already holds for a chat (a range scanned again) is not alerted to it again.
import { felt64, NodeValueError } from './felt.mjs';
import { escapeHtml, utc } from './format.mjs';
import { alerted } from './ledger.mjs';
import { tokenAmount, tokenName } from './tokens.mjs';

const ZERO = felt64('0x0');
const UNLIMITED = (1n << 128n) - 1n; // an allowance this large is "unlimited"
const SIZE = 3600; // characters of event lines in one message (Telegram's limit is 4096); the rest are counted
const SEEN = 20; // tokens outside the registry remembered per watch, for /balance

const add = (map, key, value) => (map.get(key) ?? map.set(key, []).get(key)).push(value);

/** The chats' subscriptions, by watched address and by whale token. */
function subscriptions(state) {
  const watched = new Map(), whales = new Map();
  for (const [id, chat] of Object.entries(state.chats)) {
    for (const watch of chat.watches) add(watched, watch.address, { id, chat, watch });
    for (const whale of chat.whales) add(whales, whale.token, { id, chat, whale });
  }
  return { watched, whales };
}

/** The chats that would see `event`, and as what: [{ id, chat, out, in, whale, approval }]. Calls nothing. */
function rules(event, { watched, whales }) {
  const hits = new Map();
  const hit = (id, chat) => hits.get(id) ?? hits.set(id, { id, chat, out: false, in: false, whale: false, approval: false }).get(id);
  const live = (subscription) => event.block > subscription.since_block; // a subscription never covers older blocks
  if (event.kind === 'Approval') {
    for (const { id, chat, watch } of watched.get(event.a) ?? []) if (live(watch)) hit(id, chat).approval = true;
  } else if (event.amount > 0n) {
    for (const { id, chat, watch } of watched.get(event.a) ?? []) if (live(watch)) hit(id, chat).out = true;
    for (const { id, chat, watch } of watched.get(event.b) ?? []) if (live(watch)) hit(id, chat).in = true;
    for (const { id, chat, whale } of whales.get(event.token) ?? []) if (live(whale) && event.amount >= BigInt(whale.min)) hit(id, chat).whale = true;
  }
  return [...hits.values()].filter((h) => {
    if (h.chat.muted.some((m) => m.token === event.token)) return false;
    const floor = h.chat.minimums.find((m) => m.token === event.token);
    if (event.kind === 'Transfer' && floor && event.amount < BigInt(floor.min)) h.out = h.in = false; // whale thresholds still apply
    return h.out || h.in || h.whale || h.approval;
  });
}

/** The watches a transfer's token was seen moving for, outside the chats that muted it (for /balance). */
function sightings(event, { watched }) {
  if (event.kind !== 'Transfer' || event.amount === 0n) return [];
  return [...(watched.get(event.a) ?? []), ...(watched.get(event.b) ?? [])]
    .filter(({ chat, watch }) => event.block > watch.since_block && !chat.muted.some((m) => m.token === event.token))
    .map(({ watch }) => watch);
}

async function blockHeader(rpc, block) {
  const header = await rpc.call('starknet_getBlockWithTxHashes', { block_id: { block_number: block } });
  if (!Number.isSafeInteger(header?.timestamp)) throw new NodeValueError();
  return { timestamp: header.timestamp, sequencer: felt64(header.sequencer_address) };
}

/** The account that pays a transaction's fee: its sender, or the account a DEPLOY_ACCOUNT deploys. */
async function payer(rpc, hash) {
  const tx = await rpc.call('starknet_getTransactionByHash', { transaction_hash: hash });
  if (tx?.type === 'DEPLOY_ACCOUNT') {
    const receipt = await rpc.call('starknet_getTransactionReceipt', { transaction_hash: hash });
    return felt64(receipt?.contract_address ?? '0x0');
  }
  return felt64(tx?.sender_address ?? '0x0'); // an L1 handler has no sender, and pays no fee
}

/**
 * The alerts of a range: [{ chat, tx, block, at, indexes, text }], in chain order, one per chat per transaction,
 * from `groups` (scanner.byTransaction), leaving out the events the ledger already holds. It also records, per
 * watch, the tokens outside the registry seen moving for it. A failed call throws before anything but the token
 * cache has changed: the caller keeps its cursor and scans the range again.
 */
export async function alertsOf(groups, { state, tokens, rpc, link, head }) {
  const index = subscriptions(state);
  const found = [], seen = [];
  for (const group of groups) {
    const chats = new Map(); // chat id → [{ event, out, in, whale, approval }]
    for (const event of group.events) {
      for (const hit of rules(event, index)) if (!alerted(state, hit.id, group.tx, event.index)) add(chats, hit.id, { ...hit, event });
      for (const watch of sightings(event, index)) if (!tokens.verified(event.token)) seen.push({ watch, event });
    }
    if (chats.size) found.push({ group, chats, fee: -1 });
  }

  const coin = (address) => tokens.get(address, head.timestamp); // chain time is the head's
  const headers = new Map();
  const strk = tokens.bySymbol('STRK')?.address;
  for (const entry of found) {
    const { group, chats } = entry;
    if (!headers.has(group.block)) headers.set(group.block, await blockHeader(rpc, group.block));
    for (const items of chats.values()) for (const item of items) item.token = await coin(item.event.token);
    const last = group.events.find((e) => e.index === group.last);
    const shown = (event) => [...chats.values()].some((items) => items.some((item) => item.event === event));
    if (last?.kind === 'Transfer' && last.token === strk && last.b === headers.get(group.block).sequencer && shown(last)
      && last.a === await payer(rpc, group.tx)) entry.fee = last.index;
  }
  const coins = [];
  for (const { watch, event } of seen) if (watch.seen.includes(event.token) || await coin(event.token)) coins.push([watch, event.token]);

  // Every call is done: nothing below can fail.
  for (const [watch, token] of coins) watch.seen = [...watch.seen.filter((t) => t !== token), token].slice(-SEEN);
  const alerts = [];
  for (const { group, chats, fee } of found) {
    const at = headers.get(group.block).timestamp;
    for (const [id, items] of chats) {
      const shown = items.filter((item) => item.token && item.event.index !== fee);
      if (shown.length) alerts.push({ chat: id, tx: group.tx, block: group.block, at, indexes: shown.map((i) => i.event.index), text: message(shown, group, headers.get(group.block), link) });
    }
  }
  return alerts;
}

/** One chat's message for one transaction: a line per event, then the block, its time and the transaction. */
function message(items, group, { timestamp, sequencer }, link) {
  const { chat } = items[0];
  // An address with its label in this chat, if it has one; the block's sequencer says so.
  const who = (address) => {
    const label = address === sequencer ? 'sequencer' : chat.watches.find((w) => w.address === address)?.label;
    return `${label ? `${escapeHtml(label)} ` : ''}${link('contract', address)}`;
  };
  const lines = [];
  let size = 0;
  for (const item of items) {
    const text = line(item, who, link);
    if (lines.length && size + text.length > SIZE) break;
    lines.push(text);
    size += text.length + 1;
  }
  if (lines.length < items.length) lines.push(`…and ${items.length - lines.length} more in this transaction`);
  lines.push(`Block ${group.block} · ${utc(timestamp)} · tx ${link('tx', group.tx)}`);
  return lines.join('\n');
}

function line({ event, token, out, in: incoming, approval }, who, link) {
  const value = tokenAmount(event.amount, token, link);
  if (approval) {
    if (event.amount === 0n) return `🔑 Approval revoked · ${who(event.a)} → spender ${who(event.b)} · ${tokenName(token, link)}`;
    return `🔑 Approval · ${who(event.a)} lets spender ${who(event.b)} spend ${event.amount >= UNLIMITED ? `unlimited ${tokenName(token, link)}` : value}`;
  }
  if (out && incoming) return `↔️ Between · ${value} from ${who(event.a)} to ${who(event.b)}`;
  if (out) return `⬆️ Out · ${who(event.a)} · ${value} ${event.b === ZERO ? 'burned' : `to ${who(event.b)}`}`;
  if (incoming) return `⬇️ In · ${who(event.b)} · ${value} ${event.a === ZERO ? 'minted' : `from ${who(event.a)}`}`;
  if (event.a === ZERO) return `🐋 Whale mint · ${value} to ${who(event.b)}`;
  if (event.b === ZERO) return `🐋 Whale burn · ${value} from ${who(event.a)}`;
  return `🐋 Whale · ${value} from ${who(event.a)} to ${who(event.b)}`;
}
