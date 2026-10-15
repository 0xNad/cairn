// /tx <hash>: finality, execution status, block and its time, fee in STRK, the registry tokens it moved or
// approved, the revert reason (escaped) and an explorer link. An unknown hash is "not found" (error 29).
import { CHAINS } from "../config.mjs";
import { UNLIMITED, decodeTokenEvent, isFeePayment } from "../events.mjs";
import { hex64, parseHash, toBig } from "../felt.mjs";
import { contractLink, escape, group, shortHex, txLink, units, utc } from "../format.mjs";
import { NodeUnavailable, RpcError } from "../rpc.mjs";
import { atBlock } from "../starknet.mjs";
import { invalid } from "./replies.mjs";

/** The fee tokens: FRI is STRK's smallest unit, WEI ETH's (old transactions). Their addresses are the same on both chains. */
const FEE_TOKENS = {
  FRI: { symbol: "STRK", address: 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938dn },
  WEI: { symbol: "ETH", address: 0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7n },
};
const FINALITY = {
  ACCEPTED_ON_L1: "Accepted on L1",
  ACCEPTED_ON_L2: "Accepted on L2",
  PRE_CONFIRMED: "Pre-confirmed, not final yet",
  CANDIDATE: "Candidate, not final yet",
  RECEIVED: "Received, not executed yet",
  REJECTED: "Rejected",
};
const TYPES = { INVOKE: "Invoke", DECLARE: "Declare", DEPLOY_ACCOUNT: "Account deployment", DEPLOY: "Deploy", L1_HANDLER: "L1 message" };
/** Token moves listed before "and N more". */
const MAX_MOVES = 10;
/** A longer revert reason is cut to its last characters, where Cairo puts the innermost failure. */
const MAX_REASON = 3000;

export const tx = {
  name: "tx",
  description: "Status, fee and token moves of a transaction",
  usage: "/tx &lt;hash&gt;",
  needsChain: true,
  async run({ args, config, chain }) {
    const h = parseHash(args[0]);
    if (h.error) return invalid(args[0], h.error, "a transaction hash", "Copy it from your wallet or the explorer: <code>/tx 0x…</code>");

    const [st, rc] = await Promise.allSettled([chain.txStatus(h.value), chain.receipt(h.value)]);
    const missing = (r) => r.status === "rejected" && r.reason instanceof RpcError && r.reason.code === 29;
    if (st.status === "rejected" && rc.status === "rejected") {
      if (missing(st) && missing(rc)) {
        return [`🔎 Transaction <code>${shortHex(h.hex)}</code> not found on ${CHAINS[config.chain].label}. If it was sent just now, try again in a few seconds; otherwise check the hash and the network.`];
      }
      throw [st, rc].find((r) => r.reason instanceof NodeUnavailable)?.reason ?? st.reason;
    }
    const status = st.status === "fulfilled" ? st.value : {};
    const receipt = rc.status === "fulfilled" ? rc.value : {};
    const block = receipt.block_number ?? undefined; // a pre-confirmed receipt has none yet
    const header = block === undefined ? null : await chain.header(atBlock(block)).catch(() => null);

    const execution = status.execution_status ?? receipt.execution_status;
    const finality = status.finality_status ?? receipt.finality_status;
    const lines = [
      `${execution === "SUCCEEDED" ? "✅ <b>Succeeded</b>" : execution === "REVERTED" ? "❌ <b>Reverted</b>" : "⏳ <b>Not executed yet</b>"} · ${escape(FINALITY[finality] ?? finality ?? "status unknown")}`,
      `Transaction ${txLink(config.explorer, h.hex)}${TYPES[receipt.type] ? ` · ${TYPES[receipt.type]}` : ""}`,
      block === undefined ? "Not in a block yet" : `Block ${group(block)}${header ? ` · ${utc(header.timestamp)}` : ""}`,
    ];
    const fee = feeOf(receipt.actual_fee);
    if (fee) lines.push(`Fee: ${units(fee.amount, 18)} ${fee.token.symbol}`);
    lines.push(...moves(receipt.events, config, { fee, sequencer: header?.sequencer }));

    const reason = receipt.revert_reason ?? status.failure_reason;
    if (execution === "REVERTED" && typeof reason === "string" && reason !== "") lines.push("", ...revert(reason));
    return lines;
  },
};

function feeOf(f) {
  try {
    const token = FEE_TOKENS[f?.unit];
    return token ? { token, amount: toBig(f.amount) } : null;
  } catch {
    return null;
  }
}

/** The registry tokens a receipt moved or approved, without the fee payment; others are counted. */
function moves(events, config, { fee, sequencer }) {
  if (!Array.isArray(events)) return [];
  const known = new Map(config.tokens.map((t) => [t.address, t]));
  const out = [];
  let others = 0;
  events.forEach((e, i) => {
    const ev = decodeTokenEvent(e);
    if (!ev || (fee && isFeePayment(events, i, { strk: fee.token.address, sequencer, fee: fee.amount }))) return;
    const t = known.get(ev.token);
    if (!t) return void others++;
    const who = (v) => contractLink(config.explorer, hex64(v));
    const token = contractLink(config.explorer, t.hex, t.symbol);
    if (ev.kind === "approval") out.push(`Approved ${ev.amount >= UNLIMITED ? "<b>unlimited</b>" : `<b>${units(ev.amount, t.decimals)}</b>`} ${token} for spender ${who(ev.to)}, from ${who(ev.from)}`);
    else if (ev.from === 0n) out.push(`<b>${units(ev.amount, t.decimals)}</b> ${token} minted to ${who(ev.to)}`);
    else if (ev.to === 0n) out.push(`<b>${units(ev.amount, t.decimals)}</b> ${token} burned from ${who(ev.from)}`);
    else out.push(`<b>${units(ev.amount, t.decimals)}</b> ${token}: ${who(ev.from)} → ${who(ev.to)}`);
  });
  if (!out.length && !others) return [];
  const lines = ["", "<b>Token moves</b>", ...out.slice(0, MAX_MOVES)];
  if (out.length > MAX_MOVES) lines.push(`and ${out.length - MAX_MOVES} more`);
  if (others) lines.push(`${out.length ? "Also " : ""}${others} transfer or approval event${others === 1 ? "" : "s"} of tokens outside this bot's list`);
  return lines;
}

/** The revert reason, escaped, in an expandable quote; a long one keeps its end. */
function revert(reason) {
  let shown = reason, title = "<b>Revert reason</b>";
  if (reason.length > MAX_REASON) {
    shown = reason.slice(-MAX_REASON).replace(/^[\udc00-\udfff]/, "");
    title += ` (its last ${group(shown.length)} of ${group(reason.length)} characters; the explorer has it all)`;
  }
  // Nodes add the decoded failure as ('…'): the last one is usually the innermost cause.
  const cause = [...reason.matchAll(/\('([^'\n]{1,120})'\)/g)].at(-1)?.[1];
  return [title, ...(cause ? [`Cause: <code>${escape(cause)}</code>`] : []), { quote: shown }];
}
