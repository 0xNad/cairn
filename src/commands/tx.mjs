// /tx <hash>: finality, execution status, block, fee and, for a revert, its reason.
import { fromFelt, hex64, parseTxHash } from "../felt.mjs";
import { escapeHtml, formatInt, formatUnits, link, quote, txLink, utcTime } from "../format.mjs";
import { refusal } from "./input.mjs";

const EXECUTION = { SUCCEEDED: "✅ Succeeded", REVERTED: "❌ Reverted" };
const FINALITY = {
  RECEIVED: "Received by the node, not in a block yet",
  CANDIDATE: "Candidate, not in a block yet",
  PRE_CONFIRMED: "Pre-confirmed, not final yet",
  ACCEPTED_ON_L2: "Accepted on L2",
  ACCEPTED_ON_L1: "Accepted on L1 (final)",
};
/** The fee's unit as the token it is paid in: FRI is STRK's smallest unit, WEI ETH's. */
const FEE_TOKEN = { FRI: "STRK", WEI: "ETH" };

export const tx = {
  command: "tx",
  usage: "<hash>",
  description: "status, block and fee of a transaction",
  needsChain: true,
  parse: (args) => refusal(parseTxHash(args[0]), args[0], { what: "transaction hash", example: "/tx 0x05c2…9e1f" }),

  async run({ cfg, sn }, hash) {
    const status = await sn.txStatus(hash);
    if (!status) {
      return [
        `Transaction ${txLink(cfg.explorer, hash)} was not found on ${escapeHtml(cfg.chain)}.`,
        "If it was sent a moment ago, try again in a few seconds; otherwise check the hash and the network.",
      ];
    }
    const receipt = await sn.txReceipt(hash);
    const finality = receipt?.finality_status ?? status.finality_status;
    const execution = receipt?.execution_status ?? status.execution_status;
    const state = [EXECUTION[execution] ?? (execution ? escapeHtml(execution) : null), FINALITY[finality] ?? escapeHtml(finality ?? "unknown")];
    const lines = [`<b>Transaction</b> ${txLink(cfg.explorer, hash)}`, state.filter(Boolean).join(" · ")];

    if (receipt && Number.isInteger(receipt.block_number)) {
      const time = await sn.blockTime(receipt.block_number).catch(() => null);
      lines.push(`Block: ${formatInt(receipt.block_number)}${time ? ` · ${utcTime(time)}` : ""}`);
    }
    if (receipt?.actual_fee) {
      const unit = receipt.actual_fee.unit;
      lines.push(`Fee: ${formatUnits(fromFelt(receipt.actual_fee.amount), 18)} ${FEE_TOKEN[unit] ?? escapeHtml(unit)}`);
    }
    if (execution === "REVERTED") lines.push("", "<b>Revert reason</b>", quote(receipt?.revert_reason ?? status.failure_reason ?? "(the node gave none)"));
    lines.push("", link(`${cfg.explorer}/tx/${hex64(hash)}`, "Open in the explorer"));
    return lines;
  },
};
