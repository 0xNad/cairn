// /start and /help: the commands, what the bot is and is not, what the operator stores, how to add it to a group.
import { esc } from "../../format.mjs";

function body({ username, commands }) {
  const lines = commands.map((c) => `/${c.name}${c.usage ? ` ${esc(c.usage)}` : ""} - ${esc(c.description)}`);
  const group = /^\w+$/.test(username ?? "") ? `\nAdd me to a group: <a href="https://t.me/${username}?startgroup=setup">https://t.me/${username}?startgroup=setup</a>` : "";
  return [
    "<b>Commands</b>",
    ...lines,
    "",
    "On-chain facts, not financial advice.",
    "Public balances and transfers only.",
    "Cairn only reads the chain: it holds no key, signs nothing and never asks for a seed phrase.",
    "",
    "<b>What the operator stores</b>: the id and type of the chats that write to me, and my place in the update queue. Message text, names and usernames are never stored.",
    group,
  ].join("\n").trimEnd();
}

export const start = {
  name: "start",
  description: "What Cairn does and how to use it",
  run: (ctx) => `👋 <b>Cairn</b> answers Starknet lookups in chat: balances, transactions and the state of the chain.\n\n${body(ctx)}`,
};

export const help = {
  name: "help",
  description: "List the commands",
  run: (ctx) => `<b>Cairn</b> - a read-only Starknet bot.\n\n${body(ctx)}`,
};
