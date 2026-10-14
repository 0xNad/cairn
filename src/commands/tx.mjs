// /tx <hash>: execution status and finality, block and time, fee in STRK, the token moves of registry
// tokens, the revert reason (escaped, in <pre>) and an explorer link. An unknown hash is "not found".
import { transfersOf } from "../events.mjs";
import { parseTxHash, shortHex, toBig } from "../felt.mjs";
import { addressLink, contractUrl, escapeHtml, formatTime, formatUnits, groupDigits, link, preBlocks, txLink } from "../format.mjs";
import { RpcError } from "../rpc.mjs";
import { ERR, FEE_TOKENS } from "../starknet.mjs";

const FINALITY = {
  RECEIVED: "Received, not in a block yet",
  CANDIDATE: "Candidate, not in a block yet",
  PRE_CONFIRMED: "Pre-confirmed, not in an accepted block yet",
  ACCEPTED_ON_L2: "Accepted on L2",
  ACCEPTED_ON_L1: "Accepted on L1",
  REJECTED: "Rejected",
};
const EXECUTION = { SUCCEEDED: ["✅", "Succeeded"], REVERTED: ["❌", "Reverted"] };
// Every type but INVOKE, the usual one, is named in the reply.
const TYPES = { L1_HANDLER: "L1 handler (a message from Ethereum)", DECLARE: "class declaration", DEPLOY_ACCOUNT: "account deployment", DEPLOY: "deployment" };
const MAX_MOVES = 10;
// In a group a long revert reason is cut, so that one lookup does not flood the chat.
const GROUP_REASON_CHARS = 1500;

const notTx = (e) => e instanceof RpcError && e.code === ERR.TX_NOT_FOUND;

export default async function tx(args, ctx) {
  if (args.length === 0) return ["Send a transaction hash with it: <code>/tx 0x…</code>"];
  if (args.length > 1) return ["/tx takes one transaction hash: <code>/tx 0x…</code>"];
  const parsed = parseTxHash(args[0]);
  if (parsed.error) return [`⚠️ Not a valid transaction hash: ${escapeHtml(parsed.error)}.`];
  const hash = parsed.value;
  const { explorer, tokens, chainName } = ctx.config;

  // The receipt has everything once the transaction is in a block; before that, only its status exists.
  let receipt = null, status = null;
  try {
    receipt = await ctx.chain.receipt(hash);
  } catch (e) {
    if (!notTx(e)) throw e;
    try {
      status = await ctx.chain.status(hash);
    } catch (e2) {
      if (!notTx(e2)) throw e2;
      return [`🔍 Transaction not found: ${escapeHtml(shortHex(hash))} is not known on ${escapeHtml(chainName)}. Check the hash and the network; a transaction just sent can take a few seconds to appear. If it is an address, try /balance.`];
    }
  }
  const finality = receipt?.finality_status ?? status?.finality_status;
  const execution = receipt?.execution_status ?? status?.execution_status;
  const [icon, outcome] = EXECUTION[execution] ?? ["⏳", execution ? escapeHtml(execution) : "Pending"];
  const lines = [`${icon} <b>${outcome}</b> · ${escapeHtml(FINALITY[finality] ?? finality ?? "status unknown")}`, `Transaction ${txLink(explorer, hash)}`];
  if (receipt?.type && receipt.type !== "INVOKE") lines.push(`Type: ${escapeHtml(TYPES[receipt.type] ?? receipt.type)}`);

  const block = receipt?.block_number;
  if (Number.isSafeInteger(block)) {
    // The block's time is a nicety: without it the reply still stands.
    const time = await ctx.chain.block(block).then((b) => b.timestamp, () => null);
    lines.push(`Block ${groupDigits(block)}${time === null ? "" : ` · ${formatTime(time)}`}`);
  }

  const feeToken = FEE_TOKENS[receipt?.actual_fee?.unit];
  const fee = toBig(receipt?.actual_fee?.amount);
  if (receipt?.type === "L1_HANDLER") lines.push("Fee: paid on Ethereum, with the L1 message");
  else if (fee !== null) {
    const amount = feeToken ? `<b>${formatUnits(fee, feeToken.decimals)}</b> ${feeToken.symbol}` : `<b>${groupDigits(fee)}</b> ${escapeHtml(receipt.actual_fee.unit)}`;
    lines.push(`Fee: ${amount}${execution === "REVERTED" ? ", charged even though it reverted" : ""}`);
  }

  if (receipt) lines.push(...moves(receipt, feeToken, tokens, explorer));

  const reason = receipt?.revert_reason ?? status?.failure_reason;
  if (reason && (execution === "REVERTED" || finality === "REJECTED")) lines.push("", ...revert(String(reason), ctx.isGroup));
  return lines;
}

// The registry tokens' transfers, fee payment aside; transfers of other tokens are counted.
function moves(receipt, feeToken, tokens, explorer) {
  const all = transfersOf(receipt, feeToken);
  const known = new Map(tokens.map((t) => [t.address, t]));
  const shown = all.filter((m) => known.has(m.token));
  const lines = [];
  if (shown.length) lines.push("", "<b>Token moves</b>");
  for (const m of shown.slice(0, MAX_MOVES)) {
    const t = known.get(m.token);
    lines.push(`${formatUnits(m.amount, t.decimals)} ${link(contractUrl(explorer, t.address), escapeHtml(t.symbol))}: ${addressLink(explorer, m.from)} → ${addressLink(explorer, m.to)}`);
  }
  if (shown.length > MAX_MOVES) lines.push(`…and ${shown.length - MAX_MOVES} more on the explorer`);
  const others = all.length - shown.length;
  if (others) lines.push(...(shown.length ? [] : [""]), `${others} transfer${others === 1 ? "" : "s"} of tokens outside Cairn's list: see the explorer`);
  return lines;
}

// The revert reason: its innermost message in bold when there is one ('…' in parentheses), then the
// whole reason as preformatted text.
function revert(reason, isGroup) {
  const inner = [...reason.matchAll(/\('([^'\n]{1,120})'\)/g)].at(-1)?.[1];
  let text = reason;
  const chars = [...text];
  if (isGroup && chars.length > GROUP_REASON_CHARS) text = `${chars.slice(0, GROUP_REASON_CHARS).join("")}\n… cut here, the full reason is on the explorer`;
  return [inner ? `Reason: <b>${escapeHtml(inner)}</b>` : "<b>Revert reason</b>", ...preBlocks(text)];
}
