import { FIELD, normalize, SELECTORS, u256, unsigned } from './felt.mjs';
import { escapeHtml, utc } from './format.mjs';
import { contractLink, tokenAmount } from './tokens.mjs';

const zero = `0x${'0'.repeat(64)}`;
export function eventAddress(value) {
  return unsigned(value, FIELD) === 0n ? zero : normalize(value);
}
export function decodeEvent(event, index) {
  try {
    const selector = unsigned(event.keys?.[0], FIELD);
    const kind = selector === BigInt(SELECTORS.Transfer) ? 'Transfer' :
      selector === BigInt(SELECTORS.Approval) ? 'Approval' : null;
    if (!kind || !Array.isArray(event.data)) return null;
    let a, b, words;
    if (event.keys.length === 3 && event.data.length === 2) {
      [a, b] = event.keys.slice(1); words = event.data;
    } else if (event.keys.length === 1 && event.data.length === 4) {
      [a, b] = event.data; words = event.data.slice(2);
    } else return null;
    return { kind, address: normalize(event.from_address), from: eventAddress(a), to: eventAddress(b),
      value: u256(words), index };
  } catch { return null; }
}
export function matchingWatches(chat, event, block) {
  return chat.watches.filter(w => block > w.since_block &&
    (w.address === event.from || event.kind === 'Transfer' && w.address === event.to));
}
export function relevant(chat, event, block) {
  return matchingWatches(chat, event, block).length > 0 ||
    event.kind === 'Transfer' && chat.whales.some(w => w.address === event.address && block > w.since_block);
}

export function alertLine(chat, event, token, block, context) {
  const watches = matchingWatches(chat, event, block);
  if (event.kind === 'Transfer' && event.value > 0n) {
    for (const watch of watches) if (!watch.seen.includes(token.address)) watch.seen.push(token.address);
  }
  if (chat.muted.includes(event.address)) return null;
  const from = watches.find(w => w.address === event.from);
  const to = watches.find(w => w.address === event.to);
  const named = (address, watch) => `${watch?.label ? `${escapeHtml(context.clean(watch.label))} ` : ''}${contractLink(address, context)}`;
  if (event.kind === 'Approval') {
    if (!from) return null;
    const value = event.value >= (1n << 128n) - 1n ?
      `unlimited ${tokenAmount(0n, token, context).replace(/^0 /, '')}` : tokenAmount(event.value, token, context);
    return `⚠️ Approval · ${named(event.from, from)}\n${value} · spender ${contractLink(event.to, context)}`;
  }
  if (event.value === 0n) return null;
  const floor = BigInt(chat.minimums[event.address] ?? '0');
  const watchMatch = watches.length > 0 && event.value >= floor;
  const whale = chat.whales.some(w => w.address === event.address && block > w.since_block && event.value >= BigInt(w.amount));
  if (!watchMatch && !whale) return null;
  const direction = from && to ? 'Between' : from ? 'Out' : to ? 'In' : 'Transfer';
  const tag = event.from === zero ? ' · Mint' : event.to === zero ? ' · Burn' : '';
  return `${direction === 'In' ? '⬇️' : direction === 'Out' ? '⬆️' : '↔️'} ${direction}${whale ? ' · Whale' : ''}${tag} · ${tokenAmount(event.value, token, context)}\n${named(event.from, from)} → ${named(event.to, to)}`;
}
export function transactionFooter(hash, block, context) {
  return [`Block ${block.block_number} · ${utc(block.timestamp)}`,
    `<a href="${escapeHtml(context.clean(`${context.config.explorer}/tx/${hash}`))}">View transaction</a>`];
}
export function transactionMessages(lines, footer) {
  const end = footer.join('\n'), groups = [];
  const budget = 4096 - end.length - 80;
  let current = '';
  for (const line of lines) {
    if (line.length > budget) throw new Error('Event exceeds Telegram message limit.');
    if (current.length + line.length + 1 > budget) { groups.push(current); current = ''; }
    current += `${current ? '\n' : ''}${line}`;
  }
  if (current) groups.push(current);
  return groups.map((body, i) => `${groups.length > 1 ? `Activity · part ${i + 1}/${groups.length}\n` : ''}${body}\n${end}`);
}
