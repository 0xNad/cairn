// What Cairn reads from Starknet, on top of rpc.mjs: the chain and spec check, the head, balances, contract
// presence and transactions. Read-only: block ids are only "latest" or {"block_number"}.
import { decodeShortString, fromFelt, toFelt, u256 } from "./felt.mjs";
import { RpcError } from "./rpc.mjs";

/** sn_keccak selectors (ARCHITECTURE.md lists them all). */
export const SELECTOR = {
  balance_of: 0x035a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33n,
  balanceOf: 0x02e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76en,
};

/** The spec's error codes Cairn acts on. */
export const ERROR = { CONTRACT_NOT_FOUND: 20, ENTRYPOINT_NOT_FOUND: 21, BLOCK_NOT_FOUND: 24, TX_NOT_FOUND: 29, CONTRACT_ERROR: 40 };

const MIN_SPEC = [0, 10, 0];

/** The node is on another chain, or speaks an older spec: exit 2. */
export class WrongNode extends Error {}

/** A chain id as its name (SN_MAIN) when it is a short string, else as hex. */
export function chainName(id) {
  return decodeShortString(id) ?? toFelt(fromFelt(id));
}

/** Whether a spec version string is at least 0.10.0. */
export function specSupported(spec) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(spec));
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  for (let i = 0; i < 3; i++) if (v[i] !== MIN_SPEC[i]) return v[i] > MIN_SPEC[i];
  return true;
}

const isCode = (e, code) => e instanceof RpcError && e.code === code;

export function starknet(rpc) {
  /** A call at `block` (a block number), or at "latest" if the node does not have that block yet. */
  async function call(contract, selector, calldata, block) {
    const request = { contract_address: toFelt(contract), entry_point_selector: toFelt(selector), calldata: calldata.map(toFelt) };
    try {
      return await rpc.call("starknet_call", { request, block_id: block === undefined ? "latest" : { block_number: block } });
    } catch (e) {
      if (block !== undefined && isCode(e, ERROR.BLOCK_NOT_FOUND)) return rpc.call("starknet_call", { request, block_id: "latest" });
      throw e;
    }
  }

  return {
    /**
     * Checks that the node is on `chain` and speaks spec 0.10 or later. Returns { name, id, spec }; throws
     * WrongNode, or NodeUnavailable when the node does not answer.
     */
    async checkChain(chain) {
      const id = await rpc.call("starknet_chainId");
      const spec = String(await rpc.call("starknet_specVersion"));
      const name = chainName(id);
      if (name !== chain) {
        const found = decodeShortString(id) ? `${name} (chain id ${id})` : `chain id ${id}`;
        throw new WrongNode(`the node is on ${found}, but CAIRN_CHAIN is ${chain}`);
      }
      if (!specSupported(spec)) throw new WrongNode(`the node speaks JSON-RPC spec ${spec}, and Cairn needs 0.10.0 or later`);
      return { name, id, spec };
    },

    blockNumber: () => rpc.call("starknet_blockNumber"),

    /** The latest block's header: number, hash, timestamp (chain time) and gas prices in FRI. */
    async head() {
      const b = await rpc.call("starknet_getBlockWithTxHashes", { block_id: "latest" });
      return {
        number: b.block_number,
        hash: fromFelt(b.block_hash),
        timestamp: b.timestamp,
        sequencer: fromFelt(b.sequencer_address),
        gas: { l1: fromFelt(b.l1_gas_price.price_in_fri), l1Data: fromFelt(b.l1_data_gas_price.price_in_fri), l2: fromFelt(b.l2_gas_price.price_in_fri) },
      };
    },

    /** A block's timestamp, or null when the node does not have it. */
    async blockTime(number) {
      try {
        return (await rpc.call("starknet_getBlockWithTxHashes", { block_id: { block_number: number } })).timestamp;
      } catch (e) {
        if (isCode(e, ERROR.BLOCK_NOT_FOUND)) return null;
        throw e;
      }
    },

    /** Whether a contract is deployed at `address` at `block` (or at "latest" if the node lacks that block). */
    async isDeployed(address, block) {
      const ask = (block_id) => rpc.call("starknet_getClassHashAt", { block_id, contract_address: toFelt(address) });
      try {
        await ask({ block_number: block }).catch((e) => {
          if (isCode(e, ERROR.BLOCK_NOT_FOUND)) return ask("latest");
          throw e;
        });
        return true;
      } catch (e) {
        if (isCode(e, ERROR.CONTRACT_NOT_FOUND)) return false;
        throw e;
      }
    },

    /** `owner`'s balance of `token` (a raw u256): balance_of, or balanceOf when balance_of does not exist. */
    async balance(token, owner, block) {
      let r;
      try {
        r = await call(token, SELECTOR.balance_of, [owner], block);
      } catch (e) {
        if (!isCode(e, ERROR.ENTRYPOINT_NOT_FOUND)) throw e;
        r = await call(token, SELECTOR.balanceOf, [owner], block);
      }
      return u256(r[0], r[1]);
    },

    /** A transaction's status, or null when the node does not know the hash. */
    async txStatus(hash) {
      try {
        return await rpc.call("starknet_getTransactionStatus", { transaction_hash: toFelt(hash) });
      } catch (e) {
        if (isCode(e, ERROR.TX_NOT_FOUND)) return null;
        throw e;
      }
    },

    /** A transaction's receipt, or null when it has none yet. */
    async txReceipt(hash) {
      try {
        return await rpc.call("starknet_getTransactionReceipt", { transaction_hash: toFelt(hash) });
      } catch (e) {
        if (isCode(e, ERROR.TX_NOT_FOUND)) return null;
        throw e;
      }
    },
  };
}
