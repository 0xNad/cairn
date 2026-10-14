import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, validateNetwork } from "../src/config.mjs";
import { ExitError } from "../src/errors.mjs";

const GOOD = { TELEGRAM_BOT_TOKEN: ["123456", "abcdefghijklmnopqrstuvwxyzABCDEF"].join(":"), STARKNET_RPC_URL: "https://node.example/rpc/KEY12345" };

test("defaults, and the two secrets are not enumerable", () => {
  const c = loadConfig(GOOD);
  assert.equal(c.chain, "SN_MAIN");
  assert.equal(c.pollMs, 10000);
  assert.equal(c.network.tokens.length, 6);
  assert.equal(c.token, GOOD.TELEGRAM_BOT_TOKEN);
  assert.ok(!JSON.stringify(c).includes("abcdefghij"));
  assert.ok(!JSON.stringify(c).includes("KEY12345"));
});

test("every problem is reported, and none repeats a value", () => {
  assert.throws(
    () => loadConfig({ TELEGRAM_BOT_TOKEN: "nope-SECRET", CAIRN_POLL_MS: "1e3", CAIRN_RPC_RPS: "0" }),
    (e) => {
      assert.ok(e instanceof ExitError && e.code === 2);
      assert.ok(e.lines.length >= 4);
      assert.ok(!e.message.includes("SECRET"));
      return true;
    },
  );
});

test("network files name the bad entry's path", () => {
  const good = { symbol: "A", address: "0x1", decimals: 6 };
  const r = validateNetwork({ chain: "SN_MAIN", tokens: [good, { ...good, symbol: "a", address: "0x2", decimals: 37 }] }, { name: "n.json", chain: "SN_MAIN" });
  assert.deepEqual(r.problems.map((p) => p.split(": ").slice(0, 2).join(": ")), ["n.json: tokens[1].symbol", "n.json: tokens[1].decimals"]);
});
