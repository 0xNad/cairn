import { randomBytes } from 'node:crypto';
import { normalize } from './felt.mjs';
import { escapeHtml, textLines } from './format.mjs';
import { NodeBusy, RpcError } from './errors.mjs';
import { answer, parseCommand } from './commands.mjs';
import { chatState, migrate } from './ledger.mjs';
import { contractLink, decimalAmount, tokenText } from './tokens.mjs';

const SETTINGS = new Set(['watch', 'unwatch', 'whale', 'unwhale', 'min', 'mute', 'unmute', 'track', 'export', 'forget']);
const id = () => randomBytes(12).toString('hex');
export async function isAdmin(message, tg, callback = false) {
  if (message.chat?.type === 'private') return true;
  if (!['group', 'supergroup'].includes(message.chat?.type)) return false;
  if (!callback && message.sender_chat?.id === message.chat.id) return true;
  if (!Number.isSafeInteger(message.from?.id)) return false;
  const member = await tg.call('getChatMember', { chat_id: message.chat.id, user_id: message.from.id });
  return ['creator', 'administrator'].includes(member?.status);
}

export function rateLimit(store, message) {
  if (!Number.isSafeInteger(message.from?.id) || !Number.isSafeInteger(message.date)) return 'ignore';
  const chat = chatState(store, message.chat.id), user = String(message.from.id), date = message.date;
  // Store only numeric IDs and times, scoped by chat so /forget erases the user's local records.
  const dates = [];
  let notified = false;
  for (const c of Object.values(store.state.chats)) {
    for (const [key, r] of Object.entries(c.rates)) {
      if (r.dates.every(t => t <= date - 60) && (r.notice === null || r.notice <= date - 60)) delete c.rates[key];
    }
    const r = c.rates[user];
    if (!r) continue;
    r.dates = r.dates.filter(t => t > date - 60);
    if (!r.dates.length) { delete c.rates[user]; continue; }
    dates.push(...r.dates);
    notified ||= r.notice !== null && r.notice > date - 60;
  }
  if (dates.length >= 10) {
    const r = chat.rates[user] ??= { dates: [], notice: null };
    if (notified) return 'ignore';
    r.notice = date;
    // Retain the notice until the window expires even if the rate was reached in another chat.
    if (!r.dates.length) r.dates.push(date);
    return 'notice';
  }
  const r = chat.rates[user] ??= { dates: [], notice: null };
  r.dates.push(date);
  if (dates.length === 0) r.notice = null;
  return 'allow';
}

export function listReply(chat, context, page = null) {
  if (!chat.watches.length) return { lines: ['No watched wallets. Use /watch &lt;address&gt; [label] to add one.'] };
  const size = 10, pages = Math.ceil(chat.watches.length / size);
  if (page === null && pages > 1) return { batches: Array.from({ length: pages }, (_, p) => listReply(chat, context, p)) };
  page = Math.min(page ?? 0, pages - 1);
  const watches = chat.watches.slice(page * size, (page + 1) * size);
  const lines = [`Watched wallets${pages > 1 ? ` · page ${page + 1}/${pages}` : ''}`, ...watches.map(w =>
    `${escapeHtml(context.clean(w.label || 'Wallet'))} · ${contractLink(w.address, context)} · since block ${w.since_block}`)];
  const rows = watches.map(w => {
    const existing = Object.entries(chat.callbacks).find(([, c]) => c.verb === 'remove' && c.address === w.address);
    const key = existing?.[0] ?? id();
    chat.callbacks[key] = { verb: 'remove', address: w.address, page };
    return [{ text: `Remove ${context.clean(w.label || w.address.slice(0, 10))}`, callback_data: `remove:${key}` }];
  });
  return { lines, extra: { reply_markup: { inline_keyboard: rows } } };
}

