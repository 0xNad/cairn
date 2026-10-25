import { hex64, NodeValueError, U128, unsigned } from './felt.mjs';
import { usdValue } from './prices.mjs';
import { decimal, escapeHtml, short, utc } from './format.mjs';
import { decodeTokenEvents, TOKEN_EVENTS } from './scanner.mjs';

/**
 * Round 2's feed for the scanner: the chain-wide Transfer/Approval filter and the alert rules below. A feed
 * says what to read from each range and turns it into deliveries; round 3's venue feeds sit beside this one
 * and read the same ranges with their own filter.
 */
export const walletAlerts = Object.freeze({
  filter: TOKEN_EVENTS,
  wanted: (interests) => !interests.empty,
  find: (raw, context) => findAlerts(decodeTokenEvents(raw), context),
});

const ZERO = hex64('0x0');
const UNLIMITED = U128 - 1n; // an approval of at least 2^128 − 1 is shown as unlimited
const MAX_ITEMS = 10; // lines per message: a busy transaction does not bury the reader

/**
 * The alert rules, apart from the scanner that reads the ranges: which chats care about which token events,
 * and the one message each chat gets per transaction. Returns { deliveries, seen }: deliveries for the ledger,
 * in chain order, and [chat, address, token] for the tokens seen moving for a watched address.
 *
 * Never alerted: zero-amount transfers (address poisoning), the fee payment, transfers under the chat's /min,
 * muted tokens, contracts that are not coins, and anything at or before a subscription's since_block.
 * Extra calls happen only for events some chat cares about: token metadata, block headers, and the fee rule.
 */
export async function findAlerts(events, { interests, tokens, rpc, now, fmt, prices, names, head }) {
  const candidates = [];
  for (const ev of events) {
    const roles = new Map();
    const role = (w) => {
      const key = `${w.chatId}:${w.topic ?? 0}`;
      if (!roles.has(key)) roles.set(key, { chatId: w.chatId, topic: w.topic ?? 0 });
      return roles.get(key);
    };
    if (ev.kind === 'Transfer') {
      if (ev.amount === 0n) continue;
      for (const w of interests.watchers.get(ev.a) ?? []) if (ev.block > w.since) role(w).from = true;
      for (const w of interests.watchers.get(ev.b) ?? []) if (ev.block > w.since) role(w).to = true;
      for (const w of interests.whales.get(ev.token) ?? []) if (ev.block > w.since && ev.amount >= w.units) role(w).whale = true;
    } else {
      for (const w of interests.watchers.get(ev.a) ?? []) if (ev.block > w.since) role(w).approval = true;
    }
    if (roles.size) candidates.push({ ev, roles });
  }
  const meta = new Map();
  for (const { ev } of candidates) if (!meta.has(ev.token)) meta.set(ev.token, await tokens.get(ev.token, now));
  const seen = [], kept = [];
  for (const c of candidates) {
    const token = meta.get(c.ev.token);
    if (!token) continue; // not a coin: a legacy NFT, a bad decimals answer, or no contract
    for (const [roleKey, r] of [...c.roles]) {
      const chatId = r.chatId;
      if (c.ev.kind === 'Transfer' && !token.verified) {
        if (r.from) seen.push([chatId, c.ev.a, c.ev.token]);
        if (r.to) seen.push([chatId, c.ev.b, c.ev.token]);
      }
      if (interests.muted.has(`${chatId} ${c.ev.token}`)) { c.roles.delete(roleKey); continue; }
      const floor = interests.floors.get(`${chatId} ${c.ev.token}`);
      if (c.ev.kind === 'Transfer' && floor !== undefined && c.ev.amount < floor) r.from = r.to = false;
      if (!r.from && !r.to && !r.whale && !r.approval) c.roles.delete(roleKey);
    }
    if (c.roles.size) kept.push({ ...c, token });
  }
  const headers = new Map(), facts = new Map(), alertable = [];
  for (const { ev } of kept) if (!headers.has(ev.block)) headers.set(ev.block, await header(rpc, ev.block));
  for (const c of kept) if (!(await isFee(c.ev, headers.get(c.ev.block), tokens.strk, rpc, facts))) alertable.push(c);

  const groups = new Map();
  for (const c of alertable) {
    for (const role of c.roles.values()) {
      const { chatId, topic } = role;
      const key = `${chatId} ${c.ev.tx} ${topic}`;
      if (!groups.has(key)) groups.set(key, { chatId, topic, tx: c.ev.tx, block: c.ev.block, items: [] });
      groups.get(key).items.push({ ev: c.ev, token: c.token, role });
    }
  }
  const resolvedNames = new Map();
  for (const c of alertable) {
    c.usd = c.ev.kind === 'Transfer' && prices ? usdValue(c.ev.amount, c.token,
      await prices.get(c.token, now, head ? { block_number: head.block_number } : 'latest')) : null;
    if (names) for (const address of [c.ev.a, c.ev.b]) if (address !== ZERO && !resolvedNames.has(address)) {
      resolvedNames.set(address, await names.reverse(address, { block_number: c.ev.block }));
    }
  }
  // Items refer to the same token event; carry price enrichment into rendered routes.
  const usdByEvent = new Map(alertable.map(c => [c.ev, c.usd]));
  for (const g of groups.values()) for (const item of g.items) item.usd = usdByEvent.get(item.ev);
  const deliveries = [...groups.values()].map((g) => ({
    chatId: g.chatId, topic: g.topic, txHash: g.tx, eventIndex: g.items[0].ev.index, kind: 'alert', events: g.items.map((i) => i.ev.index),
    block: g.block, chainTime: headers.get(g.block).timestamp,
    body: render(g, headers.get(g.block).timestamp, interests.labels.get(g.chatId) ?? new Map(), fmt, resolvedNames),
  }));
  return { deliveries, seen };
}

