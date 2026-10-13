import assert from "node:assert/strict";
import { test } from "node:test";
import { answer, parseCommand } from "../src/commands/index.mjs";
import { decodeTokenEvent, isFeePayment } from "../src/events.mjs";
import { felt } from "../src/felt.mjs";
import { RpcError } from "../src/rpc.mjs";
import { SEL } from "../src/selectors.mjs";

test("commands: /cmd and /cmd@cairn are Cairn's, /cmd@other and plain text are not", () => {
  assert.deepEqual(parseCommand("/status", "cairn_bot"), { name: "status", args: [] });
  assert.deepEqual(parseCommand("/Balance@Cairn_Bot  0xabc  STRK", "cairn_bot"), { name: "balance", args: ["0xabc", "STRK"] });
  assert.equal(parseCommand("/status@other_bot", "cairn_bot"), null);
  assert.equal(parseCommand("/status@cairn_botx", "cairn_bot"), null);
  assert.equal(parseCommand("status please", "cairn_bot"), null);
});

const log = { debug() {}, info() {}, warn() {}, error() {} };
const TOKENS = [
  { symbol: "STRK", address: 0x10n, hex: `0x${"0".repeat(62)}10`, decimals: 18 },
  { symbol: "USDC", address: 0x20n, hex: `0x${"0".repeat(62)}20`, decimals: 6 },
];
const config = { chain: "SN_MAIN", explorer: "https://explorer.example", tokens: TOKENS };
const head = { number: 100, timestamp: 1792454400, txCount: 1, gas: { l1: 1n, l1Data: 2n, l2: 3n }, version: "0.14.4" };
const me = { username: "cairn_bot" };
const msg = (text, type = "private") => ({ message_id: 1, chat: { id: 7, type }, text });
const plain = (blocks) => blocks.map((b) => (typeof b === "string" ? b : b.quote)).join("\n").replace(/<[^>]*>/g, "");

/** A chain whose calls are answered by `on(method, params)`, recording what was asked. */
function chainOf(on) {
  const asked = [];
  const rec = (method) => (...a) => (asked.push([method, ...a]), on(method, ...a));
  return { asked, call: rec("call"), classHashAt: rec("classHashAt"), txStatus: rec("txStatus"), receipt: rec("receipt"), header: rec("header") };
}

test("an invalid address or hash is refused before any call about it", async () => {
  const chain = chainOf(() => assert.fail("no call"));
  for (const text of ["/balance", "/balance 0xZZ", "/balance 0x0", "/tx 0x", "/tx nope"]) {
    const out = plain(await answer(msg(text), { config, chain, head, me, log }));
    assert.match(out, /address|hash/, text);
  }
  assert.equal(chain.asked.length, 0);
});

test("/balance: registry order, balanceOf after error 21, one failing token, not deployed", async () => {
  const chain = chainOf(async (m, contract, selector) => {
    if (m === "classHashAt") throw new RpcError(20, "Contract not found");
    if (contract === 0x10n && selector === SEL.balance_of) throw new RpcError(21, "no entry point");
    if (contract === 0x10n) return ["0x1", "0x0"];
    throw new RpcError(40, "Contract error");
  });
  const out = plain(await answer(msg("/balance 0x123"), { config, chain, head, me, log }));
  assert.match(out, /Not deployed/);
  assert.match(out, /0\.000000000000000001 STRK/);
  assert.match(out, /USDC: the token contract answered with an error/);
});

test("/tx lists registry token moves, leaves the fee payment out, and quotes the revert reason", async () => {
  const transfer = (token, from, to, amount) => ({ from_address: felt(token), keys: [felt(SEL.Transfer), felt(from), felt(to)], data: [felt(amount), "0x0"] });
  const sequencer = 0x5e9n;
  const STRK = 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938dn;
  const events = [transfer(0x20n, 0xan, 0xbn, 2_500_000n), transfer(0x99n, 0xan, 0xbn, 1n), transfer(STRK, 0xan, sequencer, 7n)];
  assert.ok(isFeePayment(events, 2, { strk: STRK, sequencer, fee: 7n }));
  assert.equal(decodeTokenEvent(events[0]).amount, 2_500_000n);
  const chain = chainOf(async (m) => {
    if (m === "txStatus") return { finality_status: "ACCEPTED_ON_L2", execution_status: "REVERTED", failure_reason: "x" };
    if (m === "receipt") return { type: "INVOKE", block_number: 99, actual_fee: { amount: "0x7", unit: "FRI" }, events, revert_reason: "boom <b> ('u256_sub Overflow')" };
    return { ...head, number: 99, sequencer };
  });
  const blocks = await answer(msg("/tx 0xabc"), { config, chain, head, me, log });
  const out = plain(blocks);
  assert.match(out, /Reverted · Accepted on L2/);
  assert.match(out, /Fee: 0\.000000000000000007 STRK/);
  assert.match(out, /2\.5 USDC/);
  assert.match(out, /1 transfer or approval event of tokens outside/);
  assert.doesNotMatch(out, /0\.000000000000000007 STRK:/);
  assert.match(out, /Cause: u256_sub Overflow/);
  assert.deepEqual(blocks.at(-1), { quote: "boom <b> ('u256_sub Overflow')" });
});

test("/tx of an unknown hash says not found; a busy node says busy", async () => {
  const missing = chainOf(async () => {
    throw new RpcError(29, "Transaction hash not found");
  });
  assert.match(plain(await answer(msg("/tx 0xabc"), { config, chain: missing, head, me, log })), /not found/);
  assert.match(plain(await answer(msg("/status"), { config, chain: missing, head: null, me, log })), /busy/);
});

test("groups: silence for plain text; an unknown command points to /help", async () => {
  assert.equal(await answer(msg("gm", "supergroup"), { config, head, me, log }), null);
  assert.match(plain(await answer(msg("/zz_unknown@cairn_bot", "group"), { config, head, me, log })), /\/help/);
});
