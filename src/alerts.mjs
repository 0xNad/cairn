import { hex64, U128, unsigned } from './felt.mjs';
import { decimal, escapeHtml, short, utc } from './format.mjs';
import { centsOf, usdText, valueOf } from './prices.mjs';
import { blockHeaders, decodeTokenEvents, TOKEN_EVENTS } from './scanner.mjs';

/**
 * Round 2's feed for the scanner: the chain-wide Transfer/Approval filter and the alert rules below. A feed
 * says what to read from each range and turns it into deliveries; round 3's trade feed (src/trades.mjs) sits
 * beside this one and reads the same ranges, this filter included.
 */
export const walletAlerts = Object.freeze({
  filters: [TOKEN_EVENTS],
  wanted: (interests) => !interests.empty,
  find: (events, context) => findAlerts(decodeTokenEvents(events.get(TOKEN_EVENTS) ?? []), context),
});

const ZERO = hex64('0x0');
const UNLIMITED = U128 - 1n; // an approval of at least 2^128 − 1 is shown as unlimited
const MAX_ITEMS = 10; // lines per message: a busy transaction does not bury the reader

/**
 * The alert rules, apart from the scanner that reads the ranges: which chats care about which token events,
 * and the one message each chat gets per transaction (per forum topic, from round 3: each event posts into the
 * topic of the watch that matched it, or else of the whale alert). Returns { deliveries, seen }: deliveries for
 * the ledger, in chain order, and [chat, address, token] for the tokens seen moving for a watched address.
 *
 * Never alerted: zero-amount transfers (address poisoning), the fee payment, transfers under the chat's /min,
 * muted tokens, contracts that are not coins, and anything at or before a subscription's since_block.
 * Extra calls happen only for events some chat cares about: token metadata, block headers, the fee rule, and
 * from round 3 the USD price of a verified token and the verified names of the addresses shown.
 */
