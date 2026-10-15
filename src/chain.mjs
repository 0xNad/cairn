// What Cairn asks the chain, in its own terms: the node's identity (checked once), the head block, balances,
// deployment and transactions. Everything is read-only, on "latest". Felts go out in their shortest hex form
// and come back as BigInt. The RPC layer decides what "node busy" means; this layer decides what an answer is.
import { EXIT, ExitError } from "./errors.mjs";
import { atLeast, feltOf, parseSpec, shortString, toFelt, u256Of } from "./felt.mjs";
import { NodeUnavailable, RpcError } from "./rpc.mjs";

/** sn_keccak selectors from ARCHITECTURE.md ("Selectors"). */
const SELECTOR = {
  balance_of: toFelt(0x035a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33n),
  balanceOf: toFelt(0x02e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76en),
};

/** Error codes of the JSON-RPC spec that Cairn tells apart. */
export const RPC = Object.freeze({ CONTRACT_NOT_FOUND: 20, ENTRYPOINT_NOT_FOUND: 21, TX_NOT_FOUND: 29, CONTRACT_ERROR: 40 });

const CHAIN_IDS = new Map([
  ["SN_MAIN", 0x534e5f4d41494en],
  ["SN_SEPOLIA", 0x534e5f5345504f4c4941n],
]);
const MIN_SPEC = [0, 10, 0];

/** A header field that must be a felt: a malformed answer is the node's fault, so "node busy". */
function price(header, key) {
  try {
    return feltOf(header?.[key]?.price_in_fri);
  } catch {
    throw new NodeUnavailable(`the node's block header has no valid ${key}`);
  }
}

export class Chain {
  /** @param {{ rpc: import("./rpc.mjs").Rpc, expected: string, log: object }} options */
  constructor({ rpc, expected, log }) {
    this.rpc = rpc;
    this.expected = expected;
    this.log = log;
    this.spec = null; // the node's own version string, once checked
    this.verified = false;
  }

  /**
   * Checks the node once per process: its chain id must be CAIRN_CHAIN's and its spec 0.10.0 or later.
   * @throws {ExitError} code 2, naming what the node reported
   * @throws {NodeUnavailable} when the node cannot be asked (try again later)
   */
  async verify() {
    if (this.verified) return;
    const id = await this.rpc.chainId();
    const spec = await this.rpc.specVersion();
    if (typeof id !== "string" || typeof spec !== "string") throw new NodeUnavailable("malformed chain id or spec version");

    let value;
    try {
      value = feltOf(id);
    } catch {
      throw new NodeUnavailable("malformed chain id");
    }
    if (value !== CHAIN_IDS.get(this.expected)) {
      const name = shortString(id);
      throw new ExitError(
        EXIT.CONFIG,
        `the node is on chain ${name ?? id} (chain id ${id}), but CAIRN_CHAIN is ${this.expected}: point STARKNET_RPC_URL at a ${this.expected} node`,
      );
    }
    const numbers = parseSpec(spec);
    if (!numbers || !atLeast(numbers, MIN_SPEC)) {
      throw new ExitError(EXIT.CONFIG, `the node's JSON-RPC spec version is ${JSON.stringify(spec.slice(0, 40))}, but Cairn needs 0.10.0 or later`);
    }
    this.spec = spec;
    this.verified = true;
  }

  /**
   * The latest block: number, hash, chain time and the three gas prices in FRI (BigInt).
   * Verifies the node first, once.
   * @throws {NodeUnavailable} @throws {ExitError}
   */
  async head() {
    await this.verify();
    const h = await this.rpc.blockLatest();
    const number = h?.block_number;
    const timestamp = h?.timestamp;
    if (!Number.isSafeInteger(number) || number < 0 || !Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new NodeUnavailable("malformed block header");
    }
    return {
      number,
      hash: typeof h.block_hash === "string" ? h.block_hash : null,
      timestamp,
      gas: { l1: price(h, "l1_gas_price"), l1Data: price(h, "l1_data_gas_price"), l2: price(h, "l2_gas_price") },
      spec: this.spec,
    };
  }

  /**
   * `balance_of(owner)` of a token, falling back to `balanceOf` on error 21.
   * @returns {Promise<bigint>}
   * @throws {RpcError} the node's refusal (for example 40: the contract failed)
   * @throws {NodeUnavailable} @throws {TypeError} an answer that is not a u256
   */
  async balance(token, owner) {
    const contract = toFelt(token.address);
    const calldata = [toFelt(owner)];
    let felts;
    try {
      felts = await this.rpc.callContract(contract, SELECTOR.balance_of, calldata);
    } catch (e) {
      if (!(e instanceof RpcError) || e.code !== RPC.ENTRYPOINT_NOT_FOUND) throw e;
      felts = await this.rpc.callContract(contract, SELECTOR.balanceOf, calldata);
    }
    return u256Of(felts);
  }

  /** Whether a contract is deployed at `address` (error 20 means not). Other errors are the caller's. */
  async isDeployed(address) {
    try {
      await this.rpc.classHashAt(toFelt(address));
      return true;
    } catch (e) {
      if (e instanceof RpcError && e.code === RPC.CONTRACT_NOT_FOUND) return false;
      throw e;
    }
  }

  /**
   * A transaction by hash, from its status and its receipt.
   * @returns {Promise<null | { finality: string|null, execution: string|null, block: number|null,
   *   fee: { amount: bigint, unit: string } | null, revert: string|null }>} null when the node does not know it
   */
  async transaction(hash) {
    const felt = toFelt(hash);
    let status;
    try {
      status = await this.rpc.transactionStatus(felt);
    } catch (e) {
      if (e instanceof RpcError && e.code === RPC.TX_NOT_FOUND) return null;
      throw e;
    }
    const tx = {
      finality: text(status?.finality_status),
      execution: text(status?.execution_status),
      block: null,
      fee: null,
      revert: text(status?.failure_reason, 100_000),
    };
    let receipt;
    try {
      receipt = await this.rpc.transactionReceipt(felt);
    } catch (e) {
      if (e instanceof RpcError && e.code === RPC.TX_NOT_FOUND) return tx; // known, but no receipt yet
      throw e;
    }
    tx.finality = text(receipt?.finality_status) ?? tx.finality;
    tx.execution = text(receipt?.execution_status) ?? tx.execution;
    tx.revert = text(receipt?.revert_reason, 100_000) ?? tx.revert;
    if (Number.isSafeInteger(receipt?.block_number)) tx.block = receipt.block_number;
    try {
      const amount = feltOf(receipt?.actual_fee?.amount);
      tx.fee = { amount, unit: text(receipt?.actual_fee?.unit) ?? "FRI" };
    } catch {} // no fee yet
    return tx;
  }
}

/** A short string field of an answer, or null. */
function text(value, max = 64) {
  return typeof value === "string" && value !== "" ? value.slice(0, max) : null;
}
