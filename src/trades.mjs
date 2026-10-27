import { NodeBusy, RpcError } from './errors.mjs';
import { hex64, NodeValueError } from './felt.mjs';
import { decimal, escapeHtml, short, utc } from './format.mjs';
import { atLeast, centsOf, usdText, valueOf } from './prices.mjs';
import { decodeTokenEvents, TOKEN_EVENTS } from './scanner.mjs';
import { balanceOf } from './tokens.mjs';
import { decodeSwaps } from './venues.mjs';

const ZERO = hex64('0x0');
const MAX_PAID = 3; // tokens listed as what a trade paid or got; a route rarely has more than one

/**
 * Round 3's trade feed for the scanner: the venue filters beside round 2's chain-wide Transfer filter, on the
 * same ranges. Each chat has at most one feed, on one token; a trade is found per transaction, as the brief
 * defines, and posted to every chat whose feed it passes, keyed in the ledger by the first swap event it nets.
 */
export function tradeFeed(venues) {
  return Object.freeze({
    filters: [TOKEN_EVENTS, ...venues.map((v) => v.filter)],
    wanted: (interests) => interests.feeds.size > 0 && venues.length > 0,
    find: (events, context) => findTrades(events, venues, context),
  });
}

/** Sums swap legs per token: the trader's net change in each token over those swaps. */
export function netsOf(swaps) {
  const out = new Map();
  for (const swap of swaps) for (const leg of swap.legs) out.set(leg.token, (out.get(leg.token) ?? 0n) + leg.amount);
  return out;
}

/**
 * The trade of `token` in one transaction, from its swaps (every venue) and its token events, or null. The first
 * venue in precedence order whose swaps involve the token nets it over those swaps, and later venues are ignored
 * in that transaction: so an AVNU route through Ekubo counts once, as AVNU. An aggregator's swap involves the
 * token when it sells or buys it, or when the token passed through the aggregator's contract in that
 * transaction, a hop of its route, which nets to zero. A net of zero (a round trip, or a hop) is no trade.
 * Returns { venue, swaps, nets, net }.
 */
export function tradeOf(token, swaps, transfers, venues) {
  for (const venue of venues) {
    const own = swaps.filter((s) => s.venue.key === venue.key);
    if (!own.length) continue;
    const named = own.some((s) => s.legs.some((leg) => leg.token === token));
    const routed = venue.aggregator && transfers.some((t) => t.kind === 'Transfer' && t.token === token && (t.a === venue.address || t.b === venue.address));
    if (!named && !routed) continue;
    const relevant = own.filter(s => s.legs.some(leg => leg.token === token));
    const nets = netsOf(relevant), net = nets.get(token) ?? 0n;
    return net === 0n ? null : { venue, swaps: relevant, nets, net };
  }
  return null;
}

/**
 * The trader, from the token's Transfer events in the transaction, never from its sender: each address's net
 * change in the token, leaving out the fee payment (`fee`, an event index), the zero address and the venue
 * contracts (`excluded`). For a buy, the address with the largest net gain; for a sell, the largest net loss;
 * a tie goes to the address seen at the earliest event_index. Null when no address qualifies.
 */
export function traderOf(token, side, transfers, excluded, fee = null) {
  const flows = new Map();
  for (const t of [...transfers].sort((x, y) => x.index - y.index)) {
    if (t.kind !== 'Transfer' || t.token !== token || t.index === fee) continue;
    for (const [address, change] of [[t.a, -t.amount], [t.b, t.amount]]) {
      if (address === ZERO || excluded.has(address)) continue;
      const flow = flows.get(address) ?? { net: 0n, first: t.index };
      flow.net += change;
      flows.set(address, flow);
    }
  }
  let best = null;
  for (const [address, { net, first }] of flows) {
    const size = side === 'buy' ? net : -net;
    if (size > 0n && (!best || size > best.size || (size === best.size && first < best.first))) best = { address, size, first };
  }
  return best?.address ?? null;
}

/**
 * The fee payment of a transaction, as an event index, or null: the STRK Transfer to the block's
 * sequencer_address that is the transaction's last event. The chain-wide filter holds every Transfer, so the
 * last one Cairn sees is the last event of the transaction whenever it is the fee.
 */