function inputWords(argument, count) {
  const words = argument.split(/\s+/).filter(Boolean);
  if (words.length !== count) throw new Error('Wrong number of arguments. See /help for command syntax.');
  return words;
}
function requireHead(context) { if (!context.head) throw new NodeBusy(); }
export async function settings(command, message, context) {
  const { store, clean, config, head, tokens } = context;
  const chat = chatState(store, message.chat.id);
  const text = s => ({ lines: textLines(s, clean) });
  switch (command.name) {
    case 'list': return listReply(chat, context);
    case 'export':
      if (command.argument) throw new Error('Usage: /export');
      // Include operational records too; no hidden per-chat state is omitted from the export.
      return { ...text(JSON.stringify({ chat_id: message.chat.id, ...chat })), separate: true };
    case 'forget':
      if (command.argument) throw new Error('Usage: /forget');
      delete store.state.chats[String(message.chat.id)];
      // Metadata is public chain data, but clearing it also removes tokens discovered only for this chat.
      store.state.metadata = {};
      return text('Forgot this chat: watches, thresholds, tracks, mutes, buttons and delivery history deleted.');
    case 'watch': {
      const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(command.argument);
      const address = normalize(match?.[1]);
      const rawLabel = match?.[2] ?? '';
      if ([...rawLabel].length > 32) throw new Error('Watch labels may contain at most 32 characters.');
      const label = [...clean(rawLabel).replace(/[\p{Cc}\p{Cf}]/gu, '')].slice(0, 32).join('');
      const current = chat.watches.find(w => w.address === address);
      if (current) {
        if (label) current.label = label;
        return text('Already watching this wallet. Its original starting block is preserved.');
      }
      if (chat.watches.length >= config.maxWatches) throw new Error(`Watch limit reached (${config.maxWatches}). Use /unwatch first.`);
      requireHead(context);
      chat.watches.push({ address, label, since_block: head.block_number, seen: [] });
      return { lines: [`Watching ${escapeHtml(label || 'wallet')} · ${contractLink(address, context)}`,
        `New activity after block ${head.block_number}. /list to manage; /min and /mute to reduce noise.`] };
    }
    case 'unwatch': {
      if (!command.argument) throw new Error('Usage: /unwatch <address|label>');
      let address;
      if (/^0x/i.test(command.argument)) address = normalize(command.argument);
      const found = chat.watches.filter(w => address ? w.address === address : w.label === command.argument);
      if (found.length > 1) throw new Error('That label matches multiple wallets. Remove one by address.');
      chat.watches = chat.watches.filter(w => !found.includes(w));
      for (const [key, c] of Object.entries(chat.callbacks)) if (found.some(w => w.address === c.address)) delete chat.callbacks[key];
      return text(found.length ? 'Wallet removed.' : 'No matching watch.');
    }
    case 'whale':
    case 'min': {
      const [input, value] = inputWords(command.argument, 2);
      const token = await tokens.get(input);
      if (!token) throw new Error('This contract does not expose valid ERC-20 decimals (0–36).');
      const amount = decimalAmount(value, token.decimals);
      if (command.name === 'min') chat.minimums[token.address] = amount;
      else {
        const current = chat.whales.find(w => w.address === token.address);
        if (!current && chat.whales.length >= 5) throw new Error('Whale limit reached (5). Use /unwhale first.');
        requireHead(context);
        if (current) current.amount = amount;
        else chat.whales.push({ address: token.address, amount, since_block: head.block_number });
      }
      return { lines: [`${command.name === 'min' ? 'Watch minimum' : 'Whale threshold'} saved for ${tokenText(token, context)}.`] };
    }
    case 'unwhale': {
      const [input] = inputWords(command.argument, 1);
      const known = config.tokens.find(t => t.symbol.toLowerCase() === input.toLowerCase());
      const address = known?.address ?? normalize(input);
      chat.whales = chat.whales.filter(w => w.address !== address);
      return text('Whale threshold removed.');
    }
    case 'mute':
    case 'unmute': {
      const address = normalize(inputWords(command.argument, 1)[0]);
      chat.muted = chat.muted.filter(a => a !== address);
      if (command.name === 'mute') chat.muted.push(address);
      return text(command.name === 'mute' ? 'Token muted for this chat.' : 'Token unmuted for this chat.');
    }
    case 'track': {
      const hash = normalize(inputWords(command.argument, 1)[0], 'hash');
      if (chat.tracks.some(t => t.hash === hash)) return text('Already tracking this transaction.');
      if (Object.keys(chat.deliveries).some(k => k.startsWith(`track:${hash}:`))) return text('This transaction has already been tracked. Use /tx to check it again.');
      if (chat.tracks.length >= 10) throw new Error('Track limit reached (10). Wait for a track to finish or use /forget.');
      requireHead(context);
      chat.tracks.push({ hash, since_time: head.timestamp, l2: false });
      // No transaction link on the acknowledgement: only the stage notifications carry it.
      return text('Tracking: L2 execution and fee, then L1 finality or failure.');
    }
    default: return null;
  }
}