export async function findAlerts(events, { interests, tokens, rpc, now, fmt, header = blockHeaders(rpc), prices = null, names = null, known = new Map() }) {
  const candidates = [];
  for (const ev of events) {
    const roles = new Map();
    const role = (chatId) => roles.get(chatId) ?? roles.set(chatId, {}).get(chatId);
    const mark = (chatId, kind, thread) => { const r = role(chatId); r[kind] = true; if (!(`${kind}Thread` in r)) r[`${kind}Thread`] = thread; };
    if (ev.kind === 'Transfer') {
      if (ev.amount === 0n) continue;
      for (const w of interests.watchers.get(ev.a) ?? []) if (ev.block > w.since) mark(w.chatId, 'from', w.thread);
      for (const w of interests.watchers.get(ev.b) ?? []) if (ev.block > w.since) mark(w.chatId, 'to', w.thread);
      for (const w of interests.whales.get(ev.token) ?? []) if (ev.block > w.since && ev.amount >= w.units) mark(w.chatId, 'whale', w.thread);
    } else {
      for (const w of interests.watchers.get(ev.a) ?? []) if (ev.block > w.since) mark(w.chatId, 'approval', w.thread);
    }
    if (roles.size) candidates.push({ ev, roles });
  }
  const meta = new Map();
  for (const { ev } of candidates) if (!meta.has(ev.token)) meta.set(ev.token, await tokens.get(ev.token, now));
  const seen = [], kept = [];
  for (const c of candidates) {
    const token = meta.get(c.ev.token);
    if (!token) continue; // not a coin: a legacy NFT, a bad decimals answer, or no contract
    for (const [chatId, r] of [...c.roles]) {
      if (c.ev.kind === 'Transfer' && !token.verified) {
        if (r.from) seen.push([chatId, c.ev.a, c.ev.token]);
        if (r.to) seen.push([chatId, c.ev.b, c.ev.token]);
      }
      if (interests.muted.has(`${chatId} ${c.ev.token}`)) { c.roles.delete(chatId); continue; }
      const floor = interests.floors.get(`${chatId} ${c.ev.token}`);
      if (c.ev.kind === 'Transfer' && floor !== undefined && c.ev.amount < floor) r.from = r.to = false;
      if (!r.from && !r.to && !r.whale && !r.approval) c.roles.delete(chatId);
    }
    if (c.roles.size) kept.push({ ...c, token });
  }
  const headers = new Map(), facts = new Map(), alertable = [];
  for (const { ev } of kept) if (!headers.has(ev.block)) headers.set(ev.block, await header(ev.block));
  for (const c of kept) if (!(await isFee(c.ev, headers.get(c.ev.block), tokens.strk, rpc, facts))) alertable.push(c);

  // Round 3: the USD value of each transfer of a verified token, from a fresh price at its block.
  const usd = new Map();
  for (const { ev, token } of alertable) {
    if (ev.kind !== 'Transfer' || !prices) continue;
    const sample = await prices.usd(token, headers.get(ev.block));
    if (sample) usd.set(ev, valueOf(ev.amount, token.decimals, sample));
  }
  const groups = new Map();
  for (const c of alertable) {
    for (const [chatId, role] of c.roles) {
      const thread = (role.from ? role.fromThread : role.to ? role.toThread : role.approval ? role.approvalThread : role.whaleThread) ?? null;
      const key = `${chatId} ${thread} ${c.ev.tx}`;
      if (!groups.has(key)) groups.set(key, { chatId, thread, tx: c.ev.tx, block: c.ev.block, txIndex: c.ev.txIndex, items: [] });
      groups.get(key).items.push({ ev: c.ev, token: c.token, role, usd: usd.get(c.ev) ?? null });
    }
  }
  // Round 3: an address without the chat's label reads as its verified .stark name, where it has one.
  const shown = new Map();
  for (const g of groups.values()) {
    const labels = interests.labels.get(g.chatId) ?? new Map();
    for (const { ev } of g.items) {
      for (const address of [ev.a, ev.b]) {
        if (address === ZERO || shown.has(address) || labels.get(address) || known.has(address)) continue;
        shown.set(address, names ? await names.display(address, now) : null);
      }
    }
  }
  const deliveries = [...groups.values()].map((g) => ({
    chatId: g.chatId, thread: g.thread, txHash: g.tx, eventIndex: g.items[0].ev.index, kind: 'alert', events: g.items.map((i) => i.ev.index),
    block: g.block, chainTime: headers.get(g.block).timestamp, position: [g.block, g.txIndex ?? 0, g.items[0].ev.index],
    body: render(g, headers.get(g.block).timestamp, interests.labels.get(g.chatId) ?? new Map(), { fmt, shown, known }),
    digest: { k: 'alert', whale: g.items.some((i) => i.role.whale), approval: g.items.some((i) => i.ev.kind === 'Approval'), cents: largestCents(g.items) },
  }));
  return { deliveries, seen };
}

/** The largest USD value among an alert's lines, in cents, or null: what a group's budget weighs it by. */
function largestCents(items) {
  const cents = items.filter((i) => i.usd).map((i) => centsOf(i.usd));
  return cents.length ? String(cents.reduce((a, b) => (b > a ? b : a))) : null;
}

/**
 * The fee payment: the STRK Transfer from the transaction's sender to the block's sequencer_address, the last
 * event of its transaction, for the receipt's actual fee. Only such a candidate costs the two lookups. A
 * failed lookup fails the range, which the next pass reads again: a busy node never turns a fee into an alert.
 */
