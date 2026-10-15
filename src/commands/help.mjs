// /start and /help: what Cairn answers, what it is not, what the operator stores, and how to add it to a group.
import { escapeHtml, link } from "../format.mjs";

/** The help text; `commands` is the registry, so a command added in a later round is listed here too. */
export function helpText(ctx, commands) {
  const username = ctx.me.username;
  return [
    "<b>Cairn</b> answers Starknet lookups straight from the chain.",
    "",
    ...commands.filter((c) => c.listed !== false).map((c) => `/${c.command}${c.usage ? ` ${escapeHtml(c.usage)}` : ""} — ${escapeHtml(c.description)}`),
    "",
    "On-chain facts, not financial advice.",
    "Public balances and transfers only.",
    "Cairn only reads the chain: it never asks for a seed phrase or a key, and never signs anything.",
    "",
    "<b>What this bot's operator stores:</b> the id and type of each chat that sends a command, and the id of the last update handled. Never your messages, names or usernames.",
    "",
    link(`https://t.me/${username}?startgroup=setup`, "Add Cairn to a group"),
  ];
}

export const start = {
  command: "start",
  description: "welcome and the list of commands",
  listed: false,
  // Round 1 reads no /start payload: every /start, `setup` from the group link included, gets the plain
  // welcome. A later round that acts on one accepts only ^[A-Za-z0-9_-]{1,64}$.
  run: (ctx, args, { commands }) => helpText(ctx, commands),
};

export const help = {
  command: "help",
  description: "this list",
  run: (ctx, args, { commands }) => helpText(ctx, commands),
};
