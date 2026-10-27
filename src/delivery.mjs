import { log, TelegramRefused } from './errors.mjs';
import { messages } from './format.mjs';
import { plan, summarise } from './summary.mjs';

const LOUD_ALERTS = 3;
const NO_WRITE = /not enough rights|have no rights|chat not found/i;
const NO_TOPIC = /thread|topic/i;

// Telegram delivery uses the shared planner and the durable ledger; it never reads the chain.
export async function respond(bot, out) {
  if (out.callback === undefined) return bot.reply(out);
  if (typeof out.callback === 'string') {
    try { await bot.tg.call('answerCallbackQuery', { callback_query_id: out.callback, ...(out.answer ? { text: String(out.answer).slice(0, 200) } : {}) }); }
    catch (error) { if (!(error instanceof TelegramRefused)) throw error; } // too old to answer
  }
  if (out.edit && Number.isSafeInteger(out.edit.message_id)) {
    try {
      await bot.tg.call('editMessageText', { chat_id: out.edit.chat_id, message_id: out.edit.message_id, text: messages(out.edit.lines)[0],
        parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: out.edit.keyboard ?? [] } });
    } catch (error) { if (!(error instanceof TelegramRefused)) throw error; } // "message is not modified", or gone
  }
  if (out.reply) await bot.reply(out.reply);
}
export async function reply(bot, { chat_id, message_thread_id, lines = [], messages: parts = messages(lines), keyboard }) {
  for (const [i, text] of parts.entries()) {
    const markup = i === parts.length - 1 && keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {};
    if (!(await bot.send(chat_id, text, { message_thread_id, ...markup })).message) break;
  }
}
/**
 * sendMessage with round 2's rules: a 403 pauses the chat, and so does a 400 saying the bot may not write
 * there (restricted, or the chat is gone), so that its alerts wait instead of being dropped; a migration
 * moves the chat's data and resends to the new id; a forum topic that is gone sends to the chat's main
 * thread instead; any other refusal is logged and skipped. Returns { message, chatId }, { blocked } or
 * { refused }.
 */
export async function send(bot, chatId, text, extra = {}) {
  const block = () => {
    bot.store.transaction(() => bot.subs.pause(chatId));
    return { blocked: true };
  };
  let migrated = false;
  for (let hop = 0; hop < 3; hop++) {
    try {
      const message = await bot.tg.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
      if (message === null) return block();
      bot.counts.sent++;
      return { message, chatId };
    } catch (error) {
      if (!(error instanceof TelegramRefused)) throw error;
      const to = error.migratedTo;
      if (to !== null && to !== chatId && !migrated) {
        bot.store.transaction(() => bot.subs.migrate(chatId, to));
        chatId = to;
        migrated = true;
        continue;
      }
      if (error.code === 400 && extra.message_thread_id !== undefined && NO_TOPIC.test(error.description)) {
        const { message_thread_id: _gone, ...rest } = extra;
        extra = rest;
        continue;
      }
      if (error.code === 400 && NO_WRITE.test(error.description)) return block();
      log('warn', `Telegram refused a message (${error.code}).`);
      return { refused: true };
    }
  }
  return { refused: true };
}

export async function deliver(bot) {
  const byChat = new Map();
  for (const row of bot.ledger.pending()) (byChat.get(row.chat_id) ?? byChat.set(row.chat_id, []).get(row.chat_id)).push(row);
  for (const [chatId, rows] of byChat) {
    if (bot.signal.aborted) return;
    const used = bot.budget.used.get(chatId) ?? 0;
    const { full, rest } = plan(rows, rows[0].type, used, bot.chainReady && (bot.rpc.generation ?? 0) === bot.headEndpoint, bot.catchingUp);
    let target = chatId, sent = 0, open = true;
    for (const row of full) {
      if (bot.signal.aborted) return;
      const r = await bot.send(target, row.body, { ...topic(row.thread_id), ...(row.kind === 'correction' ? { reply_parameters: { message_id: row.reply_to, allow_sending_without_reply: true } } : {}), ...(sent >= LOUD_ALERTS ? { disable_notification: true } : {}) });
      if (r.message) {
        target = r.chatId;
        sent++;
        bot.store.transaction(() => bot.ledger.sent(row.seq, r.message.message_id));
        bot.counts.alerts++;
      } else if (r.refused) bot.store.transaction(() => bot.ledger.dropped(row.seq));
      else { open = false; break; } // blocked: the chat's alerts wait until it writes again
    }
    if (open && rest.length && !bot.signal.aborted) {
      const r = await bot.send(target, summarise(rest, bot.fmt), { ...topic(mostCommon(rest.map((row) => row.thread_id))), disable_notification: true });
      if (r.message) {
        sent++;
        bot.store.transaction(() => { for (const row of rest) bot.ledger.summarized(row.seq, r.message.message_id); });
        bot.counts.alerts += rest.length;
      } else if (r.refused) bot.store.transaction(() => { for (const row of rest) bot.ledger.dropped(row.seq); });
    }
    bot.budget.used.set(target, (bot.budget.used.get(target) ?? 0) + sent);
  }
}

/** sendMessage's forum topic, when there is one. */
export const topic = (thread) => (Number.isSafeInteger(thread) ? { message_thread_id: thread } : {});
/** The value most rows share (the first one on a tie): a summary posts into the topic most of its alerts came from. */
function mostCommon(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
}
