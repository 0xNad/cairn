// The commands, in the order /help lists them. A command is { name, description, usage?, run(ctx) -> html }.
import { balance } from "./balance.mjs";
import { help, start } from "./help.mjs";
import { status } from "./status.mjs";
import { tx } from "./tx.mjs";

export const COMMANDS = Object.freeze([start, help, status, balance, tx]);
export const BY_NAME = new Map(COMMANDS.map((c) => [c.name, c]));
/** What setMyCommands registers. */
export const BOT_COMMANDS = Object.freeze(COMMANDS.map((c) => ({ command: c.name, description: c.description })));
