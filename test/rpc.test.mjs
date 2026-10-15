import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeTransfer, transfersOf } from "../src/events.mjs";
import { RateLimiter } from "../src/rpc.mjs";
import { SELECTOR, specSupported } from "../src/starknet.mjs";
import { retryAfterMs } from "../src/wait.mjs";

test("the rate limiter never lets more than `limit` calls into one window", async () => {
  const limiter = new RateLimiter(3, 200);
  const at = [];
  await Promise.all(Array.from({ length: 9 }, () => limiter.take().then(() => at.push(Date.now()))));
  for (let i = 3; i < at.length; i++) assert.ok(at[i] - at[i - 3] >= 200, `call ${i} came ${at[i] - at[i - 3]} ms after call ${i - 3}`);
});

test("Retry-After in seconds or as a date", () => {
  assert.equal(retryAfterMs("2"), 2000);
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 4_000), 6000);
  assert.equal(retryAfterMs(null), 0);
});

test("spec versions below 0.10.0 are refused", () => {
  for (const v of ["0.10.0", "0.10.3", "0.11.2", "1.0.0"]) assert.ok(specSupported(v), v);
  for (const v of ["0.9.0", "0.8.1", "v0.10", ""]) assert.ok(!specSupported(v), v);
});

test("Transfer events decode by shape, and the fee payment is left out", () => {
  const sel = `0x${SELECTOR.Transfer.toString(16)}`;
  const modern = { from_address: "0x10", keys: [sel, "0xa", "0xb"], data: ["0x5", "0x1"] };
  const legacy = { from_address: "0x20", keys: [sel], data: ["0xb", "0xa", "0x7", "0x0"] };
  assert.deepEqual(decodeTransfer(modern), { token: 0x10n, from: 0xan, to: 0xbn, amount: 2n ** 128n + 5n });
  assert.deepEqual(decodeTransfer(legacy), { token: 0x20n, from: 0xbn, to: 0xan, amount: 7n });
  assert.equal(decodeTransfer({ from_address: "0x30", keys: [sel, "0x1", "0x2", "0x3", "0x4"], data: [] }), null, "an NFT");
  const fee = { from_address: "0x30", keys: [sel, "0xa", "0xc"], data: ["0x64", "0x0"] };
  const receipt = { actual_fee: { amount: "0x64", unit: "FRI" }, events: [modern, legacy, fee] };
  assert.equal(transfersOf(receipt, { address: 0x30n }).length, 2);
});
