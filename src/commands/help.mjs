// /start and /help: what Cairn does, every command, what it stores, and how to add it to a group.

/** The welcome, the same for /start and /help (a /start payload of "setup", from the group link, adds a line). */
export function welcome({ me, payload }) {
  const lines = [];
  if (payload === "setup") lines.push("<b>Cairn is set up in this chat.</b> Every member can use the lookups below.", "");
  lines.push(
    "<b>Cairn</b> answers Starknet lookups straight from the chain.",
    "",
    "/status · the latest block, its time and the gas prices",
    "/balance &lt;address&gt; · what a wallet or contract holds",
    "/tx &lt;hash&gt; · status, fee, token moves and revert reason of a transaction",
    "/help · this message",
    "",
    "On-chain facts, not financial advice.",
    "Public balances and transfers only.",
    "Cairn only reads the chain: it never asks for a key or a seed phrase, and never sends a transaction.",
    "",
    "<b>What the operator stores:</b> the number of the last update Cairn handled and the command menu it set. Never your messages, your name or your username.",
    "",
    `<a href="https://t.me/${me.username}?startgroup=setup">Add Cairn to a group</a>`,
  );
  return lines;
}

export const start = {
  name: "start",
  description: "What Cairn does",
  run: ({ me, args }) => welcome({ me, payload: /^[A-Za-z0-9_-]{1,64}$/.test(args[0] ?? "") && args.length === 1 ? args[0] : null }),
};

export const help = {
  name: "help",
  description: "Commands and what Cairn stores",
  run: ({ me }) => welcome({ me }),
};
