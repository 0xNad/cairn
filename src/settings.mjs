// Round 2's chat settings: /watch, /unwatch, /whale, /unwhale, /min, /mute, /unmute, /track, /export and /forget
// (in groups, for administrators only: bot.mjs checks before calling), /list (for everyone), and the buttons
// they offer. A reply is { lines, keyboard }: HTML lines, and inline buttons under its last message; /list and
// /export may answer with several. Watches, whales and tracks cover the blocks after the head of this pass.
import { chatOf, exportOf, findEntry, forget, LIMITS, newId, tidy } from './chats.mjs';
import { NodeBusy, RpcError } from './errors.mjs';
import { NodeValueError, normalize, parseAmount } from './felt.mjs';
import { escapeHtml, short, textLines } from './format.mjs';
import { take } from './offers.mjs';
import { tokenAmount, tokenName } from './tokens.mjs';

export const SETTINGS = Object.freeze(['watch', 'unwatch', 'whale', 'unwhale', 'min', 'mute', 'unmute', 'track', 'export', 'forget']);
const PAGE = 3500; // characters of one /list or /export message
const BUTTONS = 20; // Remove buttons under one /list message

const say = (ctx, text) => ({ lines: textLines(text, ctx.clean) });
const busy = (ctx) => say(ctx, 'node busy — this needs the chain head. Please try again shortly.');
const words = (text) => text.split(/\s+/).filter(Boolean);
const who = (watch, link) => `${watch.label ? `${escapeHtml(watch.label)} ` : ''}${link('contract', watch.address)}`;
// A token as a subscription keeps it.
const describe = (token) => ({ token: token.address, symbol: token.symbol, decimals: token.decimals, verified: token.verified });
const asToken = (entry, ctx) => ({ address: entry.token, symbol: entry.symbol, decimals: entry.decimals, verified: entry.verified,
  lookalike: entry.verified ? null : ctx.tokens.bySymbol(entry.symbol)?.symbol ?? null });

/** A watch label as typed: blanks collapsed, invisible and control characters dropped; null when too long. */
function cleanLabel(text) {
  const label = text.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim();
  return [...label].length <= LIMITS.label ? label : null;
}

/** A token named by a registry symbol or an address: { token } or { reply } (why not). */
async function tokenFor(input, ctx) {
  const found = await ctx.tokens.resolve(input, ctx.head?.timestamp ?? null);
  return found.error ? { reply: say(ctx, found.error) } : found;
}

/** A token's address from a registry symbol or an address, without reading it: { address } or { error }. */
function tokenAddress(input, ctx) {
  const known = ctx.tokens.bySymbol(input);
  if (known) return { address: known.address };
  try { return { address: normalize(input, 'address') }; } catch (error) { return { error: error.message }; }
}

/** Runs a settings command; the node being busy, or failing, is a reply. */
export async function configure(command, ctx) {
  const run = { watch, unwatch, whale, unwhale, min: floor, mute, unmute, track, export: exportReply, forget: forgetReply }[command.name];
  try { return await run(command.argument, ctx); }
  catch (error) {
    if (ctx.signal.aborted) throw error;
    if (error instanceof NodeBusy) return busy(ctx);
    if (error instanceof RpcError || error instanceof NodeValueError) return say(ctx, 'Token lookup unavailable: the node gave no usable answer. Try again later.');
    throw error;
  }
}

async function watch(argument, ctx) {
  const { state, config, head, chatId, link } = ctx;
  const [first = '', ...rest] = words(argument);
  let address;
  try { address = normalize(first, 'address'); } catch (error) { return say(ctx, `${error.message}\nUsage: /watch <address> [label]`); }
  const label = cleanLabel(rest.join(' '));
  if (label === null) return say(ctx, `A label has at most ${LIMITS.label} characters.`);
  const watches = state.chats[chatId]?.watches ?? [];
  const existing = watches.find((w) => w.address === address);
  if (existing) {
    if (!label || label === existing.label) return { lines: [`Already watching ${who(existing, link)}.`] };
    existing.label = label;
    return { lines: [`Label updated: ${who(existing, link)}.`] };
  }
  if (watches.length >= config.maxWatches) return say(ctx, `This chat already watches ${config.maxWatches} addresses, the most allowed. Remove one with /unwatch or /list first.`);
  if (!head) return busy(ctx);
  const entry = { id: newId(state), address, label, since_block: head.block_number, seen: [] };
  chatOf(state, chatId).watches.push(entry);
  return { lines: [`👁 Watching ${who(entry, link)} (${watches.length + 1} of ${config.maxWatches}).`,
    ...textLines(`From block ${head.block_number + 1}: every token it sends or receives, and the approvals it grants.`, ctx.clean)] };
}

