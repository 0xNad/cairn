// Typed Starknet reads over the JSON-RPC client. Read-only: no starknet_add* method exists here, and the
// only block ids used are "latest" and {"block_number"} (never "pending" or "pre_confirmed").
import { EXIT, Fatal } from "./errors.mjs";
import { felt, shortString, toBig, u256 } from "./felt.mjs";
import { NodeUnavailable, RpcError } from "./rpc.mjs";

// sn_keccak selectors, from ARCHITECTURE.md.
export const SELECTOR = {
  Transfer: 0x0099cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9n,
  balance_of: 0x035a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33n,
  balanceOf: 0x02e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76en,
};

// The spec's error codes that Cairn answers differently.
export const ERR = { CONTRACT_NOT_FOUND: 20, ENTRYPOINT_NOT_FOUND: 21, BLOCK_NOT_FOUND: 24, TX_NOT_FOUND: 29, CONTRACT_ERROR: 40 };

// The token a fee unit is paid in (the same contracts on mainnet and Sepolia).
export const FEE_TOKENS = {
  FRI: { symbol: "STRK", decimals: 18, address: 0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938dn },
  WEI: { symbol: "ETH", decimals: 18, address: 0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7n },
};

const MIN_SPEC = [0, 10, 0];
const LATEST = "latest";

// A block header as Cairn uses it: number, hash, timestamp (chain time), sequencer and gas prices in FRI.
function header(b) {
  const number = Number(b?.block_number);
  if (!Number.isSafeInteger(number)) throw new NodeUnavailable("the node answered a block without a number");
  const fri = (p) => toBig(p?.price_in_fri);
  return {
    number,
    hash: toBig(b.block_hash),
    timestamp: Number(b.timestamp),
    sequencer: toBig(b.sequencer_address),
    gas: { l1: fri(b.l1_gas_price), l1Data: fri(b.l1_data_gas_price), l2: fri(b.l2_gas_price) },
  };
}

// Whether a spec version string is at least 0.10.0; false when it cannot be read.
export function specSupported(spec) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(spec));
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  for (let i = 0; i < 3; i++) if (v[i] !== MIN_SPEC[i]) return v[i] > MIN_SPEC[i];
  return true;
}

export function starknet(rpc) {
  const call = (contract, selector, calldata) =>
    rpc.call("starknet_call", { request: { contract_address: felt(contract), entry_point_selector: felt(selector), calldata: calldata.map(felt) }, block_id: LATEST });

  return {
    // The node's chain and spec version; a Fatal (exit 2) when they are not what Cairn needs.
    async verify(expected) {
      const id = await rpc.call("starknet_chainId");
      const name = shortString(id);
      if (name !== expected) throw new Fatal(EXIT.CONFIG, `the node is on ${name ?? "an unknown chain"} (chain id ${id}), but CAIRN_CHAIN is ${expected}: point STARKNET_RPC_URL at a ${expected} node, or change CAIRN_CHAIN`);
      const spec = await rpc.call("starknet_specVersion");
      if (!specSupported(spec)) throw new Fatal(EXIT.CONFIG, `the node speaks JSON-RPC ${JSON.stringify(spec)}, but Cairn needs 0.10.0 or later: use a node that serves the 0.10 API`);
      return { chain: name, spec: String(spec) };
    },

    blockNumber: () => rpc.call("starknet_blockNumber"),

    // The latest block's header.
    async head() {
      return header(await rpc.call("starknet_getBlockWithTxHashes", { block_id: LATEST }));
    },

    async block(number) {
      return header(await rpc.call("starknet_getBlockWithTxHashes", { block_id: { block_number: number } }));
    },

    // An ERC-20 balance: balance_of, or balanceOf when the contract has no balance_of (error 21).
    async balance(token, owner) {
      let felts;
      try {
        felts = await call(token, SELECTOR.balance_of, [owner]);
      } catch (e) {
        if (!(e instanceof RpcError && e.code === ERR.ENTRYPOINT_NOT_FOUND)) throw e;
        felts = await call(token, SELECTOR.balanceOf, [owner]);
      }
      const [low, high] = (felts ?? []).map(toBig);
      if (low === null || low === undefined || high === null || high === undefined) throw new RpcError(ERR.CONTRACT_ERROR, "the balance is not a u256");
      return u256(low, high);
    },

    // Whether a contract is deployed at `address`: false when the node answers 20 (contract not found).
    async deployed(address) {
      try {
        await rpc.call("starknet_getClassHashAt", { block_id: LATEST, contract_address: felt(address) });
        return true;
      } catch (e) {
        if (e instanceof RpcError && e.code === ERR.CONTRACT_NOT_FOUND) return false;
        throw e;
      }
    },

    receipt: (hash) => rpc.call("starknet_getTransactionReceipt", { transaction_hash: felt(hash) }),
    status: (hash) => rpc.call("starknet_getTransactionStatus", { transaction_hash: felt(hash) }),
  };
}
