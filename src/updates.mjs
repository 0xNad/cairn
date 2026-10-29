import { callback, parseCommand, parsePaste, respond } from './commands.mjs';
import { CairnError, TelegramRefused } from './errors.mjs';
import { textLines } from './format.mjs';
import { guardWarning } from './guard.mjs';
import { topic } from './delivery.mjs';

const ADMINS = new Set(['creator', 'administrator']);
const SLOW_DOWN = 'Slow down: Cairn answers at most 10 commands a minute from one person, and ignores the rest until that minute has passed.';

// Updates inspect protected content before parsing commands; changes and offsets commit together.
export async function handle(bot, update) {
  if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) throw new CairnError('Telegram returned an invalid update id.');
  if (update.update_id < bot.store.offset) return;
  let commit = () => null;
  if (update.message) commit = await onMessage(bot, update.message);
  else if (update.edited_message) commit = await protect(bot, update.edited_message) ?? commit;
  else if (update.callback_query) commit = await onCallback(bot, update.callback_query);
  else if (update.my_chat_member) commit = onMembership(bot, update.my_chat_member);
  // Claim durably before replying: Telegram has no idempotency key, so a crash can lose a reply but never
  // replays an accepted one. Whatever the update changed is saved in the same transaction. No chat text,
  // name or username is persisted.
  let out = null;
  bot.store.transaction(() => { out = commit(); bot.store.offset = update.update_id + 1; });
  bot.counts.updates++;
  if (out) await bot.respond(out);
}
/** Shared inspection for new messages and edits; edits never run message handlers. */
async function protect(bot, message) {
  const chat = message?.chat;
  if (!Number.isSafeInteger(chat?.id)) return null;
  const protectedKind = bot.guards.match(message);
  if (protectedKind) {
    let removed = false;
    try { removed = (await bot.tg.call('deleteMessage', { chat_id: chat.id, message_id: message.message_id })) !== null; }
    catch (error) { if (!(error instanceof TelegramRefused)) throw error; }
    return () => ({ chat_id: chat.id, ...topic(message.message_thread_id), lines: guardWarning(protectedKind, removed) });
  }
  return null;
}
async function onMessage(bot, message) {
  const chat = message?.chat;
  if (!Number.isSafeInteger(chat?.id)) return () => null;
  if (Number.isSafeInteger(message.migrate_to_chat_id)) return () => { bot.subs.migrate(chat.id, message.migrate_to_chat_id); return null; };
  if (Number.isSafeInteger(message.migrate_from_chat_id)) return () => { bot.subs.migrate(message.migrate_from_chat_id, chat.id); return null; };
  const protection = await protect(bot, message);
  if (protection) return protection;
  // A chat that writes again gets its pending alerts.
  const resume = () => bot.subs.resume(chat.id);
  const command = parseCommand(message, bot.username) ?? parsePaste(message);
  if (!command) return () => { resume(); return null; };
  const target = { chat_id: chat.id, ...(Number.isSafeInteger(message.message_thread_id) ? { message_thread_id: message.message_thread_id } : {}) };
  const sender = message.sender_chat?.id ?? message.from?.id;
  const verdict = bot.rate.verdict(sender, message.date);
  if (verdict !== 'ok') {
    return () => {
      resume();
      bot.rate.note(sender, message.date, verdict);
      return verdict === 'notice' ? { ...target, lines: textLines(SLOW_DOWN, bot.clean) } : null;
    };
  }
  if (command.name === 'track') bot.wake = true;
  const reply = await respond(command, context(bot, chat, message));
  return () => {
    resume();
    bot.rate.note(sender, message.date, 'ok');
    const r = reply();
    return r && { ...target, ...r };
  };
}
async function onCallback(bot, query) {
  const chat = query?.message?.chat;
  const commit = await callback(query, context(bot, chat ?? {}, null));
  if (/^ot:/.test(String(query?.data ?? ''))) bot.wake = true;
  return () => {
    if (Number.isSafeInteger(chat?.id)) bot.subs.resume(chat.id);
    const r = commit();
    return { callback: query.id, ...r, ...(r.reply ? { reply: { chat_id: chat.id, ...r.reply } } : {}) };
  };
}
/** Kicked, left or barred from writing: the chat's alerts wait; added back or allowed again: they resume. */
function onMembership(bot, update) {
  const chat = update.chat, member = update.new_chat_member;
  if (!Number.isSafeInteger(chat?.id) || member?.user?.id !== bot.me.id) return () => null;
  const barred = member.status === 'restricted' && (member.is_member === false || member.can_send_messages === false);
  if (['kicked', 'left'].includes(member.status) || barred) return () => { bot.subs.pause(chat.id); return null; };
  if (['member', 'administrator', 'creator', 'restricted'].includes(member.status)) return () => { bot.subs.resume(chat.id); return null; };
  return () => null;
}
export function context(bot, chat, message) {
  let admin;
  return {
    config: bot.config, rpc: bot.rpc, username: bot.username, clean: bot.clean, head: bot.head, spec: bot.identity?.spec,
    signal: bot.signal, subs: bot.subs, tokens: bot.tokens, fmt: bot.fmt, chat,
    prices: bot.prices, names: bot.names, venues: bot.venues, guards: bot.guards,
    // The forum topic a command came from: a feed, watch, whale or track set up there posts there. A reply in
    // an ordinary group (or a comment thread) also carries a message_thread_id, which subscriptions ignore.
    thread: Number.isSafeInteger(message?.message_thread_id) && (message.is_topic_message === true || !message.reply_to_message)
      ? message.message_thread_id : null,
    admin: (user) => (admin ??= isAdmin(bot, chat, message, user)),
  };
}
/** Admin means getChatMember says creator or administrator; a message posted as the group itself counts too. */
async function isAdmin(bot, chat, message, user) {
  if (chat.type === 'private') return true;
  if (!user && message?.sender_chat?.id === chat.id) return true;
  const id = (user ?? message?.from)?.id;
  if (!Number.isSafeInteger(id)) return false;
  try {
    const member = await bot.tg.call('getChatMember', { chat_id: chat.id, user_id: id });
    return ADMINS.has(member?.status);
  } catch (error) {
    if (error instanceof TelegramRefused) return false;
    throw error;
  }
}