function unwatch(argument, ctx) {
  const wanted = argument.replace(/\s+/g, ' ').trim();
  if (!wanted) return say(ctx, 'Usage: /unwatch <address|label>');
  const watches = ctx.state.chats[ctx.chatId]?.watches ?? [];
  let address = null;
  try { address = normalize(wanted, 'address'); } catch { /* a label */ }
  let index = address ? watches.findIndex((w) => w.address === address) : -1;
  if (index < 0) {
    const labelled = watches.filter((w) => w.label && w.label.toLowerCase() === wanted.toLowerCase());
    if (labelled.length > 1) return { lines: [...textLines(`${labelled.length} watches have the label "${wanted}": /unwatch one of their addresses.`, ctx.clean), ...labelled.map((w) => `• ${who(w, ctx.link)}`)] };
    index = watches.indexOf(labelled[0]);
  }
  if (index < 0) return say(ctx, `No watch in this chat matches "${wanted}". /list shows them.`);
  const [removed] = watches.splice(index, 1);
  tidy(ctx.state, ctx.chatId);
  return { lines: [`Stopped watching ${who(removed, ctx.link)}.`] };
}

async function whale(argument, ctx) {
  const { state, head, chatId, link } = ctx;
  const [input, amountText, ...extra] = words(argument);
  if (!input || !amountText || extra.length) return say(ctx, 'Usage: /whale <SYMBOL|token address> <amount>, for example /whale STRK 1000000');
  const found = await tokenFor(input, ctx);
  if (found.reply) return found.reply;
  const { token } = found;
  let min;
  try { min = parseAmount(amountText, token.decimals); } catch (error) { return say(ctx, error.message); }
  const whales = state.chats[chatId]?.whales ?? [];
  const existing = whales.find((w) => w.token === token.address);
  const posts = `every transfer of ${tokenAmount(min, token, link)} or more, mints and burns included`;
  if (existing) {
    Object.assign(existing, describe(token), { min: String(min) });
    return { lines: [`🐋 Whale threshold updated: ${posts}.`] };
  }
  if (whales.length >= LIMITS.whales) return say(ctx, `This chat already has ${LIMITS.whales} whale thresholds, the most allowed. Remove one with /unwhale or /list first.`);
  if (!head) return busy(ctx);
  chatOf(state, chatId).whales.push({ id: newId(state), ...describe(token), min: String(min), since_block: head.block_number });
  return { lines: [`🐋 Whale alerts from block ${head.block_number + 1}: ${posts}.`] };
}

function unwhale(argument, ctx) {
  const { address, error } = tokenAddress(argument.trim(), ctx);
  if (error) return say(ctx, `${error}\nUsage: /unwhale <SYMBOL|token address>`);
  const whales = ctx.state.chats[ctx.chatId]?.whales ?? [];
  const index = whales.findIndex((w) => w.token === address);
  if (index < 0) return say(ctx, 'This chat has no whale threshold for that token. /list shows them.');
  const [removed] = whales.splice(index, 1);
  tidy(ctx.state, ctx.chatId);
  return { lines: [`Whale alerts stopped for ${tokenName(asToken(removed, ctx), ctx.link)}.`] };
}

async function floor(argument, ctx) {
  const { state, chatId, link } = ctx;
  const [input, amountText, ...extra] = words(argument);
  if (!input || !amountText || extra.length) return say(ctx, 'Usage: /min <SYMBOL|token address> <amount>, for example /min STRK 10 (0 removes the floor)');
  const found = await tokenFor(input, ctx);
  if (found.reply) return found.reply;
  const { token } = found;
  const minimums = state.chats[chatId]?.minimums ?? [];
  const existing = minimums.find((m) => m.token === token.address);
  if (/^0+(\.0*)?$/.test(amountText)) {
    if (existing) minimums.splice(minimums.indexOf(existing), 1);
    tidy(state, chatId);
    return { lines: [`No floor for ${tokenName(token, link)}: every watch alert about it is shown.`] };
  }
  let min;
  try { min = parseAmount(amountText, token.decimals); } catch (error) { return say(ctx, error.message); }
  if (existing) Object.assign(existing, describe(token), { min: String(min) });
  else if (minimums.length >= LIMITS.minimums) return say(ctx, `This chat already has ${LIMITS.minimums} floors, the most allowed. Remove one with /list first.`);
  else chatOf(state, chatId).minimums.push({ id: newId(state), ...describe(token), min: String(min) });
  return { lines: [`Watch alerts for transfers under ${tokenAmount(min, token, link)} are hidden in this chat. Whale thresholds still apply.`] };
}

