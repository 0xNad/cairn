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
