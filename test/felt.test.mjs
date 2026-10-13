import assert from "node:assert/strict";
import { test } from "node:test";
import { ADDRESS_BOUND, P, hex64, parseAddress, parseHash, shortString, toBig, u256 } from "../src/felt.mjs";

const STRK = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

test("addresses: any case, with or without leading zeros, normalised to 0x and 64 digits", () => {
  for (const s of [STRK, STRK.toUpperCase().replace("0X", "0x"), "0x4718F5A0FC34CC1AF16A1CDEE98FFB20C31F5CD61D6AB07201858F4287C938D"]) {
    assert.equal(parseAddress(s).hex, STRK);
  }
  assert.equal(parseAddress("0x1").hex, `0x${"0".repeat(63)}1`);
});

test("addresses: refused with a reason (missing, not hex, 65 digits, zero, 2^251 - 256)", () => {
  const cases = [[undefined, /missing/], ["hello", /not an address/], ["0x", /not an address/], ["0xZZ", /not an address/],
    [`0x1${"0".repeat(64)}`, /65 hex digits/], ["0x0", /zero/], [hex64(ADDRESS_BOUND), /out of range/]];
  for (const [input, why] of cases) assert.match(parseAddress(input).error, why, String(input));
  assert.equal(parseAddress(hex64(ADDRESS_BOUND - 1n)).value, ADDRESS_BOUND - 1n);
});

test("hashes: felts below P, so 2^251 is a hash but not an address", () => {
  assert.equal(parseHash(hex64(2n ** 251n)).value, 2n ** 251n);
  assert.ok(parseAddress(hex64(2n ** 251n)).error);
  assert.match(parseHash(hex64(P)).error, /out of range/);
  assert.match(parseHash("0x0").error, /zero/);
});

test("u256 is low + high * 2^128, and node felts are read strictly", () => {
  assert.equal(u256("0x5", "0x1"), 2n ** 128n + 5n);
  assert.equal(toBig("0x0"), 0n);
  assert.equal(toBig("42"), 42n);
  assert.throws(() => toBig("0x"), TypeError);
  assert.throws(() => toBig(-1), TypeError);
  assert.throws(() => toBig({}), TypeError);
});

test("short strings decode to ASCII, and the chain ids to their names", () => {
  assert.equal(shortString(0x534e5f4d41494en), "SN_MAIN");
  assert.equal(shortString("0x534e5f5345504f4c4941"), "SN_SEPOLIA");
  assert.equal(shortString("0x55534443"), "USDC");
  assert.equal(shortString("0x01"), null);
});
