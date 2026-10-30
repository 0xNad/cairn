// Local fork only. Never send a write to an upstream or public RPC.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Custody } from "./engine.mjs";
const url = process.env.CAIRN_DEVNET_URL ?? "http://127.0.0.1:8501";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url))
  throw Error("Local devnet required.");
const dir = mkdtempSync(join(tmpdir(), "cairn-devnet-")),
  c = new Custody({ directory: dir, rpcUrls: [url] });
const proof = {
  environment: "local Starknet devnet fork; dummy funds only",
  publicChainWrites: 0,
  startedAt: new Date().toISOString(),
};
try {
  const w = await c.create(909);
  proof.walletCreated = true;
  proof.sameWallet = (await c.create(909)).address === w.address;
  for (const unit of ["FRI", "WEI"]) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "devnet_mint",
        params: {
          address: w.address,
          amount: JSON.rawJSON(
            unit === "FRI" ? "1000000000000000000000" : "10000000000000000000",
          ),
          unit,
        },
      }),
    });
    const result = await r.json();
    if (!r.ok || result.error)
      throw Error("Local mint failed: " + JSON.stringify(result.error));
  }
  console.log("Local wallet funded with dummy STRK and ETH");
  const deployment = await c.deployReview(909);
  proof.deploymentFeeCap = deployment.payload.maxFee;
  console.log("Activation reviewed");
  const deployed = await c.confirm(909, deployment.id);
  proof.deploymentHash = deployed.hash;
  console.log("Activation submitted locally");
  for (let j = 0; j < 20; j++) {
    const r = await c.check(909, deployment.id);
    if (r.state === "confirmed") break;
    await new Promise((r) => setTimeout(r, 300));
  }
  proof.activated = (await c.status(909)).deployed;
  if (!proof.activated) throw Error("Activation not confirmed");
  const transfer = await c.withdrawReview(909, {
    symbol: "STRK",
    amount: "1",
    to: "0x12345",
  });
  await c.confirm(909, transfer.id);
  proof.withdrawal = (await c.check(909, transfer.id)).state;
  if (proof.withdrawal !== "confirmed") throw Error("Withdrawal not confirmed");
  console.log("Local withdrawal confirmed");
  const swap = await c.swapReview(909, {
    sell: "ETH",
    buy: "STRK",
    amount: "0.001",
    slippageBps: 50,
  });
  console.log("Live AVNU quote validated against fork");
  await c.confirm(909, swap.id);
  proof.swap = (await c.check(909, swap.id)).state;
  if (proof.swap !== "confirmed") throw Error("Swap result: " + proof.swap);
  proof.finishedAt = new Date().toISOString();
} catch (e) {
  proof.error = String(e.message).slice(-2200);
  if (e.cause) proof.cause = String(e.cause.message).slice(0, 2200);
  process.exitCode = 1;
} finally {
  c.close();
  rmSync(dir, { recursive: true, force: true });
  const output = process.env.CAIRN_SMOKE_PROOF;
  if (output) writeFileSync(output, JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof));
}
