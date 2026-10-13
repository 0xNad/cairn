// The chat commands and how a message reaches one. A command is { name, description, needsChain?, run }:
// run(env) returns the reply as format.mjs blocks. Adding a command is one module and one line below.
import { NodeUnavailable } from "../rpc.mjs";
import { balance } from "./balance.mjs";
import { help, start } from "./help.mjs";
import { nodeBusy, unknown } from "./replies.mjs";
import { status } from "./status.mjs";
import { tx } from "./tx.mjs";

export const COMMANDS = new Map([start, help, status, balance, tx].map((c) => [c.name, c]));

/** The menu for setMyCommands, in the order /help lists them. */
export const MENU = [status, balance, tx, help, start].map((c) => ({ command: c.name, description: c.description }));

/**
 * Parses `/cmd`, `/cmd@bot` and their arguments (ARCHITECTURE.md: ^/(\w+)(@(\w+))?). Returns { name, args },
 * or null for plain text and for a command addressed to another bot.
 */
export function parseCommand(text, username) {
  const m = /^\/(\w+)(?:@(\w+))?(?![\w@])(.*)$/s.exec(text);
  if (!m) return null;
  if (m[2] !== undefined && m[2].toLowerCase() !== username.toLowerCase()) return null;
  const rest = m[3].trim();
  return { name: m[1].toLowerCase(), args: rest === "" ? [] : rest.split(/\s+/) };
}

/**
 * The reply to one message, as blocks, or null when Cairn stays silent (plain text in a group, another
 * bot's command). `env` holds what commands read: config, chain, head (null when the node is unreachable),
 * node, me, log.
 */
export async function answer(message, env) {
  if (typeof message?.text !== "string") return null;
  const cmd = parseCommand(message.text, env.me.username);
  if (!cmd) return message.chat?.type === "private" ? ["Cairn answers commands. Send /help to see them."] : null;
  const c = COMMANDS.get(cmd.name);
  if (!c) return unknown(cmd.name);
  if (c.needsChain && !env.head) return nodeBusy();
  const started = Date.now();
  try {
    return await c.run({ ...env, args: cmd.args });
  } catch (e) {
    if (e instanceof NodeUnavailable) return nodeBusy();
    if (e?.name === "AbortError") throw e;
    env.log.error("command_failed", { command: c.name, error: String(e?.message ?? e).slice(0, 300) });
    return ["Something went wrong on Cairn's side while answering. The operator can find it in the logs; try again later."];
  } finally {
    env.log.debug("command", { command: c.name, chat_type: message.chat?.type, ms: Date.now() - started });
  }
}
