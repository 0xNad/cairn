// /balance <address>: balance_of on every registry token, in registry order, at the pass's head block, with
// exact amounts. "Not deployed" when the address has no class (error 20); one failing token shows an error
// for that token only.
import { parseAddress } from "../felt.mjs";
import { contractLink, group, units, utc } from "../format.mjs";
import { NodeUnavailable, RpcError } from "../rpc.mjs";
import { LATEST, atBlock, balanceOf } from "../starknet.mjs";
import { invalid, nodeBusy } from "./replies.mjs";

/** A valid address to show in a refusal: the STRK token, the same on mainnet and Sepolia. */
const EXAMPLE = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

export const balance = {
  name: "balance",
  description: "Token balances of an address",
  usage: "/balance &lt;address&gt;",
  needsChain: true,
  async run({ args, config, chain, head }) {
    const a = parseAddress(args[0]);
    if (a.error) return invalid(args[0], a.error, "an address", `For example, the STRK token contract: <code>/balance ${EXAMPLE}</code>`);

    // Every read is pinned to the head block, so the amounts belong together; a node that does not have
    // that block yet (error 24) is asked for its latest instead.
    let pinned = true;
    const read = async (f) => {
      try {
        return await f(atBlock(head.number));
      } catch (e) {
        if (!(e instanceof RpcError && e.code === 24)) throw e;
        pinned = false;
        return f(LATEST);
      }
    };
    const [deployed, ...amounts] = await Promise.allSettled([
      read((b) => chain.classHashAt(a.value, b)),
      ...config.tokens.map((t) => read((b) => balanceOf(chain, t.address, a.value, b))),
    ]);
    if (amounts.every((r) => r.status === "rejected" && r.reason instanceof NodeUnavailable)) return nodeBusy();

    const token = (t) => contractLink(config.explorer, t.hex, t.symbol);
    const lines = [`<b>Balances</b> of ${contractLink(config.explorer, a.hex)}`];
    if (deployed.status === "rejected" && deployed.reason instanceof RpcError && deployed.reason.code === 20) {
      lines.push("⚠️ Not deployed: no account or contract lives at this address yet. Tokens sent to it are still credited to it.");
    }
    lines.push("");
    const empty = [], failed = [];
    config.tokens.forEach((t, i) => {
      const r = amounts[i];
      if (r.status === "rejected") failed.push(`⚠️ ${token(t)}: ${why(r.reason)}`);
      else if (r.value === 0n) empty.push(token(t));
      else lines.push(`<b>${units(r.value, t.decimals)}</b> ${token(t)}`);
    });
    if (empty.length === config.tokens.length) lines.push(`None of the listed tokens: ${empty.join(", ")}.`);
    else if (empty.length) lines.push(`Nothing in ${empty.join(", ")}.`);
    lines.push(...failed, "", pinned ? `At block ${group(head.number)} · ${utc(head.timestamp)}` : `At the node's latest block (after ${group(head.number)})`);
    return lines;
  },
};

/** Why one token's balance could not be read, in words. */
function why(e) {
  if (e instanceof NodeUnavailable) return "the node is busy, try again in a minute";
  if (e instanceof RpcError && e.code === 20) return "the token contract was not found on this chain";
  if (e instanceof RpcError) return `the token contract answered with an error (RPC ${e.code}), so its balance is unknown`;
  return "the answer could not be read, so its balance is unknown";
}