export function feeIndexOf(tx, strk, sequencer) {
  const last = Math.max(...tx.transfers.map((t) => t.index), ...tx.swaps.map((s) => s.index));
  const fee = tx.transfers.find((t) => t.index === last && t.kind === 'Transfer' && t.token === strk && t.b === sequencer);
  return fee ? fee.index : null;
}

/** Every swap and token event of the range, by transaction, for the transactions that hold a swap. */
function transactions(events, venues) {
  const txs = new Map();
  for (const venue of venues) {
    for (const swap of decodeSwaps(venue, events.get(venue.filter) ?? [])) {
      if (!txs.has(swap.tx)) txs.set(swap.tx, { hash: swap.tx, block: swap.block, txIndex: swap.txIndex, swaps: [], transfers: [] });
      txs.get(swap.tx).swaps.push(swap);
    }
  }
  for (const t of decodeTokenEvents(events.get(TOKEN_EVENTS) ?? [])) txs.get(t.tx)?.transfers.push(t);
  const first = (tx) => Math.min(...tx.swaps.map((s) => s.index));
  return [...txs.values()].sort((a, b) => a.block - b.block || (a.txIndex ?? 0) - (b.txIndex ?? 0) || first(a) - first(b));
}

async function findTrades(events, venues, context) {
  const { interests, tokens, now } = context;
  const deliveries = [];
  for (const tx of transactions(events, venues)) {
    for (const [token, feeds] of interests.feeds) {
      const live = feeds.filter((f) => tx.block > f.since);
      if (!live.length) continue;
      const trade = tradeOf(token, tx.swaps, tx.transfers, venues);
      if (!trade) continue;
      const side = trade.net > 0n ? 'buy' : 'sell', amount = trade.net > 0n ? trade.net : -trade.net;
      const wanted = live.filter((f) => (side === 'buy' || f.mode === 'all') && (f.minUnits === null || amount >= f.minUnits));
      if (!wanted.length) continue;
      const meta = await tokens.get(token, now);
      if (!meta) continue; // no longer answers decimals: not a coin Cairn can count
      const post = await valued({ tx, trade, side, amount, token: meta }, context);
      // A dollar floor needs a fresh price to prove the trade reaches it: without one, nothing is posted.
      const passing = wanted.filter((f) => f.minUsd === null || (post.value && atLeast(post.value, f.minUsd)));
      if (!passing.length) continue;
      Object.assign(post, await whoTraded(post, tx, venues, context));
      for (const feed of passing) {
        deliveries.push({
          chatId: feed.chatId, thread: feed.thread, txHash: tx.hash, eventIndex: trade.swaps[0].index, kind: 'trade',
          events: trade.swaps.map((s) => s.index), block: tx.block, chainTime: post.block.timestamp,
          position: [tx.block, tx.txIndex ?? 0, trade.swaps[0].index],
          body: render(post, feed, context.fmt), digest: digest(post),
        });
      }
    }
  }
  return { deliveries };
}

/**
 * A trade with its block, what was paid (for a buy) or got (for a sell), and its USD value, from fresh prices
 * only and never for an unverified token. Read once for every chat that gets the post.
 */
async function valued({ tx, trade, side, amount, token }, { tokens, prices, now, header }) {
  const block = await header(tx.block);
  const others = [];
  for (const [address, net] of trade.nets) {
    if (address === token.address || (side === 'buy' ? net >= 0n : net <= 0n) || others.length >= MAX_PAID) continue;
    const meta = await tokens.get(address, now);
    if (meta) others.push({ token: meta, amount: net < 0n ? -net : net });
  }
  const value = token.verified ? await valueOfTrade(amount, token, others, block, prices) : null;
  return { tx: tx.hash, venue: trade.venue, side, amount, token, others, value, block };
}

/**
 * Who traded: the trader from the token's transfers, their verified name, and whether they held none of the
 * token at the end of the previous block (buys only: a seller holds less after the trade, not more).
 */
