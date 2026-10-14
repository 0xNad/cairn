// /tx <hash>: finality, execution status, block, fee in STRK, the revert reason (escaped) and an explorer link.
import { esc, formatAmount, formatInt, txLink } from "../../format.mjs";
import { parseHash } from "../../felt.mjs";
import { NodeUnavailable } from "../../rpc.mjs";
import { BUSY, refuse } from "../text.mjs";

const USAGE = "/tx <hash>";
const FINALITY = {
  RECEIVED: "Received",
  CANDIDATE: "Candidate",
  PRE_CONFIRMED: "Pre-confirmed",
  ACCEPTED_ON_L2: "Accepted on L2",
  ACCEPTED_ON_L1: "Accepted on L1",
  REJECTED: "Rejected",
};
const EXECUTION = { SUCCEEDED: "✅ Succeeded", REVERTED: "❌ Reverted" };
/** A revert reason longer than this is cut: the explorer link has the rest. */
const REVERT_MAX = 3000;

/** Fees come in FRI (shown as STRK) or WEI (shown as ETH). */
function fee(f) {
  const symbol = f.unit === "WEI" ? "ETH" : f.unit === "FRI" ? "STRK" : null;
  return symbol ? formatAmount(f.amount, 18, symbol) : `${formatInt(f.amount)} ${esc(f.unit)}`;
}

export const tx = {
  name: "tx",
  usage: "<hash>",
  description: "Status, block and fee of a transaction",
  async run(ctx) {
    const parsed = parseHash(ctx.args[0]);
    if (!parsed.ok) return refuse(parsed.reason, USAGE);
    if (!(await ctx.head())) return BUSY;

    let found;
    try {
      found = await ctx.chain.transaction(parsed.int);
    } catch (e) {
      if (e instanceof NodeUnavailable) return BUSY;
      throw e;
    }
    const where = txLink(ctx.config.explorer, parsed.value);
    if (!found) return `🔍 Transaction ${where} was not found. It may not have been sent yet, or this node does not know it.`;

    const out = [`<b>Transaction</b> ${where}`];
    out.push(`Finality: ${found.finality ? esc(FINALITY[found.finality] ?? found.finality) : "unknown"}`);
    out.push(`Execution: ${found.execution ? EXECUTION[found.execution] ?? esc(found.execution) : "not executed yet"}`);
    out.push(`Block: ${found.block === null ? "not in a block yet" : formatInt(found.block)}`);
    if (found.fee) out.push(`Fee: ${fee(found.fee)}`);
    if (found.execution === "REVERTED" && found.revert) {
      const cut = found.revert.length > REVERT_MAX;
      out.push("Revert reason:", `<pre>${esc(cut ? found.revert.slice(0, REVERT_MAX) : found.revert)}</pre>`);
      if (cut) out.push("The reason is cut here: the explorer has all of it.");
    }
    return out.join("\n");
  },
};
