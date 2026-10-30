import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Custody, invokeHash } from "../engine.mjs";
import { CHAIN, TOKENS } from "../../trading/lib/core.mjs";
const bounds = {
  l1_gas: { max_amount: "0x1", max_price_per_unit: "0x2" },
  l2_gas: { max_amount: "0x3", max_price_per_unit: "0x4" },
  l1_data_gas: { max_amount: "0x5", max_price_per_unit: "0x6" },
};
function env(t, { lost = false, changedFee = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cairn-engine-"));
  let broadcasts = 0;
  const signed = {
    type: "INVOKE",
    version: "0x3",
    sender_address: "0x1",
    calldata: ["0x1", "0x2"],
    signature: ["0x1", "0x2"],
    nonce: "0x0",
    resource_bounds: bounds,
    tip: "0x0",
    paymaster_data: [],
    account_deployment_data: [],
    nonce_data_availability_mode: "L1",
    fee_data_availability_mode: "L1",
  };
  const provider = {
    getChainId: async () => CHAIN,
    getClassByHash: async () => ({}),
    getNonceForAddress: async () => 0n,
    invokeSignedTx: async (tx) => {
      broadcasts++;
      if (lost) throw Error("timeout");
      return { transaction_hash: invokeHash(tx) };
    },
    getTransactionReceipt: async () => ({
      transaction_hash: invokeHash(signed),
      execution_status: "SUCCEEDED",
      finality_status: "ACCEPTED_ON_L2",
    }),
  };
  const service = {
    account: async () => ({
      deployed: true,
      balances: TOKENS.map((t) => ({
        symbol: t.symbol,
        amount: "100000000000000000000",
      })),
    }),
  };
  const accountFactory = () => ({
    estimateInvokeFee: async () => ({ resourceBounds: bounds }),
    getSignedTransaction: async () =>
      structuredClone(
        changedFee
          ? {
              ...signed,
              resource_bounds: {
                ...bounds,
                l2_gas: { max_amount: "0xffff", max_price_per_unit: "0xffff" },
              },
            }
          : signed,
      ),
  });
  const c = new Custody({
    directory: dir,
    rpcUrls: [],
    provider,
    service,
    accountFactory,
  });
  c.vault.create(
    101,
    { address: "0x1", publicKey: "0x2", classHash: "0x3" },
    "0x4",
  );
  t.after(() => {
    c.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { c, provider, broadcasts: () => broadcasts };
}
test("created wallet is counterfactual and creation never broadcasts a chain transaction", async (t) => {
  const e = env(t);
  const a = await e.c.create(102),
    b = await e.c.create(102);
  assert.equal(a.address, b.address);
  assert.ok(/^0x[0-9a-f]+$/.test(a.address));
  assert.ok(!("secret" in a));
  assert.equal(e.broadcasts(), 0);
});
test("withdrawal confirmation signs one reviewed transaction and refuses another user or repeat tap", async (t) => {
  const e = env(t);
  const i = await e.c.withdrawReview(101, {
    symbol: "USDC",
    amount: "1",
    to: "0x123",
  });
  assert.equal(e.broadcasts(), 0);
  await assert.rejects(e.c.confirm(102, i.id));
  const r = await e.c.confirm(101, i.id);
  assert.equal(r.state, "pending");
  assert.equal(e.broadcasts(), 1);
  await assert.rejects(e.c.confirm(101, i.id));
  assert.equal(e.broadcasts(), 1);
  await e.c.check(101, i.id);
  assert.equal(e.c.vault.intent(101, i.id).state, "confirmed");
});
test("lost broadcast response retains its exact hash, blocks new trades and never blindly resubmits", async (t) => {
  const e = env(t, { lost: true });
  const i = await e.c.withdrawReview(101, {
    symbol: "USDC",
    amount: "1",
    to: "0x123",
  });
  const r = await e.c.confirm(101, i.id);
  assert.equal(r.state, "unknown");
  assert.ok(r.hash);
  await assert.rejects(e.c.confirm(101, i.id));
  await assert.rejects(
    e.c.withdrawReview(101, { symbol: "USDC", amount: "1", to: "0x123" }),
  );
  assert.equal(e.broadcasts(), 1);
  await e.c.check(101, i.id);
  assert.equal(e.c.vault.intent(101, i.id).state, "confirmed");
});
test("fee changes after confirmation and wrong-chain responses never reach the broadcast method", async (t) => {
  const e = env(t, { changedFee: true });
  const i = await e.c.withdrawReview(101, {
    symbol: "USDC",
    amount: "1",
    to: "0x123",
  });
  await assert.rejects(e.c.confirm(101, i.id));
  assert.equal(e.broadcasts(), 0);
  e.provider.getChainId = async () => "0x123";
  await assert.rejects(e.c.create(102));
  assert.equal(e.broadcasts(), 0);
});