async function paste(message, context) {
  const input = message.text.trim();
  let hash;
  try { hash = normalize(input, 'hash'); } catch { return null; }
  requireHead(context);
  let transaction = false;
  try { await context.rpc.call('starknet_getTransactionStatus', { transaction_hash: hash }); transaction = true; }
  catch (error) { if (!(error instanceof RpcError && error.code === 29)) throw error; }
  const address = transaction ? hash : normalize(input);
  const lines = await answer({ name: transaction ? 'tx' : 'balance', argument: address }, context);
  const chat = chatState(context.store, message.chat.id), key = id(), verb = transaction ? 'track' : 'watch';
  // Keep only a bounded number of pasted-input actions. Expired buttons give a helpful response.
  const pasted = Object.keys(chat.callbacks).filter(k => chat.callbacks[k].verb !== 'remove');
  for (const old of pasted.slice(0, Math.max(0, pasted.length - 19))) delete chat.callbacks[old];
  chat.callbacks[key] = { verb, address };
  return { lines, extra: { reply_markup: { inline_keyboard: [[{ text: transaction ? 'Track' : 'Watch', callback_data: `${verb}:${key}` }]] } } };
}

export async function handleMessage(message, context) {
  if (!Number.isSafeInteger(message?.chat?.id)) return null;
  const { store, tg, clean } = context;
  if (Number.isSafeInteger(message.migrate_to_chat_id)) { migrate(store, message.chat.id, message.migrate_to_chat_id); return null; }
  const chat = chatState(store, message.chat.id);
  chat.paused = false;
  const command = parseCommand(message, context.username);
  const pasted = !command && message.chat.type === 'private' && /^0x[0-9a-f]+$/i.test(message.text?.trim() ?? '');
  if (!command && !pasted) return null;
  const rate = rateLimit(store, message);
  if (rate === 'ignore') return null;
  if (rate === 'notice') return { lines: ['Slow down: at most 10 commands in 60 seconds. Please wait for the window to pass.'] };
  try {
    if (command && SETTINGS.has(command.name) && !await isAdmin(message, tg)) {
      return { lines: ['Administrator permission required: only a group admin can change settings or export/delete group data. /list and lookups remain available.'] };
    }
    context.chat = chat;
    if (pasted) return await paste(message, context);
    return await settings(command, message, context) ?? { lines: await answer(command, context) };
  } catch (error) {
    if (context.signal.aborted) throw error;
    return { lines: textLines(error instanceof NodeBusy ? 'node busy — try again shortly.' :
      error instanceof RpcError ? 'Node lookup unavailable. Try again later.' : error.message, clean) };
  }
}

export async function handleCallback(query, context) {
  let note = 'This button is expired or belongs to another chat.';
  let reply = null;
  try {
    const chat = context.store.state.chats[String(query.message?.chat?.id)];
    const match = /^(remove|watch|track):([a-f0-9]{24})$/.exec(query.data ?? '');
    const capability = match && chat?.callbacks[match[2]];
    if (!capability || capability.verb !== match[1]) return null;
    const message = { ...query.message, from: query.from };
    // Callback identity is the clicking user; never inherit sender_chat from the bot's message.
    delete message.sender_chat;
    if (!await isAdmin(message, context.tg, true)) { note = 'Administrator permission required.'; return null; }
    chat.paused = false;
    if (capability.verb === 'remove') {
      chat.watches = chat.watches.filter(w => w.address !== capability.address);
      delete chat.callbacks[match[2]];
      reply = { edit: true, ...listReply(chat, context, capability.page ?? 0) };
      note = 'Wallet removed.';
    } else {
      reply = await settings({ name: capability.verb, argument: capability.address }, message, context);
      delete chat.callbacks[match[2]];
      note = capability.verb === 'watch' ? 'Watch saved.' : 'Track saved.';
    }
    return reply;
  } catch (error) {
    if (context.signal.aborted) throw error;
    note = error instanceof NodeBusy || error instanceof RpcError ? 'Node busy; try again.' : context.clean(error.message).slice(0, 180);
    return null;
  } finally {
    // Offset and mutation are saved by the caller before any Telegram side effects.
    context.callbackAnswer = { callback_query_id: query.id, text: note };
  }
}
