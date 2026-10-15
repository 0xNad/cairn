// /status: the chain, the head block and its time, the three gas prices in FRI, and the node's spec version.
import { formatInt, formatUtc } from "../../format.mjs";
import { esc } from "../../format.mjs";
import { BUSY } from "../text.mjs";

const NAMES = { SN_MAIN: "Starknet Mainnet", SN_SEPOLIA: "Starknet Sepolia" };

export const status = {
  name: "status",
  description: "Chain, head block, gas prices and node version",
  async run(ctx) {
    const head = await ctx.head();
    if (!head) return BUSY;
    const chain = ctx.config.chain;
    return [
      `<b>${esc(NAMES[chain] ?? chain)}</b> (${esc(chain)})`,
      `Head block: <b>${formatInt(head.number)}</b>`,
      `Block time: ${formatUtc(head.timestamp)}`,
      "",
      "<b>Gas prices</b> (FRI)",
      `L1: ${formatInt(head.gas.l1)}`,
      `L1 data: ${formatInt(head.gas.l1Data)}`,
      `L2: ${formatInt(head.gas.l2)}`,
      "",
      `Node spec: ${esc(head.spec ?? "unknown")}`,
    ].join("\n");
  },
};
