// What Cairn reads from the chain, over rpc.mjs (ARCHITECTURE.md, "Starknet access"). Read-only: no
// starknet_add* call exists here, and the only block ids are "latest", {block_number} and {block_hash}.
import { CHAINS } from "./config.mjs";
import { refuse } from "./errors.mjs";
import { felt, shortString, toBig, u256 } from "./felt.mjs";
import { NodeUnavailable, RpcError } from "./rpc.mjs";
import { SEL } from "./selectors.mjs";

export const LATEST = "latest";
export const atBlock = (number) => ({ block_number: number });

export function createChain(rpc) {
  const call = (contract, selector, calldata = [], blockId = LATEST) =>
    rpc.call("starknet_call", { request: { contract_address: felt(contract), entry_point_selector: felt(selector), calldata: calldata.map(felt) }, block_id: blockId });
  return {
    rpc,
    chainId: () => rpc.call("starknet_chainId"),
    specVersion: () => rpc.call("starknet_specVersion"),
    blockNumber: () => rpc.call("starknet_blockNumber"),
    /** The latest block's header (the pass's head), or a given block's. */
    header: async (blockId = LATEST, opts) => readHeader(await rpc.call("starknet_getBlockWithTxHashes", { block_id: blockId }, opts)),
    call,
    classHashAt: (address, blockId = LATEST) => rpc.call("starknet_getClassHashAt", { block_id: blockId, contract_address: felt(address) }),
    txStatus: (hash) => rpc.call("starknet_getTransactionStatus", { transaction_hash: felt(hash) }),
    receipt: (hash) => rpc.call("starknet_getTransactionReceipt", { transaction_hash: felt(hash) }),
  };
}

/**
 * Checks the node once per process, before any other chain call: its chain must be CAIRN_CHAIN and its
 * JSON-RPC spec at least 0.10.0, or the command exits 2 naming what the node reported.
 */
export async function checkNode(chain, want) {
  const [id, spec] = await Promise.all([chain.chainId(), chain.specVersion()]).catch((e) => {
    if (!(e instanceof RpcError)) throw e;
    throw refuse(`the node answered the chain id or spec version with an error (${e.message.slice(0, 120)}): STARKNET_RPC_URL should be a Starknet JSON-RPC 0.10 endpoint`);
  });
  let value;
  try {
    value = toBig(id);
  } catch {
    throw new NodeUnavailable("a chain id Cairn cannot read");
  }
  const name = shortString(value) || felt(value);
  if (value !== CHAINS[want].id) throw refuse(`the node is on ${name} (chain id ${felt(value)}), but CAIRN_CHAIN is ${want}: point STARKNET_RPC_URL at a ${want} node, or change CAIRN_CHAIN`);
  const v = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(spec));
  if (!v) throw refuse(`the node reports the RPC spec version ${JSON.stringify(String(spec).slice(0, 40))}, which Cairn cannot read: it needs 0.10.0 or later`);
  if (Number(v[1]) === 0 && Number(v[2]) < 10) throw refuse(`the node speaks JSON-RPC ${spec}, but Cairn needs 0.10.0 or later: use the provider's v0_10 endpoint`);
  return { chain: name, spec: String(spec) };
}

/** A block header: number, hash, timestamp (chain time), sequencer and the three gas prices in FRI. */
function readHeader(b) {
  try {
    return {
      number: Number(toBig(b.block_number)),
      hash: toBig(b.block_hash),
      timestamp: Number(toBig(b.timestamp)),
      sequencer: toBig(b.sequencer_address),
      gas: { l1: toBig(b.l1_gas_price.price_in_fri), l1Data: toBig(b.l1_data_gas_price.price_in_fri), l2: toBig(b.l2_gas_price.price_in_fri) },
      txCount: Number(b.transaction_count ?? b.transactions?.length ?? 0),
      version: typeof b.starknet_version === "string" ? b.starknet_version : null,
    };
  } catch {
    throw new NodeUnavailable("a block header Cairn cannot read");
  }
}

/** Whether a call failed because the contract has no such entry point (spec error 21, or some nodes' error 40). */
const noEntryPoint = (e) => e instanceof RpcError && (e.code === 21 || (e.code === 40 && /entry ?point.{0,80}not (found|exist)/i.test(JSON.stringify(e.data ?? ""))));

/** An ERC-20 balance as a u256: balance_of, falling back to balanceOf on a contract that lacks it. */
export async function balanceOf(chain, token, owner, blockId) {
  let r;
  try {
    r = await chain.call(token, SEL.balance_of, [owner], blockId);
  } catch (e) {
    if (!noEntryPoint(e)) throw e;
    r = await chain.call(token, SEL.balanceOf, [owner], blockId);
  }
  if (!Array.isArray(r) || r.length < 1) throw new RpcError(40, "an empty balance");
  return r.length === 1 ? toBig(r[0]) : u256(r[0], r[1]);
}
