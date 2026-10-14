// /balance <address>: balance_of on every registry token, in registry order (balanceOf on error 21), as
// exact amounts. Zero balances share one line; a token whose call fails shows an error without hiding the
// others; an address with no contract (getClassHashAt answers 20) is flagged "not deployed".
import { parseAddress } from "../felt.mjs";
import { addressLink, contractUrl, escapeHtml, formatUnits, groupDigits, link } from "../format.mjs";
import { NodeUnavailable, RpcError } from "../rpc.mjs";

const settle = (p) => p.then((value) => ({ value }), (error) => ({ error }));

export default async function balance(args, ctx) {
  if (args.length === 0) return ["Send an address with it: <code>/balance 0x…</code>"];
  if (args.length > 1) return ["/balance takes one address: <code>/balance 0x…</code>"];
  const parsed = parseAddress(args[0]);
  if (parsed.error) return [`⚠️ Not a valid address: ${escapeHtml(parsed.error)}.`];
  const owner = parsed.value;
  const { explorer, tokens, chainName } = ctx.config;

  const head = await ctx.head();
  const [deployed, ...results] = await Promise.all([settle(ctx.chain.deployed(owner)), ...tokens.map((t) => settle(ctx.chain.balance(t.address, owner)))]);
  if (ctx.stop?.aborted) throw ctx.stop.reason;
  // A token call can fail only as the node's error or the node being unavailable; anything else is a bug.
  for (const r of [deployed, ...results]) if (r.error && !(r.error instanceof RpcError) && !(r.error instanceof NodeUnavailable)) throw r.error;
  if (results.every((r) => r.error instanceof NodeUnavailable)) throw results[0].error;

  const lines = [`💰 <b>Balances</b> of ${addressLink(explorer, owner)}`, `${escapeHtml(chainName)} · block ${groupDigits(head.number)}`, ""];
  const zero = [], failed = [];
  tokens.forEach((t, i) => {
    const r = results[i];
    if (r.error) failed.push(`⚠️ ${escapeHtml(t.symbol)}: ${r.error instanceof NodeUnavailable ? "the node was busy, try again" : `the token contract answered an error (code ${r.error.code})`}`);
    else if (r.value === 0n) zero.push(escapeHtml(t.symbol));
    else lines.push(`<b>${formatUnits(r.value, t.decimals)}</b> ${link(contractUrl(explorer, t.address), escapeHtml(t.symbol))}`);
  });
  const empty = zero.length === tokens.length;
  if (empty) lines.push(`No balance in ${zero.join(", ")}.`);
  else if (zero.length) lines.push(`Zero: ${zero.join(", ")}`);
  if (failed.length) lines.push("", ...failed);
  if (deployed.value === false) {
    lines.push("", empty
      ? "ℹ️ Not deployed: there is no contract at this address and it holds none of these tokens. Check the address; if it is a transaction hash, try /tx."
      : "ℹ️ Not deployed: there is no account contract at this address yet. Its balances are still real.");
  }
  return lines;
}
