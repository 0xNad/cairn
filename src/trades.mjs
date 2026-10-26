import { header } from './alerts.mjs';
import { hex64 } from './felt.mjs';
import { decimal, escapeHtml, short, utc } from './format.mjs';
import { atLeastUsd, usdValue } from './prices.mjs';
import { decodeTokenEvents, TOKEN_EVENTS } from './scanner.mjs';
import { balanceOf } from './tokens.mjs';
import { decodeSwaps, enabledVenues, findTrader, netTrade, venueFilter } from './venues.mjs';

const ZERO = hex64('0x0');

/**
 * Round 3's trade feed for the scanner. It reads one filter per configured venue, plus round 2's chain-wide
 * Transfer filter (shared with the wallet alerts, read once per range) for the trader and the fee rule.
 */
export const tradeFeed = Object.freeze({
  reads: (config) => [{ key: 'transfers', filter: TOKEN_EVENTS }, ...enabledVenues(config).map((v) => ({ key: v.name, filter: venueFilter(v) }))],
  wanted: (interests, config) => interests.feeds.size > 0 && enabledVenues(config).length > 0,
  find: (sources, context) => findTrades(sources, context),
});

/**
 * Every feed post in a range: per transaction and fed token, the netted trade (venues.mjs), kept for each
 * chat whose side, token floor and dollar floor it meets. A dollar floor needs a fresh price, so a stale or
 * missing price never posts. Extra calls happen only for trades some chat will see: the block header, the
 * trader's balance in the previous block, and the trader's reverse name.
 */
export async function findTrades(sources, { interests, tokens, rpc, now, fmt, config, quotes, names }) {
  const venues = enabledVenues(config);
  const swaps = venues.flatMap((v) => decodeSwaps(v, sources.get(v.name)));
  if (!swaps.length) return { deliveries: [] };
  const transfers = decodeTokenEvents(sources.get('transfers') ?? []).filter((e) => e.kind === 'Transfer');
  const excluded = new Set([ZERO, ...venues.map((v) => v.address)]);
  const byTx = new Map();
  for (const s of swaps) (byTx.get(s.tx) ?? byTx.set(s.tx, []).get(s.tx)).push(s);
  const headers = new Map(), deliveries = [];
  for (const [tx, txSwaps] of byTx) {
    const block = txSwaps[0].block;
    for (const [token, feeds] of interests.feeds) {
      const trade = netTrade(txSwaps, token);
      if (!trade || trade.net === 0n) continue;
      const side = trade.net > 0n ? 'buy' : 'sell', amount = side === 'buy' ? trade.net : -trade.net;
      let chats = feeds.filter((f) => block > f.since && (side === 'buy' || f.sells) && amount >= f.units);
      if (!chats.length) continue;
      const meta = await tokens.get(token, now);
      if (!meta) continue;
      const quote = meta.verified ? await quotes.fresh(meta) : null;
      chats = chats.filter((f) => f.cents === null || (quote !== null && atLeastUsd(amount, meta.decimals, quote, f.cents)));
      if (!chats.length) continue;
      if (!headers.has(block)) headers.set(block, await header(rpc, block));
      const head = headers.get(block);
      // The fee payment goes to the block's sequencer: it is never the trade.
      const own = transfers.filter((e) => e.tx === tx && e.token === token && !(e.token === tokens.strk && e.b === head.sequencer));
      const trader = findTrader(own, side, excluded);
      const post = {
        side, amount, token: meta, venue: trade.venue.name, block, time: head.timestamp, tx, quote,
        paid: trade.paid && { token: await tokens.get(trade.paid[0], now), amount: trade.paid[1] < 0n ? -trade.paid[1] : trade.paid[1] },
        trader, name: trader && names ? await names.reverse(trader) : null,
        newHolder: trader !== null && (await wasEmpty(rpc, token, trader, block)),
      };
      const body = render(post, fmt);
      for (const f of chats) {
        deliveries.push({ chatId: f.chatId, txHash: tx, eventIndex: trade.index, kind: 'trade', block, chainTime: head.timestamp, body, thread: f.thread });
      }
    }
  }
  return { deliveries };
}

/** "New holder": the trader held none of the token in the previous block. A failed read never says so. */
async function wasEmpty(rpc, token, owner, block) {
  if (block < 1) return false;
  try { return (await balanceOf(rpc, token, owner, { block_number: block - 1 })) === 0n; }
  catch { return false; }
}

/** One feed post: side, exact amount, what was paid, an approximate USD value, the trader, venue, time, link. */
function render(p, fmt) {
  const symbol = fmt.token(p.token);
  const verb = p.side === 'buy' ? '🟢 <b>Buy</b>' : '🔴 <b>Sell</b>';
  const counter = p.paid?.token ? ` for ${decimal(p.paid.amount, p.paid.token.decimals)} ${fmt.token(p.paid.token)}` : '';
  const usd = p.quote ? ` · ≈ $${usdValue(p.amount, p.token.decimals, p.quote)}` : '';
  const lines = [`${verb} ${decimal(p.amount, p.token.decimals)} ${symbol}${counter}${usd}`];
  if (p.trader) lines.push(`👤 ${fmt.contract(p.trader, p.name ? escapeHtml(p.name) : short(p.trader))}${p.newHolder ? ' · 🆕 new holder' : ''}`);
  lines.push(`${escapeHtml(p.venue)} · Block ${p.block} · ${utc(p.time)} · ${fmt.tx(p.tx, 'View transaction')}`);
  return lines.join('\n');
}
