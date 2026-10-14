import assert from "node:assert/strict";
import { test } from "node:test";
import { ADDRESS_BOUND, P, hex64, parseAddress, parseTxHash, shortHex, shortString, toBig, u256 } from "../src/felt.mjs";

test("addresses are accepted in any case, with or without leading zeros, and normalised", () => {
  const want = 0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938dn;
  for (const s of ["0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d", "0x4718F5A0FC34CC1AF16A1CDEE98FFB20C31F5CD61D6AB07201858F4287C938D", " 0X4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d "]) {
    assert.equal(parseAddress(s).value, want, s);
  }
  assert.equal(hex64(want), "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d");
  assert.equal(shortHex(want), "0x0471…938d");
});

test("invalid addresses are refused with a reason, before anything is looked up", () => {
  for (const [input, reason] of [["", /no address/], ["hello", /starts with 0x/], ["0x", /hex digits/], ["0xZZZ", /hex digits/], [`0x1${"0".repeat(64)}`, /at most 64/], ["0x0", /not an address/], [hex64(ADDRESS_BOUND), /too large/], ["ben.stark", /not supported yet/]]) {
    assert.match(parseAddress(input).error ?? "", reason, JSON.stringify(input));
  }
  assert.equal(parseAddress(hex64(ADDRESS_BOUND - 1n)).value, ADDRESS_BOUND - 1n);
});

test("transaction hashes are felts below P", () => {
  assert.equal(parseTxHash(hex64(P - 1n)).value, P - 1n);
  assert.match(parseTxHash(hex64(P)).error, /too large/);
  assert.match(parseTxHash("0x0").error, /not a transaction hash/);
});

test("u256, felts from the node and short strings", () => {
  assert.equal(u256(5n, 1n), 2n ** 128n + 5n);
  assert.equal(toBig("0x10"), 16n);
  assert.equal(toBig("nope"), null);
  assert.equal(shortString("0x534e5f4d41494e"), "SN_MAIN");
  assert.equal(shortString("0x4b4154414e41"), "KATANA");
  assert.equal(shortString("0x01"), null);
});
