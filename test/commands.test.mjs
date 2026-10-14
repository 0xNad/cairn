import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCommand, route } from "../src/commands/index.mjs";

const ctx = (isGroup) => ({
  isGroup, me: { username: "cairn_bot" }, spec: "0.10.3", head: async () => null,
  config: { chain: "SN_MAIN", chainName: "Starknet mainnet", explorer: "https://voyager.online", tokens: [{ symbol: "STRK", address: 1n, decimals: 18 }] },
});

test("commands are parsed as ^/(\\w+)(@(\\w+))?", () => {
  assert.deepEqual(parseCommand("/Balance@Cairn_Bot 0x1"), { name: "balance", bot: "Cairn_Bot", rest: "0x1" });
  assert.equal(parseCommand("gm /status"), null);
});

test("in a group: its own commands only, never plain text or another bot's commands", async () => {
  assert.deepEqual(await route("/status@other_bot", ctx(true)), []);
  assert.deepEqual(await route("what is the head block?", ctx(true)), []);
  assert.deepEqual(await route("/zz_unknown", ctx(true)), [], "a bare unknown command may be another bot's");
  assert.match((await route("/zz_unknown@cairn_bot", ctx(true))).join("\n"), /\/help/);
  assert.match((await route("/help@CAIRN_BOT", ctx(true))).join("\n"), /On-chain facts, not financial advice\./);
});

test("chain commands answer node busy without a head, and bad input is refused first", async () => {
  assert.match((await route("/status", ctx(false))).join("\n"), /busy/);
  assert.match((await route("/zz_unknown", ctx(false))).join("\n"), /\/help/);
  assert.match((await route("hello", ctx(false))).join("\n"), /\/help/);
});

test("a malformed /start payload gets the plain welcome, and setup in a group the group welcome", async () => {
  const plain = await route("/start", ctx(false));
  for (const p of ["a".repeat(65), "bad$payload", "<b>x</b>", "ab/cd", "setup"]) assert.deepEqual(await route(`/start ${p}`, ctx(false)), plain, p);
  assert.match((await route("/start@cairn_bot setup", ctx(true)))[0], /in this group/);
});

const txCtx = (receipt, isGroup = false) => ({
  ...ctx(isGroup), head: async () => ({ number: 10 }),
  chain: { receipt: async () => receipt, block: async () => ({ timestamp: 1_760_000_000 }) },
});

test("/tx names a type other than invoke, and an L1 handler's fee is paid on Ethereum", async () => {
  const text = (await route("/tx 0x1", txCtx({ type: "L1_HANDLER", finality_status: "ACCEPTED_ON_L2", execution_status: "SUCCEEDED", block_number: 5, actual_fee: { amount: "0x0", unit: "WEI" }, events: [] }))).join("\n");
  assert.match(text, /Type: L1 handler/);
  assert.match(text, /paid on Ethereum/);
  assert.doesNotMatch(text, /0 ETH/);
});

test("/tx shows a revert reason whole in a private chat and cut in a group", async () => {
  const reason = `${"x".repeat(3000)} ('ERC20: insufficient balance')`;
  const receipt = { type: "INVOKE", finality_status: "ACCEPTED_ON_L2", execution_status: "REVERTED", block_number: 5, actual_fee: { amount: "0x2386f26fc10000", unit: "FRI" }, revert_reason: reason, events: [] };
  const dm = (await route("/tx 0x1", txCtx(receipt))).join("\n");
  assert.match(dm, /Reason: <b>ERC20: insufficient balance<\/b>/);
  assert.match(dm, /0\.01<\/b> STRK, charged even though it reverted/);
  assert.ok(dm.includes("x".repeat(2900)));
  const group = (await route("/tx 0x1", txCtx(receipt, true))).join("\n");
  assert.match(group, /cut here, the full reason is on the explorer/);
  assert.ok(!group.includes("x".repeat(1600)));
});
