// /status: the chain, the head block and its time, the three gas prices in FRI, the node's spec version.
import { escapeHtml, formatTime, groupDigits } from "../format.mjs";

const fri = (v) => (v === null || v === undefined ? "not given by the node" : `${groupDigits(v)} FRI`);

export default async function status(args, ctx) {
  const head = await ctx.head();
  return [
    `⛓ <b>${escapeHtml(ctx.config.chainName)}</b> (${escapeHtml(ctx.config.chain)})`,
    `Block <b>${groupDigits(head.number)}</b> · ${formatTime(head.timestamp)}`,
    "",
    "<b>Gas prices</b>",
    `L1 gas: ${fri(head.gas.l1)}`,
    `L1 data gas: ${fri(head.gas.l1Data)}`,
    `L2 gas: ${fri(head.gas.l2)}`,
    "",
    `Node: JSON-RPC ${escapeHtml(ctx.spec)}`,
  ];
}
