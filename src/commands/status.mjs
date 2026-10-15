// /status: the chain, the head block and its time, the three gas prices in FRI, and the node's spec version.
import { escapeHtml, formatInt, utcTime } from "../format.mjs";

const LABEL = { SN_MAIN: "Starknet mainnet (SN_MAIN)", SN_SEPOLIA: "Starknet Sepolia testnet (SN_SEPOLIA)" };

export const status = {
  command: "status",
  description: "head block, gas prices, node version",
  needsChain: true,
  run({ head, chain }) {
    return [
      `<b>${escapeHtml(LABEL[chain.name] ?? chain.name)}</b>`,
      `Head block: <b>${formatInt(head.number)}</b>`,
      `Block time: ${utcTime(head.timestamp)}`,
      "",
      "<b>Gas prices</b> (1 FRI = 10⁻¹⁸ STRK)",
      `L1 gas: ${formatInt(head.gas.l1)} FRI`,
      `L1 data gas: ${formatInt(head.gas.l1Data)} FRI`,
      `L2 gas: ${formatInt(head.gas.l2)} FRI`,
      "",
      `Node: JSON-RPC spec ${escapeHtml(chain.spec)}`,
    ];
  },
};
