// /balance <address>: balance_of on every registry token, in registry order, exact amounts; "not deployed" when
// the address has no contract; a token whose call fails shows an error for that token only.
import { RPC } from "../../chain.mjs";
import { addressLink, esc, formatUnits, link } from "../../format.mjs";
import { parseAddress } from "../../felt.mjs";
import { NodeUnavailable, RpcError } from "../../rpc.mjs";
import { BUSY, refuse, settle } from "../text.mjs";

const USAGE = "/balance <address>";

function line(ctx, token, result) {
  const symbol = link(`${ctx.config.explorer}/contract/${token.address}`, token.symbol);
  if (result.ok) return `• ${formatUnits(result.value, token.decimals)} ${symbol}`;
  const e = result.error;
  if (e instanceof NodeUnavailable) return `• ${symbol}: ⚠️ unavailable (the node is busy)`;
  if (e instanceof RpcError) {
    const why = e.code === RPC.CONTRACT_NOT_FOUND ? "no such token contract" : e.code === RPC.CONTRACT_ERROR ? "the contract call failed" : `the node answered error ${e.code}`;
    return `• ${symbol}: ⚠️ error, ${why}`;
  }
  return `• ${symbol}: ⚠️ error, unexpected answer`;
}

export const balance = {
  name: "balance",
  usage: "<address>",
  description: "Token balances of an address",
  async run(ctx) {
    const parsed = parseAddress(ctx.args[0]);
    if (!parsed.ok) return refuse(parsed.reason, USAGE);
    if (!(await ctx.head())) return BUSY;

    const owner = parsed.int;
    const tokens = ctx.config.network.tokens.map((t) => ({ ...t, int: BigInt(t.address) }));
    const [deployed, ...results] = await Promise.all([
      settle(ctx.chain.isDeployed(owner), ctx.rethrow),
      ...tokens.map((t) => settle(ctx.chain.balance({ address: t.int }, owner), ctx.rethrow)),
    ]);
    if (results.every((r) => !r.ok && r.error instanceof NodeUnavailable)) return BUSY;

    const out = [`<b>Balances</b> of ${addressLink(ctx.config.explorer, parsed.value)}`];
    if (deployed.ok && deployed.value === false) {
      out.push(`⚠️ Not deployed: no contract is deployed at this address on ${esc(ctx.config.chain)}. The balances below are what the token contracts report.`);
    }
    out.push(...tokens.map((t, i) => line(ctx, t, results[i])));
    out.push("", `Shows the ${tokens.length} tokens in this bot's registry.`);
    return out.join("\n");
  },
};
