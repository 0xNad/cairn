// The chat side: turns one Telegram update into at most one reply. It saves the update before it answers (so
// a kill can never make it be answered twice), answers only commands addressed to this bot, and never lets
// one failed send stop the others.
import { ExitError } from "../errors.mjs";
import { esc, plainText, splitMessage } from "../format.mjs";
import { isAbort } from "../util.mjs";
import { TelegramError, TelegramUnreachable } from "../telegram.mjs";
import { BY_NAME, COMMANDS } from "./commands/index.mjs";
import { NodeUnavailable } from "../rpc.mjs";
import { BUSY } from "./text.mjs";

/** Shutdown and exit codes pass through every `catch` that only wants to survive ordinary failures. */
const rethrow = (e) => isAbort(e) || e instanceof ExitError;

/**
 * Reads `/cmd`, `/cmd@bot` and the arguments from a message's text.
 * @returns {null | { name: string, to: string|null, args: string[] }}
 */
export function parseCommand(text) {
  const m = /^\/(\w+)(?:@(\w+))?/.exec(text);
  if (!m) return null;
  return { name: m[1].toLowerCase(), to: m[2]?.toLowerCase() ?? null, args: text.slice(m[0].length).trim().split(/\s+/).filter(Boolean) };
}

/**
 * @param {{ config: object, tg: import("../telegram.mjs").Telegram, chain: import("../chain.mjs").Chain,
 *   store: object, log: object, username: string }} deps
 */
export function createBot({ config, tg, chain, store, log, username }) {
  const me = username.toLowerCase();

  /** Sends `html` (split if long) to a chat. A chat that cannot be written to is skipped, never fatal. */
  async function send(chatId, html, options) {
    for (const piece of splitMessage(html)) {
      try {
        await sendOne(chatId, piece, options);
      } catch (e) {
        if (rethrow(e)) throw e;
        if (e instanceof TelegramError || e instanceof TelegramUnreachable) {
          log.warn("send_failed", { code: e.code ?? null, reason: e instanceof TelegramUnreachable ? "unreachable" : "refused" });
          return; // 403 (blocked or kicked), 400... the rest of this reply would fail the same way
        }
        throw e;
      }
    }
  }

  async function sendOne(chatId, piece, options) {
    try {
      await tg.sendMessage(chatId, piece, options);
    } catch (e) {
      // Our markup is always valid; if Telegram disagrees anyway, the reader still gets the words.
      if (e instanceof TelegramError && e.code === 400 && /parse entities/i.test(e.message)) {
        log.error("markup_refused", { note: "a reply was not valid Telegram HTML; sent as plain text" });
        await tg.sendMessage(chatId, esc(plainText(piece)), options);
        return;
      }
      throw e;
    }
  }

  /**
   * Handles one update. `getHead` returns the head block (once per batch) or null when the node is busy.
   * @param {object} update
   * @param {() => Promise<object|null>} getHead
   */
  async function handle(update, getHead) {
    const message = update?.message;
    const chat = message?.chat;
    store.saveUpdate(update.update_id, chat); // before any reply
    if (!message || !chat || typeof message.text !== "string" || message.from?.is_bot === true) return;

    const parsed = parseCommand(message.text);
    if (!parsed || (parsed.to !== null && parsed.to !== me)) return;
    const isPrivate = chat.type === "private";
    const options = {
      ...(isPrivate ? {} : { replyTo: message.message_id }),
      ...(message.is_topic_message && Number.isSafeInteger(message.message_thread_id) ? { threadId: message.message_thread_id } : {}),
    };

    const command = BY_NAME.get(parsed.name);
    if (!command) {
      // A bare unknown command in a group may be for another bot: only an addressed one gets the hint.
      if (isPrivate || parsed.to !== null) await send(chat.id, "I don't know that command. Send /help to see what I can do.", options);
      return;
    }

    let reply;
    try {
      reply = await command.run({ args: parsed.args, config, chain, head: getHead, commands: COMMANDS, username, rethrow });
    } catch (e) {
      if (rethrow(e)) throw e;
      if (e instanceof NodeUnavailable) reply = BUSY;
      else {
        log.error("command_failed", { command: command.name, error: e?.name ?? "error" });
        reply = "⚠️ Something went wrong on my side. Please try again.";
      }
    }
    await send(chat.id, reply, options);
  }

  return { handle };
}
