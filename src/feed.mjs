import { header, isFee } from './alerts.mjs';
import { hex64 } from './felt.mjs';
import { decimal, escapeHtml, parseDecimal, utc } from './format.mjs';
import { balanceOf } from './tokens.mjs';
import { netTrade } from './venues.mjs';

/** Largest directional net transfer wins; chain event order breaks ties. Fee events are removed upstream. */
export function selectTrader(events, token, net, excluded = []) {
  const omit = new Set([hex64('0x0'), ...excluded]), flows = new Map();
  for (const e of events) {
    if (e.kind !== 'Transfer' || e.token !== token || e.amount === 0n) continue;
    for (const [address, delta] of [[e.a, -e.amount], [e.b, e.amount]]) {
      if (omit.has(address)) continue;
      const old = flows.get(address) ?? { net: 0n, index: e.index };
      flows.set(address, { net: old.net + delta, index: Math.min(old.index, e.index) });
    }
  }
  const side = net > 0n ? 1n : -1n;
  return [...flows].filter(([, f]) => f.net * side > 0n).sort((a, b) => {
    const difference = (b[1].net - a[1].net) * side;
    return difference > 0n ? 1 : difference < 0n ? -1 : a[1].index - b[1].index;
  })[0]?.[0] ?? null;
}

export async function feedCommand(command, ctx) {
  const say = value => () => ({ lines: [value] });
  if (ctx.chat.type !== 'private' && !(await ctx.admin())) return say('Only a group administrator can change the feed.');
  if (command.name === 'unfeed') {
    return () => { ctx.subs.unfeed(ctx.chat.id); return { lines: ['Trade feed stopped.'] }; };
  }
  if (!ctx.config.contracts.ekubo_core && !ctx.config.contracts.avnu_exchange) return say('/feed is unavailable: no venue contract is configured.');
  const args = command.argument.split(/\s+/).filter(Boolean), tokenArg = args.shift();
  let side = 'buys', min = '0';
  if (['all', 'buys'].includes(args.at(-1))) side = args.pop();
  if (args.length) min = args.shift();
  if (!tokenArg || args.length) return say('Usage: /feed &lt;SYMBOL|address&gt; [minimum|$usd] [buys|all].');
  if (!ctx.head) return say('node busy: feed unavailable.');
  const result = await ctx.tokens.resolve(tokenArg, ctx.head.timestamp);
  if (result.error) return say(escapeHtml(result.error));
  const token = result.token, usd = min.startsWith('$');
  if (usd && (!token.verified || !token.pragma_pair || !ctx.config.contracts.pragma)) return say('USD floors are unavailable for this token: a verified oracle pair and Pragma contract are required.');
  const parsed = parseDecimal(usd ? min.slice(1) : min, usd ? 18 : token.decimals);
  if (parsed.error) return say(escapeHtml(parsed.error));
  return () => {
    ctx.subs.feed(ctx.chat, token.address, parsed.units, usd, side, ctx.head.block_number, ctx.topic);
    return { lines: [`Trade feed: ${ctx.fmt.token(token)} · ${side} · minimum ${usd ? '$' : ''}${escapeHtml(parsed.text)}.`] };
  };
}

/** Logarithmic size dots from rational USD, or from doublings of the token minimum. */
export function sizeDots(amount, minimum = 0n, usd = null) {
  let dots = 1;
  if (usd) {
    const squared = usd.numerator * usd.numerator;
    for (let threshold = 1000n * usd.denominator * usd.denominator; dots < 10 && squared >= threshold; threshold *= 10n) dots++;
  } else if (minimum > 0n) {
    for (let threshold = minimum * 2n; dots < 10 && amount >= threshold; threshold *= 2n) dots++;
  }
  return dots;
}

