// Chat commands: parsing, group addressing and routing. A command module exports a function
// (args, ctx) → lines of HTML (the bot packs them into messages). `ctx` holds me (getMe), config, chain
// (src/starknet.mjs), head() (the latest block, or null when the node is down), spec, isGroup and stop.
import { escapeHtml } from "../format.mjs";
import balance from "./balance.mjs";
import { help, start } from "./help.mjs";
import status from "./status.mjs";
import tx from "./tx.mjs";

// The command list, in the order /help and setMyCommands show it. `chain` commands need the node.
export const COMMANDS = [
  { name: "start", description: "Welcome, and what Cairn does", run: start },
  { name: "help", description: "The commands, and what Cairn stores", run: help },
  { name: "status", description: "Latest block, its time and gas prices", run: status, chain: true },
  { name: "balance", description: "Token balances of an address: /balance 0x…", run: balance, chain: true },
  { name: "tx", description: "Status, fee and revert reason of a transaction: /tx 0x…", run: tx, chain: true },
];

export const BUSY = ["⏳ The Starknet node is busy or unreachable, so I could not look this up. Please try again in a minute."];

// "/cmd@bot args" → { name, bot, rest }, or null when the text is not a command (ARCHITECTURE.md's
// ^/(\w+)(@(\w+))?). The name is lower-cased: Telegram commands are not case-sensitive.
export function parseCommand(text) {
  const m = /^\/(\w+)(?:@(\w+))?(.*)$/s.exec(String(text));
  return m ? { name: m[1].toLowerCase(), bot: m[2] ?? null, rest: m[3].trim() } : null;
}

// The reply to a message's text, as lines of HTML; [] means no reply.
export async function route(text, ctx) {
  const cmd = parseCommand(text);
  if (!cmd) {
    // Plain text: ignored in groups (it is people talking); a hint in a private chat.
    return ctx.isGroup ? [] : ["Send /balance 0x… for an address's balances, /tx 0x… for a transaction, or /help for everything I can do."];
  }
  if (cmd.bot && cmd.bot.toLowerCase() !== String(ctx.me.username).toLowerCase()) return []; // another bot's
  const def = COMMANDS.find((c) => c.name === cmd.name);
  if (!def) {
    // In a group a bare unknown command is most likely another bot's: only /zz@cairn gets a hint there.
    if (ctx.isGroup && !cmd.bot) return [];
    return [`I don't know /${escapeHtml(cmd.name)}. Send /help to see what I can do.`];
  }
  const args = cmd.rest === "" ? [] : cmd.rest.split(/\s+/);
  if (def.chain && !(await ctx.head())) return BUSY;
  return def.run(args, ctx, cmd.rest);
}
