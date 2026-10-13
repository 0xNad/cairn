import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import { Exit } from "../src/errors.mjs";
import { secretsOf } from "../src/log.mjs";

// Built at run time, so that no token-shaped string sits in the repository.
const TOKEN = ["123456789", "x".repeat(35)].join(":");
const RPC = "https://rpc.example/v0_10/key-0123456789abcdef?apikey=QUERY-SECRET-42";
const env = (extra = {}) => ({ TELEGRAM_BOT_TOKEN: TOKEN, STARKNET_RPC_URL: RPC, ...extra });

function problems(e) {
  try {
    loadConfig(e);
  } catch (err) {
    assert.ok(err instanceof Exit && err.code === 2);
    return err.reasons;
  }
  assert.fail("the configuration was accepted");
}

test("the defaults, with the committed SN_MAIN network file", () => {
  const c = loadConfig(env());
  assert.equal(c.telegramRoot, "https://api.telegram.org");
  assert.equal(c.chain, "SN_MAIN");
  assert.equal(c.explorer, "https://voyager.online");
  assert.deepEqual([c.pollMs, c.tgTimeout, c.rps, c.rpcTimeoutMs, c.data, c.logLevel], [10000, 30, 5, 10000, "./data", "info"]);
  assert.deepEqual(c.tokens.map((t) => t.symbol), ["STRK", "ETH", "USDC", "USDC.e", "USDT", "WBTC"]);
  assert.equal(loadConfig(env({ CAIRN_CHAIN: "SN_SEPOLIA" })).tokens.length, 4);
});

test("every problem is reported at once, and no secret is quoted", () => {
  const p = problems({ STARKNET_RPC_URL: "ftp://secret-host/key-0123456789", CAIRN_POLL_MS: "1e3", CAIRN_RPC_RPS: "101", CAIRN_LOG: "loud" });
  assert.equal(p.length, 5);
  assert.match(p.join("\n"), /TELEGRAM_BOT_TOKEN is required/);
  assert.doesNotMatch(p.join("\n"), /secret-host|key-0123/);
});

test("numbers are whole decimal digits within their range", () => {
  for (const [k, v] of [["CAIRN_POLL_MS", "49"], ["CAIRN_POLL_MS", "10abc"], ["CAIRN_TG_TIMEOUT", "51"], ["CAIRN_TG_TIMEOUT", "-1"], ["CAIRN_RPC_RPS", "2.5"], ["CAIRN_RPC_TIMEOUT_MS", "99"], ["CAIRN_POLL_MS", ""]]) {
    assert.match(problems(env({ [k]: v }))[0], new RegExp(k), `${k}=${v}`);
  }
  assert.equal(loadConfig(env({ CAIRN_TG_TIMEOUT: "0", CAIRN_POLL_MS: "50" })).tgTimeout, 0);
});

test("the API root is an origin; the RPC URL's credentials become a header", () => {
  assert.match(problems(env({ TELEGRAM_API_ROOT: "https://api.telegram.org/bot" }))[0], /origin/);
  assert.equal(loadConfig(env({ TELEGRAM_API_ROOT: "http://127.0.0.1:8081/" })).telegramRoot, "http://127.0.0.1:8081");
  const c = loadConfig(env({ STARKNET_RPC_URL: "https://user:pa%20ss@rpc.example/v0_10" }));
  assert.equal(c.rpc.url, "https://rpc.example/v0_10");
  assert.equal(c.rpc.headers.authorization, `Basic ${Buffer.from("user:pa ss").toString("base64")}`);
});

test("network file problems name the file and the JSON path", () => {
  const dir = mkdtempSync(join(tmpdir(), "cairn-config-"));
  const file = join(dir, "net.json");
  const strk = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
  writeFileSync(file, JSON.stringify({ chain: "SN_MAIN", tokens: [{ symbol: "STRK", address: strk, decimals: 18 }, { symbol: "strk", address: strk.toUpperCase().replace("0X", "0x"), decimals: 6.5 }] }));
  const p = problems(env({ CAIRN_NETWORK_FILE: file }));
  assert.deepEqual(p.map((s) => s.split(": ").slice(0, 2).join(": ")), [`${file}: tokens[1].symbol`, `${file}: tokens[1].address`, `${file}: tokens[1].decimals`]);
  assert.match(problems(env({ CAIRN_NETWORK_FILE: join(dir, "none.json") }))[0], /none\.json: no such file/);
});

test("the secrets to scrub: the token, its secret half, the RPC URL and its key-like parts", () => {
  const s = secretsOf(env());
  for (const want of [TOKEN, "x".repeat(35), RPC, "key-0123456789abcdef", "QUERY-SECRET-42"]) assert.ok(s.includes(want), want);
  assert.ok(!s.includes("v0_10"));
});
