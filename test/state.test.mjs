import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { rateLimiter } from "../src/rpc.mjs";
import { openStore } from "../src/store.mjs";

const log = { debug() {}, info() {}, warn() {}, error() {} };

test("the offset survives a reopen and only moves forward; the directory is 700 and its files 600", () => {
  process.umask(0o077); // as cairn.mjs sets it
  const dir = join(mkdtempSync(join(tmpdir(), "cairn-store-")), "data");
  let s = openStore(dir, log);
  assert.equal(s.offset(), 0);
  s.handled(41);
  s.handled(7);
  s.close();
  s = openStore(dir, log);
  assert.equal(s.offset(), 42);
  s.close();
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const f of readdirSync(dir)) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
});

test("a change and its update are saved together, or not at all", () => {
  const s = openStore(join(mkdtempSync(join(tmpdir(), "cairn-store-")), "data"), log);
  assert.throws(() => s.handled(5, () => {
    s.set("x", "1");
    throw new Error("crash in the middle");
  }));
  assert.equal(s.get("x"), undefined);
  assert.equal(s.offset(), 0);
  s.close();
});

test("the rate limiter allows N calls in any 1 s window, in order", async () => {
  let now = 0;
  const waits = [];
  const acquire = rateLimiter(2, { now: () => now, wait: async (ms) => (waits.push(ms), (now += ms)) });
  const starts = [];
  for (let i = 0; i < 5; i++) {
    await acquire();
    starts.push(now);
  }
  for (let i = 2; i < starts.length; i++) assert.ok(starts[i] - starts[i - 2] >= 1000, `calls ${i - 2} and ${i}: ${starts}`);
  assert.equal(starts[1], 0);
});