async function isFee(ev, block, strk, rpc, cache) {
  if (ev.kind !== 'Transfer' || ev.token !== strk || ev.b !== block.sequencer) return false;
  if (!cache.has(ev.tx)) {
    const receipt = await rpc.call('starknet_getTransactionReceipt', { transaction_hash: ev.tx });
    const tx = await rpc.call('starknet_getTransactionByHash', { transaction_hash: ev.tx });
    cache.set(ev.tx, {
      last: Array.isArray(receipt?.events) ? receipt.events.length - 1 : -1,
      fee: receipt?.actual_fee?.unit === 'FRI' ? unsigned(receipt.actual_fee.amount) : null,
      // A DEPLOY_ACCOUNT transaction pays from the account it deploys, which only its receipt names.
      sender: hex64(tx?.sender_address ?? tx?.contract_address ?? receipt?.contract_address ?? '0x0'),
    });
  }
  const fact = cache.get(ev.tx);
  return ev.index === fact.last && ev.a === fact.sender && ev.amount === fact.fee;
}

/** One chat's message for one transaction: a line per matching event, then where and when. */
function render(group, time, labels, { fmt, shown, known }) {
  const name = (address) => {
    if (labels.get(address)) return fmt.contract(address, escapeHtml(labels.get(address)));
    const text = known.get(address) ?? shown.get(address);
    return fmt.contract(address, text ? escapeHtml(text) : short(address));
  };
  const items = routes(group.items);
  const lines = items.slice(0, MAX_ITEMS).map((item) => line(item, name, fmt));
  if (items.length > MAX_ITEMS) lines.push(`… and ${items.length - MAX_ITEMS} more in this transaction.`);
  lines.push(`Block ${group.block} · ${utc(time)} · ${fmt.tx(group.tx, 'View transaction')}`);
  return lines.join('\n');
}

/**
 * A whale amount routed through pools moves in hops (A to a router, the router to B): consecutive whale-only
 * transfers of the same token and amount, each starting where the last ended, read as one line from A to B.
 * Watch lines are never merged: each transfer of a watched address is its own line.
 */
function routes(items) {
  const out = [];
  for (const item of items) {
    const last = out.at(-1);
    const whaleOnly = (i) => i.ev.kind === 'Transfer' && i.role.whale && !i.role.from && !i.role.to;
    if (last && whaleOnly(last) && whaleOnly(item) && last.ev.token === item.ev.token && last.ev.amount === item.ev.amount && last.to === item.ev.a) {
      out[out.length - 1] = { ...last, to: item.ev.b, hops: last.hops + 1 };
    } else out.push({ ...item, to: item.ev.b, hops: 1 });
  }
  return out;
}

function line({ ev, token, role, usd, to: end = ev.b, hops = 1 }, name, fmt) {
  const symbol = fmt.token(token), value = decimal(ev.amount, token.decimals);
  if (ev.kind === 'Approval') {
    if (ev.amount === 0n) return `🔑 <b>Approval</b> revoked: ${name(ev.a)} no longer lets spender ${name(ev.b)} spend ${symbol}`;
    return `🔑 <b>Approval</b>: ${name(ev.a)} lets spender ${name(ev.b)} spend ${ev.amount >= UNLIMITED ? 'unlimited' : value} ${symbol}`;
  }
  const worth = usd ? ` (≈${escapeHtml(usdText(usd))})` : '';
  const whale = role.whale ? ' 🐋' : '';
  const from = ev.a === ZERO ? 'a mint' : name(ev.a), to = ev.b === ZERO ? 'a burn' : name(ev.b);
  if (role.from && role.to) return `⇄ <b>Between</b> ${value} ${symbol}${worth} from ${from} to ${to}${whale}`;
  if (role.to) return `↓ <b>In</b> +${value} ${symbol}${worth} to ${to} from ${from}${whale}`;
  if (role.from) return `↑ <b>Out</b> −${value} ${symbol}${worth} from ${from} to ${to}${whale}`;
  const via = hops > 1 ? ` (${hops} hops)` : '';
  const last = end === ZERO ? 'a burn' : name(end);
  if (ev.a === ZERO) return `🐋 <b>Mint</b> ${value} ${symbol}${worth} to ${last}${via}`;
  if (end === ZERO) return `🐋 <b>Burn</b> ${value} ${symbol}${worth} from ${from}${via}`;
  return `🐋 <b>Whale</b> ${value} ${symbol}${worth} from ${from} to ${last}${via}`;
}