/** Turns venue trades and the range's existing token events into deliveries for the shared ledger. */
export async function findTrades(swaps, transfers, ctx) {
  const { subs, tokens, rpc, now, fmt, config, prices, names } = ctx;
  const byTx = new Map(), transfersByTx = new Map(), deliveries = [], feeds = subs.feeds();
  for (const ev of transfers) {
    if (!transfersByTx.has(ev.tx)) transfersByTx.set(ev.tx, []);
    transfersByTx.get(ev.tx).push(ev);
  }
  const headers = ctx.headers ?? new Map(), facts = ctx.facts ?? new Map();
  for (const e of swaps) {
    if (!byTx.has(e.tx)) byTx.set(e.tx, []);
    byTx.get(e.tx).push(e);
  }
  for (const [tx, events] of byTx) {
    const block = events[0].block;
    // These caches live for one transaction: enrichment is per token, trader facts also include the side.
    const trades = new Map(), details = new Map(), traders = new Map();
    for (const feed of feeds) {
      if (block <= feed.since_block) continue;
      if (!trades.has(feed.token)) {
        const trade = netTrade(events, feed.token), amount = trade.net < 0n ? -trade.net : trade.net;
        const token = amount ? await tokens.get(feed.token, now) : null;
        const sample = token ? await prices.get(token, now) : null;
        trades.set(feed.token, { trade, amount, token, sample });
      }
      const { trade, amount, token, sample } = trades.get(feed.token);
      if (!amount || !token || (trade.net < 0n && feed.side !== 'all')) continue;
      if (feed.usd) {
        if (!sample?.fresh || amount * sample.price * 10n ** 18n < BigInt(feed.minimum) * 10n ** BigInt(token.decimals + sample.decimals)) continue;
      } else if (amount < BigInt(feed.minimum)) continue;
      if (!headers.has(block)) headers.set(block, await header(rpc, block));
      const h = headers.get(block);
      if (!details.has(feed.token)) {
        const clean = [], paid = [];
        for (const ev of transfersByTx.get(tx) ?? []) if (ev.token === feed.token && !(await isFee(ev, h, tokens.strk, rpc, facts))) clean.push(ev);
        for (const [address, delta] of trade.deltas) {
          if (address === feed.token || delta === 0n) continue;
          const counter = await tokens.get(address, now);
          if (counter) paid.push(`${decimal(delta < 0n ? -delta : delta, counter.decimals)} ${fmt.token(counter)}`);
        }
        details.set(feed.token, { clean, paid: paid.join(' + ') || 'unavailable', usd: await prices.usd(token, amount, now) });
      }
      const { clean, paid, usd } = details.get(feed.token), traderKey = `${feed.token} ${trade.net > 0n ? 'buy' : 'sell'}`;
      if (!traders.has(traderKey)) {
        const trader = selectTrader(clean, feed.token, trade.net, [config.contracts.ekubo_core, config.contracts.avnu_exchange].filter(Boolean));
        let freshHolder = false, name;
        if (trader) {
          try { freshHolder = await balanceOf(rpc, feed.token, trader, { block_number: block - 1 }) === 0n; } catch { /* no flag without proof */ }
          name = await names.reverse(trader, now);
        }
        traders.set(traderKey, { trader, freshHolder, name });
      }
      const { trader, freshHolder, name } = traders.get(traderKey);
      const dots = sizeDots(amount, feed.usd ? 0n : BigInt(feed.minimum), sample?.fresh
        ? { numerator: amount * sample.price, denominator: 10n ** BigInt(token.decimals + sample.decimals) } : null);
      const lines = [`${trade.net > 0n ? '🟢 Buy' : '🔴 Sell'} <b>${decimal(amount, token.decimals)} ${fmt.token(token)}</b>${usd ? ` ≈ ${escapeHtml(usd)}` : ''}`, '●'.repeat(dots)];
      lines.push(`Paid: ${paid}`);
      if (trader) lines.push(`Trader: ${fmt.contract(trader, name ? escapeHtml(name) : undefined)}${freshHolder ? ' · new holder' : ''}`);
      lines.push(`${trade.venue} · ${utc(h.timestamp)} · ${fmt.tx(tx, 'tx')}`);
      // A reserved index separates the per-transaction feed from token-event alerts and track stages.
      deliveries.push({ chatId: feed.chat_id, txHash: tx, eventIndex: -4, events: events.map(e => e.index), kind: 'feed',
        block, chainTime: h.timestamp, body: lines.join('\n'), topic: feed.topic });
    }
  }
  return deliveries;
}
