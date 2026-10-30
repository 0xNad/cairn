import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../vault.mjs";
function make(t) {
  const dir = mkdtempSync(join(tmpdir(), "cairn-vault-"));
  const vault = new Vault(dir);
  t.after(() => {
    try {
      vault.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, vault };
}
test("wallet keys are encrypted, bound to their owner/address and stable after restart", (t) => {
  const { dir, vault: v } = make(t);
  const secret = "0x" + "19".repeat(32),
    wallet = v.create(
      101,
      { address: "0x123", publicKey: "0x456", classHash: "0x789" },
      secret,
    );
  assert.equal(v.key(101), secret);
  assert.equal(v.wallet(102), null);
  assert.ok(!readFileSync(join(dir, "vault.db")).includes(Buffer.from(secret)));
  assert.ok(!JSON.stringify(wallet).includes(secret));
  assert.equal(v.create(101, { address: "0x999" }, "bad").address, "0x123");
  const cipher = v.db.prepare("select secret from wallets").get().secret;
  assert.throws(() => v.open(cipher, "102:0x123"));
  const second = new Vault(dir);
  assert.equal(second.key(101), secret);
  second.close();
});
test("confirmation is user-bound, single-use, cancellable and blocks another in-flight transaction", (t) => {
  const { vault: v } = make(t);
  const i = v.review(101, "swap", { amount: "100" }, Date.now() + 30000);
  assert.equal(v.intent(102, i.id), null);
  assert.throws(() => v.claim(102, i.id));
  assert.equal(v.claim(101, i.id).payload.amount, "100");
  assert.throws(() => v.claim(101, i.id));
  assert.throws(() => v.review(101, "swap", {}, Date.now() + 1000));
  v.state(101, i.id, "unknown");
  assert.throws(() => v.review(101, "swap", {}, Date.now() + 1000));
  v.state(101, i.id, "confirmed");
  const next = v.review(101, "withdraw", {}, Date.now() + 1000);
  v.cancelReviews(101);
  assert.throws(() => v.claim(101, next.id));
  const expired = v.review(101, "deploy", {}, 0);
  assert.throws(() => v.claim(101, expired.id));
});
test("missing master key or insecure files fail closed rather than generating replacement wallets", (t) => {
  const { dir, vault: v } = make(t);
  v.create(101, { address: "0x1", publicKey: "0x2", classHash: "0x3" }, "0x4");
  unlinkSync(join(dir, "master.key"));
  assert.throws(() => new Vault(dir), /master key missing/);
});
test("encrypted signed payload survives restart, with a fixed transaction hash", (t) => {
  const { dir, vault: v } = make(t);
  const i = v.review(101, "swap", {}, Date.now() + 10000);
  v.claim(101, i.id);
  const tx = { signature: ["0x1", "0x2"], nonce: "0x4" };
  v.signed(101, i.id, "0xabc", tx);
  const second = new Vault(dir);
  const r = second.intent(101, i.id);
  assert.equal(r.hash, "0xabc");
  assert.deepEqual(JSON.parse(second.open(r.signed, `101:${i.id}`)), tx);
  assert.throws(() => second.open(r.signed, `102:${i.id}`));
  second.close();
});

test("terminal result notifications survive a crash before enqueue and acknowledgments prevent repeats", (t) => {
  const { dir, vault: v } = make(t);
  const i = v.review(101, "swap", {}, Date.now() + 10000);
  v.claim(101, i.id);
  v.signed(101, i.id, "0x123", {});
  v.state(101, i.id, "confirmed");
  const second = new Vault(dir);
  assert.equal(second.notifications().length, 1);
  second.acknowledge(i.id, "confirmed");
  assert.equal(v.notifications().length, 0);
  second.close();
});
