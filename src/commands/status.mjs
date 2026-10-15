// /status: the chain, the head block and its time, the three gas prices in FRI, and the node's spec version.
import { CHAINS } from "../config.mjs";
import { escape, group, utc } from "../format.mjs";

export const status = {
  name: "status",
  description: "Latest block, its time and gas prices",
  needsChain: true,
  run: ({ config, head, node }) => [
    `<b>${CHAINS[config.chain].label}</b> (${config.chain})`,
    `Block <b>${group(head.number)}</b> · ${utc(head.timestamp)}`,
    `${group(head.txCount)} transaction${head.txCount === 1 ? "" : "s"}${head.version ? ` · Starknet ${escape(head.version)}` : ""}`,
    "",
    "<b>Gas prices</b>, in FRI (10⁻¹⁸ STRK) per unit",
    `L1 gas: ${group(head.gas.l1)}`,
    `L1 data gas: ${group(head.gas.l1Data)}`,
    `L2 gas: ${group(head.gas.l2)}`,
    "",
    `Node: JSON-RPC ${escape(node.spec)}`,
  ],
};
