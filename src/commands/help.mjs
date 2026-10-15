// /start and /help: what Cairn does, its commands, what it stores, and a link to add it to a group.
import { escapeHtml, link } from "../format.mjs";

function body(ctx) {
  const symbols = ctx.config.tokens.map((t) => t.symbol);
  const listed = symbols.length <= 8 ? symbols.join(", ") : `${symbols.slice(0, 7).join(", ")} and ${symbols.length - 7} more`;
  const lines = [
    `/status · the latest block on ${escapeHtml(ctx.config.chainName)}, its time and gas prices`,
    `/balance &lt;address&gt; · balances in ${escapeHtml(listed)}`,
    "/tx &lt;hash&gt; · status, block, fee, token moves and revert reason of a transaction",
    "/help · this list",
    "",
    "On-chain facts, not financial advice.",
    "Public balances and transfers only.",
    "",
    "<b>What is stored:</b> the operator of this bot keeps only Telegram's update counter and this command list. No messages, names or usernames are stored. The addresses and hashes you send are looked up on the operator's Starknet node.",
  ];
  if (ctx.me.username) lines.push("", link(`https://t.me/${ctx.me.username}?startgroup=setup`, "➕ Add Cairn to a group"));
  return lines;
}

export function help(args, ctx) {
  return ["<b>Cairn</b> reads Starknet for you. It never writes to the chain and never asks for a key.", "", ...body(ctx)];
}

// /start [payload]: the payload "setup" (from the add-to-group link) in a group gets a group welcome. Any
// other payload, valid (^[A-Za-z0-9_-]{1,64}$) or not, gets the plain welcome.
export function start(args, ctx, rest = "") {
  const setup = ctx.isGroup && rest === "setup";
  const intro = setup
    ? "👋 <b>Cairn is in this group.</b> Anyone here can use the commands below."
    : "👋 <b>Welcome to Cairn.</b> I look up Starknet balances and transactions, straight from the chain.";
  return [intro, "", ...body(ctx)];
}
