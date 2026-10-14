// /balance <address>: the address's balance of every registry token, in registry order, at the head block.
import { hex64, parseAddress } from "../felt.mjs";
import { contractLink, escapeHtml, formatInt, formatUnits, link, utcTime } from "../format.mjs";
import { NodeUnavailable, RpcError } from "../rpc.mjs";
import { ERROR } from "../starknet.mjs";
import { refusal } from "./input.mjs";

/** Why one token's balance could not be read, in plain words. */
function failure(e) {
  if (e instanceof NodeUnavailable) return "node busy, try again in a minute";
  if (e instanceof RpcError && e.code === ERROR.CONTRACT_ERROR) return "the token contract failed this call";
  if (e instanceof RpcError) return `the node answered with error ${e.code}`;
  return "the node's answer could not be read";
}

export const balance = {
  command: "balance",
  usage: "<address>",
  description: "token balances of an address",
  needsChain: true,
  parse: (args) => refusal(parseAddress(args[0]), args[0], { what: "address", example: "/balance 0x0471…938d" }),

  async run({ cfg, sn, head, log }, address) {
    const block = head.number;
    const [deployed, ...balances] = await Promise.all([
      sn.isDeployed(address, block).catch((e) => e),
      ...cfg.network.tokens.map((t) => sn.balance(t.address, address, block).catch((e) => e)),
    ]);
    if (balances.every((b) => b instanceof NodeUnavailable)) throw balances[0];
    const lines = [
      `<b>Balances</b> of ${contractLink(cfg.explorer, address)}`,
      `At block ${formatInt(block)} · ${utcTime(head.timestamp)}`,
    ];
    if (deployed === false) lines.push("⚠️ Not deployed: no contract at this address yet. It can still hold tokens: its balances are below.");
    lines.push("");
    cfg.network.tokens.forEach((t, i) => {
      const symbol = link(`${cfg.explorer}/contract/${hex64(t.address)}`, escapeHtml(t.symbol));
      const b = balances[i];
      if (typeof b === "bigint") return lines.push(`<b>${formatUnits(b, t.decimals)}</b> ${symbol}`);
      log.warn("balance_failed", { token: t.symbol, reason: b.message });
      lines.push(`⚠️ ${symbol}: ${failure(b)}`);
    });
    return lines;
  },
};
