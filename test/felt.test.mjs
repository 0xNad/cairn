import assert from "node:assert/strict";
import { test } from "node:test";
import { P, hex64, parseAddress, parseHash, shortHex, shortString, u256Of } from "../src/felt.mjs";

test("addresses are normalised to 0x and 64 lowercase digits", () => {
  const a = parseAddress("0xABC");
  assert.equal(a.ok, true);
  assert.equal(a.value, `0x${"0".repeat(61)}abc`);
  assert.equal(shortHex(a.value), "0x0000…0abc");
});

test("bad addresses are refused with a reason", () => {
  for (const text of [undefined, "", "abc", "0x", "0xZZ", "0x0", `0x1${"0".repeat(64)}`, hex64(2n ** 251n - 256n)]) {
    const r = parseAddress(text);
    assert.equal(r.ok, false, String(text));
    assert.match(r.reason, /address/);
  }
  assert.equal(parseAddress(hex64(2n ** 251n - 257n)).ok, true);
});

test("hashes are felts below P", () => {
  assert.equal(parseHash(hex64(P - 1n)).ok, true);
  assert.equal(parseHash(hex64(P)).ok, false);
  assert.match(parseHash("0x0").reason, /transaction hash/);
});

test("u256 is low + high * 2^128, and rejects limbs that are too big", () => {
  assert.equal(u256Of(["0x5", "0x1"]), 2n ** 128n + 5n);
  assert.throws(() => u256Of(["0x1"]), TypeError);
  assert.throws(() => u256Of([`0x1${"0".repeat(32)}`, "0x0"]), TypeError);
});

test("short strings decode, and non-text felts do not", () => {
  assert.equal(shortString("0x534e5f4d41494e"), "SN_MAIN");
  assert.equal(shortString("0x01"), null);
});