/** A muted token as /list shows it: its symbol when known, and its contract. */
function mutedName(entry, ctx) {
  const known = ctx.tokens.verified(entry.token);
  if (known) return tokenName(known, ctx.link);
  const symbol = ctx.state.tokens[entry.token]?.symbol;
  return symbol ? tokenName({ address: entry.token, symbol, verified: false, lookalike: ctx.tokens.bySymbol(symbol)?.symbol ?? null }, ctx.link) : ctx.link('contract', entry.token);
}

function mute(argument, ctx) {
  const { state, chatId } = ctx;
  const { address, error } = tokenAddress(argument.trim(), ctx);
  if (error) return say(ctx, `${error}\nUsage: /mute <token address>`);
  const muted = state.chats[chatId]?.muted ?? [];
  if (muted.some((m) => m.token === address)) return { lines: [`${mutedName({ token: address }, ctx)} is already muted here.`] };
  if (muted.length >= LIMITS.muted) return say(ctx, `This chat already mutes ${LIMITS.muted} tokens, the most allowed. Remove one with /unmute or /list first.`);
  chatOf(state, chatId).muted.push({ id: newId(state), token: address });
  return { lines: [`🔇 Muted ${mutedName({ token: address }, ctx)} in this chat: no alert mentions it any more. /unmute undoes it.`] };
}

function unmute(argument, ctx) {
  const { address, error } = tokenAddress(argument.trim(), ctx);
  if (error) return say(ctx, `${error}\nUsage: /unmute <token address>`);
  const muted = ctx.state.chats[ctx.chatId]?.muted ?? [];
  const index = muted.findIndex((m) => m.token === address);
  if (index < 0) return say(ctx, 'That token is not muted in this chat.');
  muted.splice(index, 1);
  tidy(ctx.state, ctx.chatId);
  return { lines: [`🔔 Unmuted ${mutedName({ token: address }, ctx)}: its alerts are shown again.`] };
}

function track(argument, ctx) {
  const { state, head, chatId } = ctx;
  let hash;
  try { hash = normalize(argument.trim(), 'hash'); } catch (error) { return say(ctx, `${error.message}\nUsage: /track <transaction hash>`); }
  const tracks = state.chats[chatId]?.tracks ?? [];
  // No link to the transaction here: its posts carry it.
  if (tracks.some((t) => t.hash === hash)) return { lines: [`Already tracking <code>${short(hash)}</code>.`] };
  if (tracks.length >= LIMITS.tracks) return say(ctx, `This chat already tracks ${LIMITS.tracks} transactions, the most allowed. Remove one with /list, or wait for one to finish.`);
  if (!head) return busy(ctx);
  chatOf(state, chatId).tracks.push({ id: newId(state), hash, since_block: head.block_number, at: head.timestamp, stage: 'new' });
  return { lines: [`📍 Tracking <code>${short(hash)}</code>: one post when Starknet accepts it (L2), one when Ethereum does (L1) or if it reverts.`,
    ...textLines('If the node has no trace of it 10 minutes of chain time from now, tracking stops.', ctx.clean)] };
}

/** Pages of HTML lines, each page under PAGE characters. */
function paginate(lines, size = PAGE) {
  const pages = [[]];
  let length = 0;
  for (const line of lines) {
    if (pages.at(-1).length && length + line.length + 1 > size) { pages.push([]); length = 0; }
    pages.at(-1).push(line);
    length += line.length + 1;
  }
  return pages;
}

function exportReply(argument, ctx) {
  // Pretty JSON, in <pre>, cut at line ends: the messages' texts joined back are the JSON.
  const lines = JSON.stringify(exportOf(ctx.state, ctx.chatId), null, 2).split('\n').map((line) => escapeHtml(ctx.clean(line)));
  return paginate(lines).map((page) => ({ lines: [`<pre>${page.join('\n')}</pre>`] }));
}

