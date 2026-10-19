// What an update does. A command, or an address or a hash pasted in a private chat, gets a reply; a button press
// gets an answer, and an edit or a reply; a membership change pauses or resumes the chat's alerts; a group that
// became a supergroup takes its data along. Handlers change the state in memory and return their effects:
// bot.mjs saves the state with the update's offset before carrying them out, so no update is handled twice.
import { migrate, pause, resume } from './chats.mjs';
import { answer, parseCommand, pasted } from './commands.mjs';
import { textLines } from './format.mjs';
import { admit } from './limits.mjs';
import { configure, list, press, SETTINGS } from './settings.mjs';
import { TelegramRefusal } from './transport.mjs';

export const ALLOWED_UPDATES = Object.freeze(['message', 'callback_query', 'my_chat_member']);
const ADMINS_ONLY = 'Only administrators of this group can change its alerts. Everyone can use /list and the lookups.';
const SLOW_DOWN = '⏳ Slow down: Cairn answers at most 10 commands a minute from one person. The next ones are ignored until that minute has passed.';
const PASTED = /^0x[0-9a-fA-F]{1,64}$/;

/** An update's effects: [{ send: { chat, reply, thread } } | { answer: { id, text } } | { edit: { chat, message, reply } }]. */
export async function effects(update, context) {
  if (update.message) return onMessage(update.message, context);
  if (update.callback_query) return onPress(update.callback_query, context);
  if (update.my_chat_member) return onMembership(update.my_chat_member, context);
  return [];
}

const inChat = (context, id) => ({ ...context, chatId: String(id), chat: context.state.chats[String(id)] });

/** Whether the sender may change the chat's settings: anyone in a private chat; in a group, its administrators. */
async function isAdmin(chat, user, senderChat, context) {
  if (chat.type === 'private') return true;
  if (senderChat?.id === chat.id) return true; // an anonymous administrator, writing as the group itself
  if (!Number.isSafeInteger(user?.id)) return false;
  try {
    const member = await context.tg.call('getChatMember', { chat_id: chat.id, user_id: user.id });
    return member?.status === 'creator' || member?.status === 'administrator';
  } catch (error) {
    if (error instanceof TelegramRefusal) return false;
    throw error;
  }
}

async function onMessage(message, context) {
  const id = message.chat?.id;
  if (!Number.isSafeInteger(id)) return [];
  if (Number.isSafeInteger(message.migrate_to_chat_id)) {
    migrate(context.state, id, message.migrate_to_chat_id);
    return [];
  }
  resume(context.state, id); // a chat that writes gets its pending alerts
  const command = parseCommand(message, context.username);
  const value = !command && message.chat.type === 'private' ? (message.text ?? '').trim() : '';
  if (!command && !PASTED.test(value)) return [];
  const thread = Number.isSafeInteger(message.message_thread_id) ? message.message_thread_id : undefined;
  const send = (reply) => [{ send: { chat: id, reply, thread } }];
  const verdict = admit(context.state, message.sender_chat?.id ?? message.from?.id, message.date);
  if (verdict === 'ignore') return [];
  if (verdict === 'notice') return send({ lines: textLines(SLOW_DOWN, context.clean) });
  const here = inChat(context, id);
  if (!command) return send(await pasted(value, here));
  if (command.name === 'list') return send(list(here));
  if (!SETTINGS.includes(command.name)) return send(await answer(command, here));
  if (!(await isAdmin(message.chat, message.from, message.sender_chat, context))) return send({ lines: textLines(ADMINS_ONLY, context.clean) });
  return send(await configure(command, here));
}

async function onPress(query, context) {
  if (typeof query.id !== 'string') return [];
  const answer = (text) => ({ answer: { id: query.id, text } });
  const chat = query.message?.chat;
  if (!Number.isSafeInteger(chat?.id)) return [answer('This button has expired.')];
  // Every button changes a setting: in a group, the administrator status is checked again at each press.
  if (!(await isAdmin(chat, query.from, null, context))) return [answer('Only administrators of this group can change its alerts.')];
  const result = await press(query.data, inChat(context, chat.id));
  const out = [answer(result.answer)];
  if (result.edit && Number.isSafeInteger(query.message.message_id)) out.push({ edit: { chat: chat.id, message: query.message.message_id, reply: result.edit } });
  if (result.reply) out.push({ send: { chat: chat.id, reply: result.reply } });
  return out;
}

function onMembership(update, context) {
  const id = update.chat?.id;
  if (!Number.isSafeInteger(id)) return [];
  if (['kicked', 'left'].includes(update.new_chat_member?.status)) pause(context.state, id);
  else resume(context.state, id);
  return [];
}
