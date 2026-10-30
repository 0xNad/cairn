import { Account, RpcProvider, ec, hash } from "starknet";
import { Vault } from "./vault.mjs";
import {
  CHAIN,
  TOKENS,
  token,
  address,
  felt,
  input,
  units,
  format,
  validateBundle,
} from "../trading/lib/core.mjs";
import { createService } from "../trading/lib/service.mjs";
export const ACCOUNT_CLASS =
  "0x540d7f5ec7ecf317e68d48564934cb99259781b1ee3cedbbc37ec5337f8e688";
const asHex = (n) => "0x" + BigInt(n).toString(16);
const TRANSFER = "transfer";
const boundsBN = (b) =>
  Object.fromEntries(
    Object.entries(b).map(([k, v]) => [
      k,
      {
        max_amount: BigInt(v.max_amount),
        max_price_per_unit: BigInt(v.max_price_per_unit),
      },
    ]),
  );
export function feeLimit(bounds) {
  return Object.values(bounds).reduce(
    (sum, r) => sum + BigInt(r.max_amount) * BigInt(r.max_price_per_unit),
    0n,
  );
}
export function invokeHash(tx) {
  return hash.calculateInvokeTransactionHash({
    senderAddress: tx.sender_address,
    version: tx.version,
    compiledCalldata: tx.calldata,
    chainId: CHAIN,
    nonce: tx.nonce,
    accountDeploymentData: tx.account_deployment_data ?? [],
    nonceDataAvailabilityMode: tx.nonce_data_availability_mode === "L2" ? 1 : 0,
    feeDataAvailabilityMode: tx.fee_data_availability_mode === "L2" ? 1 : 0,
    resourceBounds: Object.fromEntries(
      Object.entries(tx.resource_bounds).map(([k, v]) => [
        k,
        {
          max_amount: BigInt(v.max_amount),
          max_price_per_unit: BigInt(v.max_price_per_unit),
        },
      ]),
    ),
    tip: tx.tip ?? 0,
    paymasterData: tx.paymaster_data ?? [],
    proofFacts: tx.proof_facts,
  });
}
export class Custody {
  constructor({
    directory,
    rpcUrls,
    maxFeeStrk = "5",
    vault,
    provider,
    service,
    accountFactory,
  } = {}) {
    this.accountFactory =
      accountFactory ??
      ((w, key) =>
        new Account({
          provider: this.provider,
          address: w.address,
          signer: key,
          cairoVersion: "1",
        }));
    this.vault = vault ?? new Vault(directory);
    this.provider =
      provider ?? new RpcProvider({ nodeUrl: rpcUrls[0], retries: 0 });
    this.service = service ?? createService({ rpcUrls });
    this.maxFee = units(maxFeeStrk, 18);
  }
  async identity() {
    if (felt(await this.provider.getChainId()) !== CHAIN)
      throw Error("Custody is paused: wrong chain.");
    await this.provider.getClassByHash(ACCOUNT_CLASS);
  }
  async updates() {
    for (const i of this.vault.active()) await this.check(i.user, i.id);
    return this.vault.notifications();
  }
  acknowledge(id, state) {
    this.vault.acknowledge(id, state);
  }
  cancelReviews(user) {
    this.vault.cancelReviews(user);
  }
  history(user) {
    return this.vault.history(user);
  }
  exportKey(user) {
    return this.vault.key(user);
  }
  wallet(user) {
    return this.vault.wallet(user);
  }
  async create(user) {
    await this.identity();
    if (this.wallet(user)) return this.wallet(user);
    const bytes = ec.starkCurve.utils.randomPrivateKey();
    try {
      const key = "0x" + Buffer.from(bytes).toString("hex"),
        publicKey = ec.starkCurve.getStarkKey(key),
        addr = hash.calculateContractAddressFromHash(
          publicKey,
          ACCOUNT_CLASS,
          [publicKey],
          0,
        );
      return this.vault.create(
        user,
        { address: address(addr), publicKey, classHash: ACCOUNT_CLASS },
        key,
      );
    } finally {
      bytes.fill(0);
    }
  }
  account(user) {
    const w = this.wallet(user);
    if (!w) throw Error("Create a wallet first.");
    return this.accountFactory(w, this.vault.key(user));
  }
  async status(user) {
    const w = this.wallet(user);
    if (!w) return null;
    const a = await this.service.account({ owner: w.address });
    return { ...w, ...a, inflight: this.vault.inflight(user) };
  }
  async deployReview(user) {
    await this.identity();
    const w = this.wallet(user);
    if (!w) throw Error("Create a wallet first.");
    const status = await this.status(user);
    if (status.deployed) throw Error("Wallet is already activated.");
    const payload = {
      classHash: w.class_hash,
      constructorCalldata: [w.public_key],
      addressSalt: w.public_key,
      contractAddress: w.address,
    };
    const estimate = await this.account(user).estimateAccountDeployFee(
      payload,
      { tip: 0, skipValidate: false },
    );
    const max = feeLimit(estimate.resourceBounds);
    if (max > this.maxFee)
      throw Error("Activation fee exceeds the configured ceiling. Try later.");
    const gas = BigInt(
      status.balances.find((b) => b.symbol === "STRK")?.amount ?? "0",
    );
    if (gas < max)
      throw Error(
        `Fund this address with STRK first. Activation needs up to ${format(max, 18)} STRK.`,
      );
    return this.vault.review(
      user,
      "deploy",
      {
        payload,
        resourceBounds: estimate.resourceBounds,
        maxFee: max.toString(),
      },
      Date.now() + 30000,
    );
  }
  async swapReview(user, raw) {
    await this.identity();
    const w = this.wallet(user);
    if (!w) throw Error("Create a wallet first.");
    const status = await this.status(user);
    if (!status.deployed) throw Error("Fund and activate your wallet first.");
    const request = { ...raw, owner: w.address };
    const bundle = await this.service.quote(request);
    const calls = validateBundle(bundle, request);
    const estimate = await this.account(user).estimateInvokeFee(calls, {
      tip: 0,
    });
    const max = feeLimit(estimate.resourceBounds);
    if (max > this.maxFee)
      throw Error("Network fee exceeds the configured ceiling. Try later.");
    const gas = BigInt(
      status.balances.find((b) => b.symbol === "STRK")?.amount ?? "0",
    );
    const strk = token("STRK");
    const spend =
      bundle.sell.address === strk.address ? BigInt(bundle.amount) : 0n;
    if (gas < max + spend)
      throw Error("Keep enough STRK for the trade and network fee.");
    const bal = BigInt(
      status.balances.find((b) => b.symbol === bundle.sell.symbol)?.amount ??
        "0",
    );
    if (bal < BigInt(bundle.amount))
      throw Error("Not enough " + bundle.sell.symbol + ".");
    return this.vault.review(
      user,
      "swap",
      {
        request,
        bundle,
        resourceBounds: estimate.resourceBounds,
        maxFee: max.toString(),
      },
      bundle.expiresAt,
    );
  }
  async withdrawReview(user, { symbol, amount, to }) {
    await this.identity();
    const w = this.wallet(user);
    if (!w) throw Error("Create a wallet first.");
    const t = token(symbol),
      recipient = address(to),
      value = units(amount, t.decimals);
    if (recipient === w.address)
      throw Error("Choose another destination address.");
    const status = await this.status(user);
    if (!status.deployed) throw Error("Activate the wallet first.");
    const calls = [
      {
        contractAddress: t.address,
        entrypoint: TRANSFER,
        calldata: [
          recipient,
          asHex(value & ((1n << 128n) - 1n)),
          asHex(value >> 128n),
        ],
      },
    ];
    const estimate = await this.account(user).estimateInvokeFee(calls, {
      tip: 0,
    });
    const max = feeLimit(estimate.resourceBounds);
    if (max > this.maxFee)
      throw Error("Network fee exceeds the configured ceiling.");
    const balance = BigInt(
      status.balances.find((b) => b.symbol === t.symbol)?.amount ?? "0",
    );
    const gas = BigInt(
      status.balances.find((b) => b.symbol === "STRK")?.amount ?? "0",
    );
    if (balance < value || gas < max + (t.symbol === "STRK" ? value : 0n))
      throw Error("Insufficient balance after reserving the network fee.");
    return this.vault.review(
      user,
      "withdraw",
      {
        symbol: t.symbol,
        amount,
        to: recipient,
        calls,
        resourceBounds: estimate.resourceBounds,
        maxFee: max.toString(),
      },
      Date.now() + 30000,
    );
  }
  async confirm(user, id) {
    await this.identity();
    const pending = this.vault.intent(user, id);
    if (pending?.kind === "swap") await this.service.config();
    const i = this.vault.claim(user, id);
    let tx, txHash;
    try {
      const account = this.account(user),
        p = i.payload;
      if (i.kind === "deploy") {
        // Claim before the only network write. A lost response blocks replay until deployment is reconciled.
        this.vault.state(user, id, "unknown");
        const r = await account.deployAccount(p.payload, {
          resourceBounds: boundsBN(p.resourceBounds),
          tip: 0,
        });
        this.vault.sent(user, id, address(r.transaction_hash));
        return this.vault.intent(user, id);
      }
      const calls =
        i.kind === "swap" ? validateBundle(p.bundle, p.request) : p.calls;
      if (i.kind === "swap" && Date.now() >= p.bundle.expiresAt)
        throw Error("Quote expired.");
      const nonce = await this.provider.getNonceForAddress(
        this.wallet(user).address,
        "pre_confirmed",
      );
      tx = await account.getSignedTransaction(calls, {
        nonce,
        resourceBounds: boundsBN(p.resourceBounds),
        tip: 0,
      });
      if (
        feeLimit(tx.resource_bounds) > BigInt(p.maxFee) ||
        feeLimit(tx.resource_bounds) > this.maxFee
      )
        throw Error("Fee changed after review.");
      if (i.kind === "swap") validateBundle(p.bundle, p.request);
      txHash = address(invokeHash(tx));
      this.vault.signed(user, id, txHash, tx);
    } catch (e) {
      if (i.kind !== "deploy") this.vault.state(user, id, "failed");
      throw Error(
        i.kind === "deploy"
          ? "Activation response unknown. Check wallet status before retrying."
          : "Could not prepare this transaction. Nothing was submitted. Refresh your quote.",
        { cause: e },
      );
    }
    try {
      const r = await this.provider.invokeSignedTx(tx);
      if (address(r.transaction_hash) !== txHash) throw Error("hash");
      this.vault.sent(user, id, txHash);
    } catch {
      this.vault.state(user, id, "unknown");
    }
    return this.vault.intent(user, id);
  }
  async check(user, id) {
    const i = this.vault.intent(user, id);
    if (!i) throw Error("Transaction not found for this wallet.");
    if (
      i.kind === "deploy" &&
      !i.hash &&
      ["unknown", "signing"].includes(i.state)
    ) {
      const s = await this.status(user);
      if (s.deployed) this.vault.state(user, id, "confirmed");
      return this.vault.intent(user, id);
    }
    if (!i.hash) return i;
    try {
      if (i.kind === "swap") {
        const p = i.payload,
          r = await this.service.receipt({
            hash: i.hash,
            ...p.request,
            minimumReceived: p.bundle.minimumReceived,
          });
        if (["confirmed", "settled", "reverted", "mismatch"].includes(r.state))
          this.vault.state(
            user,
            id,
            r.state === "settled" ? "confirmed" : r.state,
          );
      } else {
        const r = await this.provider.getTransactionReceipt(i.hash);
        if (address(r.transaction_hash) !== i.hash) throw Error("Receipt hash mismatch.");
        if (r.execution_status === "REVERTED")
          this.vault.state(user, id, "reverted");
        else if (
          ["ACCEPTED_ON_L2", "ACCEPTED_ON_L1"].includes(r.finality_status)
        )
          this.vault.state(user, id, "confirmed");
      }
    } catch {
      /* Unavailable is not proof of failure. Never retry with a new nonce. */
    }
    return this.vault.intent(user, id);
  }
  close() {
    this.vault.close();
  }
}