function forgetReply(argument, ctx) {
  forget(ctx.state, ctx.chatId);
  return say(ctx, '🗑 Deleted everything Cairn stored for this chat: its watches and labels, whale thresholds, floors, mutes, tracked transactions and alerts.');
}

/** /list: every subscription of the chat, each with a Remove button. Several messages when it is long. */
export function list(ctx) {
  const { state, config, chatId, link } = ctx;
  const chat = state.chats[chatId];
  const rows = []; // { line, button? }
  const section = (title, entries, render) => {
    if (!entries.length) return;
    rows.push({ line: `<b>${title}</b>` });
    for (const entry of entries) {
      const [line, label] = render(entry);
      rows.push({ line: `• ${line}`, button: { text: `Remove ${label}`, callback_data: `rm:${entry.id}` } });
    }
  };
  section(`Watches (${chat?.watches.length ?? 0} of ${config.maxWatches})`, chat?.watches ?? [],
    (w) => [`${who(w, link)} · from block ${w.since_block + 1}`, w.label || short(w.address)]);
  section(`Whale thresholds (${chat?.whales.length ?? 0} of ${LIMITS.whales})`, chat?.whales ?? [],
    (w) => [`${tokenAmount(BigInt(w.min), asToken(w, ctx), link)} or more`, `whale ${w.symbol}${w.verified ? '' : ' (unverified)'}`]);
  section('Floors for watch alerts', chat?.minimums ?? [], (m) => [`under ${tokenAmount(BigInt(m.min), asToken(m, ctx), link)} hidden`, `floor ${m.symbol}${m.verified ? '' : ' (unverified)'}`]);
  section('Muted tokens', chat?.muted ?? [], (m) => [mutedName(m, ctx), `mute ${state.tokens[m.token]?.symbol ?? ctx.tokens.verified(m.token)?.symbol ?? short(m.token)}`]);
  section(`Tracked transactions (${chat?.tracks.length ?? 0} of ${LIMITS.tracks})`, chat?.tracks ?? [],
    (t) => [`${link('tx', t.hash)} · ${t.stage === 'l2' ? 'accepted on L2, waiting for L1' : 'waiting for L2'}`, `track ${short(t.hash)}`]);
  if (!rows.length) return [say(ctx, 'Nothing is set up in this chat yet. Start with /watch <address> [label] or /whale <token> <amount>; /help lists every command.')];
  const pages = [];
  for (const row of rows) {
    const page = pages.at(-1);
    if (!page || page.size + row.line.length + 1 > PAGE || (row.button && page.buttons.length >= BUTTONS)) pages.push({ lines: [row.line], buttons: row.button ? [row.button] : [], size: row.line.length });
    else {
      page.lines.push(row.line);
      if (row.button) page.buttons.push(row.button);
      page.size += row.line.length + 1;
    }
  }
  return pages.map(({ lines, buttons }) => ({ lines, keyboard: buttons.length ? pairs(buttons) : undefined }));
}
const pairs = (buttons) => Array.from({ length: Math.ceil(buttons.length / 2) }, (_, i) => buttons.slice(2 * i, 2 * i + 2));

/**
 * A button press in this chat: { answer } (a short notice under the button), with { edit } (the /list message,
 * updated) or { reply } (a message). Buttons carry `<verb>:<server id>`, and the id must belong to this chat:
 * `rm` a subscription (from /list), `w` and `t` an offer (offers.mjs) to watch or to track a pasted input.
 */
export async function press(data, ctx) {
  const match = /^(rm|w|t):(\d{1,15})$/.exec(typeof data === 'string' ? data : '');
  if (!match) return { answer: 'This button has expired.' };
  const [, verb, id] = match;
  if (verb === 'rm') {
    const chat = ctx.state.chats[ctx.chatId];
    const found = chat ? findEntry(chat, Number(id)) : null;
    if (!found) return { answer: 'Already removed, or not from this chat.' };
    const [name, index] = found;
    chat[name].splice(index, 1);
    tidy(ctx.state, ctx.chatId);
    const pages = list(ctx);
    return { answer: 'Removed.', edit: pages.length === 1 ? pages[0] : say(ctx, 'Removed. Send /list for the updated list.') };
  }
  const name = verb === 'w' ? 'watch' : 'track';
  const value = take(ctx.state, ctx.chatId, name, id);
  if (!value) return { answer: 'This button has expired: paste the address or hash again.' };
  return { answer: '', reply: await configure({ name, argument: value }, ctx) };
}
