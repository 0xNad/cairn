// The chat commands: the registry setMyCommands and /help are built from, and the parser that decides
// whether a message is a command addressed to Cairn.
import { escapeHtml } from "../format.mjs";
import { balance } from "./balance.mjs";
import { help, start } from "./help.mjs";
import { status } from "./status.mjs";
import { tx } from "./tx.mjs";

/** In /help order. Later rounds add their commands here. */
export const COMMANDS = [status, balance, tx, help, start];
const BY_NAME = new Map(COMMANDS.map((c) => [c.command, c]));

/** The list setMyCommands registers. */
export const botCommands = () => COMMANDS.map((c) => ({ command: c.command, description: c.description }));

export const lookup = (name) => BY_NAME.get(name) ?? null;

/**
 * Parses `^/(\w+)(@(\w+))?`: { name, args } for `/cmd` and `/cmd@<username>`, or null for plain text and
 * for a command addressed to another bot.
 */
export function parseCommand(text, username) {
  const m = /^\/(\w+)(@(\w+))?/.exec(text);
  if (!m) return null;
  if (m[3] !== undefined && m[3].toLowerCase() !== String(username).toLowerCase()) return null;
  return { name: m[1].toLowerCase(), args: text.slice(m[0].length).trim().split(/\s+/).filter(Boolean) };
}

export const unknownCommand = (name) => [`Unknown command /${escapeHtml(name)}. Send /help for the list of commands.`];
export const notACommand = () => ["Cairn answers commands. Send /help for the list."];
export const nodeBusy = () => ["⏳ The Starknet node is busy or unreachable right now (node busy). Try again in a minute."];
