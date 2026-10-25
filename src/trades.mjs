import { FIELD, hex64, normalize, SELECTORS, U128, u256, unsigned } from './felt.mjs';
import { decimal, escapeHtml, utc } from './format.mjs';
import { balanceOf } from './tokens.mjs';
import { decodeTokenEvents } from './scanner.mjs';
import { meetsUsd, usdValue } from './prices.mjs';

const ZERO = hex64('0x0');
const abs = n => n < 0n ? -n : n;
const add = (map, token, value) => map.set(token, (map.get(token) ?? 0n) + value);
const signed = (mag, sign) => unsigned(mag, U128) * (unsigned(sign, 2n) ? -1n : 1n);
/** Venue adapters produce token deltas from the trader's perspective; routers are never identities. */
export const VENUES = Object.freeze([
  { key: 'ekubo_core', name: 'Ekubo', selector: SELECTORS.Swapped, decode(data) {
    if (data.length !== 21) return null;
    const deltas = new Map();
    add(deltas, normalize(data[1]), -signed(data[12], data[13]));
    add(deltas, normalize(data[2]), -signed(data[14], data[15]));
    return deltas;
  } },
  { key: 'avnu_exchange', name: 'AVNU', selector: SELECTORS.Swap, decode(data) {
    if (data.length !== 8) return null;
    const deltas = new Map();
    add(deltas, normalize(data[1]), -u256(data.slice(2, 4)));
    add(deltas, normalize(data[4]), u256(data.slice(5, 7)));
    return deltas;
  } },
]);
export function decodeSwaps(raw, contracts) {
  const swaps = [], seen = new Set();
  for (const e of raw) {
    try {
      if (!Array.isArray(e.keys) || e.keys.length !== 1 || !Array.isArray(e.data)) continue;
      const venue = VENUES.find(v => contracts[v.key] === normalize(e.from_address) && BigInt(v.selector) === unsigned(e.keys[0], FIELD));
      if (!venue || !Number.isSafeInteger(e.block_number) || e.block_number < 0) continue;
      // Validate all fields before trusting either amount.
      e.data.forEach(w => unsigned(w, FIELD));
      const deltas = venue.decode(e.data);
      if (!deltas) continue;
      const tx = normalize(e.transaction_hash, 'hash');
      const index = Number.isSafeInteger(e.event_index) && e.event_index >= 0 ? e.event_index : null;
      if (index !== null) { const key = `${tx}:${venue.key}:${index}`; if (seen.has(key)) continue; seen.add(key); }
      swaps.push({ tx, block: e.block_number, index, venue: venue.name, deltas });
    } catch { /* Ignore malformed events, never guess an amount. */ }
  }
  return swaps;
}
export function netTrade(swaps, token) {
  const avnu = swaps.filter(s => s.venue === 'AVNU' && s.deltas.has(token));
  const chosen = avnu.length ? avnu : swaps.filter(s => s.venue === 'Ekubo');
  const deltas = new Map();
  for (const s of chosen) for (const [asset, value] of s.deltas) add(deltas, asset, value);
  return { net: deltas.get(token) ?? 0n, deltas, venue: avnu.length ? 'AVNU' : 'Ekubo' };
}
/** Largest signed net transfer flow wins; the first event touching an address resolves exact ties. */
export function traderFromTransfers(transfers, token, net, excluded, feeIndex = null) {
  const flows = new Map(), seen = new Set();
  for (const e of transfers) {
    if (e.kind !== 'Transfer' || e.token !== token || e.index === feeIndex) continue;
    const key = `${e.tx}:${e.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const [address, delta] of [[e.a, -e.amount], [e.b, e.amount]]) {
      if (address === ZERO || excluded.has(address)) continue;
      const f = flows.get(address) ?? { address, amount: 0n, index: e.index };
      f.amount += delta; f.index = Math.min(f.index, e.index); flows.set(address, f);
    }
  }
  const candidates = [...flows.values()].filter(f => net > 0n ? f.amount > 0n : f.amount < 0n);
  candidates.sort((a, b) => abs(a.amount) === abs(b.amount) ? a.index - b.index : abs(a.amount) > abs(b.amount) ? -1 : 1);
  return candidates[0]?.address ?? null;
}

/** A receipt is needed only for a candidate fee payment, never to identify a trader by its sender. */
async function feeIndex(transfers, header, token, tokens, rpc, tx) {
  if (token !== tokens.strk) return null;
  const sequencer = hex64(header.sequencer_address ?? '0x0');
  const candidates = transfers.filter(e => e.kind === 'Transfer' && e.token === token && e.b === sequencer);
  if (!candidates.length) return null;
  const receipt = await rpc.call('starknet_getTransactionReceipt', { transaction_hash: tx });
  if (!Array.isArray(receipt?.events) || receipt.actual_fee?.unit !== 'FRI') return null;
  const last = receipt.events.length - 1, fee = unsigned(receipt.actual_fee.amount);
  return candidates.find(e => e.index === last && e.amount === fee)?.index ?? null;
}

export async function tradeAlerts(rawSwaps, rawTokens, feeds, ctx) {
  const { config, rpc, tokens, fmt, prices, names, now, head } = ctx;
  const byTx = new Map(), transfers = new Map(), headers = new Map(), deliveries = [];
  for (const swap of decodeSwaps(rawSwaps, config.contracts)) {
    if (!byTx.has(swap.tx)) byTx.set(swap.tx, []);
    byTx.get(swap.tx).push(swap);
  }
  for (const e of decodeTokenEvents(rawTokens)) {
    if (!transfers.has(e.tx)) transfers.set(e.tx, []);
    transfers.get(e.tx).push(e);
  }
  const excluded = new Set([config.contracts.ekubo_core, config.contracts.avnu_exchange].filter(Boolean));
  for (const [tx, swaps] of byTx) {
    const block = swaps[0].block;
    for (const feed of feeds) {
      if (block <= feed.since_block || ctx.interests.muted.has(`${feed.chat_id} ${feed.token}`)) continue;
      const trade = netTrade(swaps, feed.token), { net } = trade;
      if (!net || (net < 0n && feed.mode !== 'all')) continue;
      const units = abs(net);
      if (!feed.usd && units < BigInt(feed.units)) continue;
      const token = await tokens.get(feed.token, now);
      if (!token) continue;
      const price = await prices.get(token, now, { block_number: head.block_number });
      if (feed.usd && !meetsUsd(units, token, price, feed.units)) continue;
      if (!headers.has(block)) headers.set(block, await rpc.call('starknet_getBlockWithTxHashes', { block_id: { block_number: block } }));
      const header = headers.get(block), events = transfers.get(tx) ?? [];
      const trader = traderFromTransfers(events, token.address, net, excluded, await feeIndex(events, header, token.address, tokens, rpc, tx));
      let name = null, newHolder = false;
      if (trader) {
        name = await names.reverse(trader, { block_number: block });
        if (net > 0n && block > 0) {
          try { newHolder = (await balanceOf(rpc, token.address, trader, { block_number: block - 1 })) === 0n; }
          catch { /* Historical state may be pruned: never guess that a balance was zero. */ }
        }
      }
      const usd = usdValue(units, token, price);
      const size = usd && meetsUsd(units, token, price, 100000n, 0) ? ' 🐋' : '';
      const lines = [`${net > 0n ? '🟢' : '🔴'} <b>${net > 0n ? 'Buy' : 'Sell'}</b>${size} · ${decimal(units, token.decimals)} ${fmt.token(token)}${usd ? ` · ≈ ${escapeHtml(usd)}` : ''}`];
      const paid = [];
      for (const [address, value] of trade.deltas) {
        if (address === token.address || !value || (net > 0n ? value >= 0n : value <= 0n)) continue;
        const quote = await tokens.get(address, now);
        if (quote) paid.push(`${decimal(abs(value), quote.decimals)} ${fmt.token(quote)}`);
      }
      if (paid.length) lines.push(`${net > 0n ? 'Paid' : 'Received'}: ${paid.slice(0, 4).join(' + ')}${paid.length > 4 ? ` + ${paid.length - 4} other assets` : ''}`);
      if (trader) lines.push(`Trader: ${fmt.contract(trader, name ? escapeHtml(name) : undefined)}${newHolder ? ' · new holder' : ''}`);
      lines.push(`${trade.venue} · ${utc(header.timestamp)} · ${fmt.tx(tx, 'View transaction')}`);
      deliveries.push({ chatId: feed.chat_id, topic: feed.topic, txHash: tx, eventIndex: -10, kind: 'feed',
        events: swaps.map(s => s.index).filter(i => i !== null), block, chainTime: header.timestamp, body: lines.join('\n') });
    }
  }
  return deliveries;
}
