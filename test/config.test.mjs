import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, secretsOf, validateNetwork } from "../src/config.mjs";
import { Fatal } from "../src/errors.mjs";

// Built at run time, so that no token-shaped string sits in the repository.
const TOKEN = ["123456", "A".repeat(35)].join(":");
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, STARKNET_RPC_URL: "https://rpc.example/v0_10/key-1234567890?apikey=query-secret-1" };

const refused = (env) => {
  try {
    loadConfig(env);
  } catch (e) {
    assert.ok(e instanceof Fatal);
    assert.equal(e.exitCode, 2);
    return e.message;
  }
  assert.fail("the configuration was accepted");
};

test("defaults, and the bundled network file", () => {
  const c = loadConfig(ENV);
  assert.equal(c.telegramApiRoot, "https://api.telegram.org");
  assert.equal(c.chain, "SN_MAIN");
  assert.equal(c.explorer, "https://voyager.online");
  assert.deepEqual([c.pollMs, c.tgTimeout, c.rpcRps, c.rpcTimeoutMs], [10000, 30, 5, 10000]);
  assert.deepEqual(c.tokens.map((t) => t.symbol), ["STRK", "ETH", "USDC", "USDC.e", "USDT", "WBTC"]);
  assert.equal(loadConfig({ ...ENV, CAIRN_CHAIN: "SN_SEPOLIA" }).tokens.length, 4);
});

test("bad values are refused without repeating a secret", () => {
  assert.match(refused({ ...ENV, TELEGRAM_BOT_TOKEN: "123456:short" }), /TELEGRAM_BOT_TOKEN/);
  assert.match(refused({ ...ENV, TELEGRAM_API_ROOT: "https://api.telegram.org/bot" }), /no path/);
  assert.match(refused({ ...ENV, STARKNET_RPC_URL: "localhost:8545" }), /STARKNET_RPC_URL/);
  for (const v of ["49", "1e3", "10abc", "-1", "2.5"]) assert.match(refused({ ...ENV, CAIRN_POLL_MS: v }), /CAIRN_POLL_MS/);
  assert.match(refused({ ...ENV, CAIRN_TG_TIMEOUT: "51" }), /from 0 to 50/);
  assert.match(refused({ ...ENV, CAIRN_LOG: "loud" }), /CAIRN_LOG/);
  const all = refused({ CAIRN_CHAIN: "SN_GOERLI" });
  for (const name of ["TELEGRAM_BOT_TOKEN", "STARKNET_RPC_URL", "CAIRN_CHAIN"]) assert.match(all, new RegExp(name), "every problem is named at once");
  assert.ok(!refused({ ...ENV, CAIRN_RPC_RPS: "0" }).includes("key-1234567890"));
});

test("an empty value counts as unset", () => {
  assert.equal(loadConfig({ ...ENV, CAIRN_POLL_MS: "", CAIRN_CHAIN: " " }).pollMs, 10000);
});

test("a bad network file names the bad entry's JSON path", () => {
  const ok = { symbol: "STRK", address: "0x1", decimals: 18 };
  const problems = (doc) => validateNetwork(doc, "SN_MAIN").map(([at]) => at);
  assert.deepEqual(problems({ chain: "SN_MAIN", tokens: [ok, { ...ok, symbol: "strk", address: "0x01" }] }), ["tokens[1].symbol", "tokens[1].address"]);
  assert.deepEqual(problems({ chain: "SN_SEPOLIA", tokens: [ok] }), ["chain"]);
  assert.deepEqual(problems({ chain: "SN_MAIN", tokens: [{ ...ok, decimals: 6.5 }] }), ["tokens[0].decimals"]);
  assert.deepEqual(problems({ chain: "SN_MAIN", tokens: [] }), ["tokens"]);
  const dir = mkdtempSync(join(tmpdir(), "cairn-test-"));
  writeFileSync(join(dir, "net.json"), JSON.stringify({ chain: "SN_MAIN", tokens: [{ ...ok, decimals: 37 }] }));
  assert.match(refused({ ...ENV, CAIRN_NETWORK_FILE: join(dir, "net.json") }), /net\.json: tokens\[0\]\.decimals: /);
  assert.match(refused({ ...ENV, CAIRN_NETWORK_FILE: join(dir, "missing.json") }), /missing\.json: no such file/);
});

test("the secrets are the token and everything in the RPC URL beyond its origin", () => {
  const s = secretsOf(ENV);
  for (const x of [TOKEN, "A".repeat(35), "key-1234567890", "query-secret-1"]) assert.ok(s.includes(x), x);
  assert.ok(!s.includes("https://rpc.example"));
  assert.deepEqual(secretsOf({ STARKNET_RPC_URL: "https://starknet-rpc.publicnode.com" }), []);
});