async function whoTraded(post, tx, venues, { tokens, names, rpc, now }) {
  const excluded = new Set(venues.map((v) => v.address));
  const fee = post.token.address === tokens.strk ? feeIndexOf(tx, tokens.strk, post.block.sequencer) : null;
  const trader = traderOf(post.token.address, post.side, tx.transfers, excluded, fee);
  if (!trader) return { trader: null, name: null, newHolder: false };
  return { trader, name: await names.display(trader, now),
    newHolder: post.side === 'buy' ? await heldNone(rpc, post.token.address, trader, tx.block) : false };
}

/** The trade's USD value, exactly: the token's own fresh price, or else the fresh prices of what was paid or got. */
async function valueOfTrade(amount, token, others, block, prices) {
  const own = await prices.usd(token, block);
  if (own) return valueOf(amount, token.decimals, own);
  if (!others.length) return null;
  let total = { num: 0n, den: 1n };
  for (const o of others) {
    const sample = await prices.usd(o.token, block);
    if (!sample) return null;
    const v = valueOf(o.amount, o.token.decimals, sample);
    total = total.den >= v.den ? { num: total.num + v.num * (total.den / v.den), den: total.den } : { num: total.num * (v.den / total.den) + v.num, den: v.den };
  }
  return total;
}

/** Whether `owner` held none of `token` at the end of the block before `block`; false when the node cannot say. */
async function heldNone(rpc, token, owner, block) {
  if (block < 1) return false;
  try { return (await balanceOf(rpc, token, owner, { block_number: block - 1 })) === 0n; }
  catch (error) {
    if (error instanceof RpcError || error instanceof NodeBusy || error instanceof NodeValueError) return false;
    throw error;
  }
}

// Half-decades of US dollars: the size bar grows by one dot at $10, $30, $100, $300, $1,000 … $1,000,000.
const STEPS = [10n, 30n, 100n, 300n, 1_000n, 3_000n, 10_000n, 30_000n, 100_000n, 300_000n, 1_000_000n].map((d) => d * 100n);
const WHALE = 100_000n * 100n;

/**
 * One dot per half-decade of USD value, green for a buy and red for a sell, so a feed reads by size at a glance;
 * a trade with no USD value grows with its amount over the chat's floor instead.
 */
export function sizeBar(side, cents, amount, floor) {
  let dots = 1;
  if (cents !== null) dots += STEPS.filter((s) => cents >= s).length;
  else if (floor) dots += [3n, 10n, 30n, 100n, 300n, 1000n].filter((m) => amount >= floor * m).length;
  return `${(side === 'buy' ? '🟢' : '🔴').repeat(dots)}${cents !== null && cents >= WHALE ? ' 🐋' : ''}`;
}

/**
 * A chat's post, four short lines that read at a glance on a phone: the size bar, the side and the USD value;
 * the exact amount and what was paid (or got) for it; the trader; the venue, the block time and the link.
 */
function render(post, feed, fmt) {
  const { token, side, amount, others, value, trader, name, newHolder, block } = post;
  const cents = value ? centsOf(value) : null;
  const symbol = token.verified ? escapeHtml(token.symbol) : `<code>${escapeHtml(token.symbol)}</code>`;
  const worth = value ? ` · ≈${escapeHtml(usdText(value))}` : '';
  const lines = [sizeBar(side, cents, amount, feed.minUnits), `<b>${side === 'buy' ? 'Buy' : 'Sell'}</b> ${fmt.token(token)}${worth}`];
  const paid = others.map((o) => `${decimal(o.amount, o.token.decimals)} ${fmt.token(o.token)}`).join(' + ');
  lines.push(`${decimal(amount, token.decimals)} ${symbol}${paid ? ` for ${paid}` : ''}`);
  if (trader) lines.push(`👤 ${fmt.contract(trader, name ? escapeHtml(name) : short(trader))}${newHolder ? ' · 🆕 new holder' : ''}`);
  lines.push(`${post.venue.name} · ${utc(block.timestamp)} · ${fmt.tx(post.tx, 'Tx')}`);
  return lines.join('\n');
}

/** What a group's summary needs to count this post among others. */
const digest = (post) => ({ k: 'trade', side: post.side, token: post.token.address, symbol: post.token.symbol,
  verified: post.token.verified, decimals: post.token.decimals, amount: String(post.amount),
  cents: post.value ? String(centsOf(post.value)) : null, value: post.value ? [String(post.value.num), String(post.value.den)] : null });