async function header(rpc, number) {
  const block = await rpc.call('starknet_getBlockWithTxHashes', { block_id: { block_number: number } });
  if (!Number.isSafeInteger(block?.timestamp)) throw new NodeValueError();
  return { timestamp: block.timestamp, sequencer: hex64(block.sequencer_address ?? '0x0') };
}

/**
 * The fee payment: the final STRK Transfer to the block's sequencer_address, the last
 * event of its transaction, for the receipt's actual fee. Only such a candidate costs a receipt lookup. A
 * failed lookup fails the range, which the next pass reads again: a busy node never turns a fee into an alert.
 */
async function isFee(ev, block, strk, rpc, cache) {
  if (ev.kind !== 'Transfer' || ev.token !== strk || ev.b !== block.sequencer) return false;
  if (!cache.has(ev.tx)) {
    const receipt = await rpc.call('starknet_getTransactionReceipt', { transaction_hash: ev.tx });
    cache.set(ev.tx, {
      last: Array.isArray(receipt?.events) ? receipt.events.length - 1 : -1,
      fee: receipt?.actual_fee?.unit === 'FRI' ? unsigned(receipt.actual_fee.amount) : null,

    });
  }
  const fact = cache.get(ev.tx);
  return ev.index === fact.last && ev.amount === fact.fee;
}

/** One chat's message for one transaction: a line per matching event, then where and when. */
function render(group, time, labels, fmt, names = new Map()) {
  const name = (address) => labels.has(address)
    ? fmt.contract(address, labels.get(address) ? escapeHtml(labels.get(address)) : names.get(address) ? escapeHtml(names.get(address)) : short(address))
    : fmt.contract(address, names.get(address) ? escapeHtml(names.get(address)) : undefined);
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
  const symbol = `${fmt.token(token)}${usd ? ` · ≈ ${escapeHtml(usd)}` : ''}`, value = decimal(ev.amount, token.decimals);
  if (ev.kind === 'Approval') {
    if (ev.amount === 0n) return `🔑 <b>Approval</b> revoked: ${name(ev.a)} no longer lets spender ${name(ev.b)} spend ${symbol}`;
    return `🔑 <b>Approval</b>: ${name(ev.a)} lets spender ${name(ev.b)} spend ${ev.amount >= UNLIMITED ? 'unlimited' : value} ${symbol}`;
  }
  const whale = role.whale ? ' 🐋' : '';
  const from = ev.a === ZERO ? 'a mint' : name(ev.a), to = ev.b === ZERO ? 'a burn' : name(ev.b);
  if (role.from && role.to) return `⇄ <b>Between</b> ${value} ${symbol} from ${from} to ${to}${whale}`;
  if (role.to) return `↓ <b>In</b> +${value} ${symbol} to ${to} from ${from}${whale}`;
  if (role.from) return `↑ <b>Out</b> −${value} ${symbol} from ${from} to ${to}${whale}`;
  const via = hops > 1 ? ` (${hops} hops)` : '';
  const last = end === ZERO ? 'a burn' : name(end);
  if (ev.a === ZERO) return `🐋 <b>Mint</b> ${value} ${symbol} to ${last}${via}`;
  if (end === ZERO) return `🐋 <b>Burn</b> ${value} ${symbol} from ${from}${via}`;
  return `🐋 <b>Whale</b> ${value} ${symbol} from ${from} to ${last}${via}`;
}
