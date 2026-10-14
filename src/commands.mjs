import { normalizeFelt, shortFelt, uint256 } from './felt.mjs';
import { escapeHtml, decimal, utc, chunks } from './format.mjs';
import { RpcError } from './rpc.mjs';

const BALANCE_OF = '0x035a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33';
const BALANCE_LEGACY = '0x02e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e';
const commands = [
  { command: 'start', description: 'Welcome and command list' },
  { command: 'help', description: 'How to use Cairn' },
  { command: 'status', description: 'Latest Starknet block and gas' },
  { command: 'balance', description: 'Public token balances for an address' },
  { command: 'tx', description: 'Transaction status and fee' },
];
export const commandList = commands;
export const commandFingerprint = JSON.stringify(commands);

function welcome(username) {
  return `Cairn: Starknet lookups\n/start — welcome\n/help — commands\n/status — latest block and gas\n/balance &lt;address&gt; — registry token balances\n/tx &lt;hash&gt; — transaction result\nOn-chain facts, not financial advice.\nPublic balances and transfers only.\nThe operator stores chat ids and handled-update state, not message text, usernames or credentials.\n<a href="https://t.me/${escapeHtml(username)}?startgroup=setup">Add Cairn to a group</a>`;
}
function link(config, kind, felt) {
  return `<a href="${escapeHtml(config.explorer)}/${kind}/${felt}">${shortFelt(felt)}</a>`;
}
function blockStatus(config, block, spec) {
  return chunks([
    `Starknet ${config.chain} · block ${block.block_number}`,
    `${utc(block.timestamp)}`,
    `L1 gas: ${BigInt(block.l1_gas_price.price_in_fri)} FRI`,
    `L1 data gas: ${BigInt(block.l1_data_gas_price.price_in_fri)} FRI`,
    `L2 gas: ${BigInt(block.l2_gas_price.price_in_fri)} FRI`,
    `RPC spec: ${spec}`,
  ]);
}
async function balances(config, node, address) {
  const results = [`Balance for ${link(config, 'contract', address)}`];
  try { await node.call('starknet_getClassHashAt', { block_id: 'latest', contract_address: address }); }
  catch (e) { if (e.code === 20) results.push('Address not deployed'); else results.push('Account status unavailable'); }
  for (const token of config.tokens) {
    try {
      let felts;
      const request = (selector) => node.call('starknet_call', { request: { contract_address: token.address, entry_point_selector: selector, calldata: [address] }, block_id: 'latest' });
      try { felts = await request(BALANCE_OF); }
      catch (e) { if (e.code !== 21) throw e; felts = await request(BALANCE_LEGACY); }
      results.push(`${decimal(uint256(felts), token.decimals)} ${token.symbol}`);
    } catch { results.push(`${token.symbol}: error (unavailable)`); }
  }
  const [first, ...other] = results;
  return chunks(other, 4000).map((text, i) => i === 0 ? `${first}\n${text}` : text);
}
async function transaction(config, node, hash) {
  let status;
  try { status = await node.call('starknet_getTransactionStatus', { transaction_hash: hash }); }
  catch (e) { if (e.code === 29) return chunks(['Transaction not found']); throw e; }
  let receipt;
  try { receipt = await node.call('starknet_getTransactionReceipt', { transaction_hash: hash }); }
  catch (e) { if (e.code === 29) return chunks(['Transaction not found']); throw e; }
  const lines = [
    `Transaction ${link(config, 'tx', hash)}`,
    `Finality: ${status.finality_status ?? receipt.finality_status ?? 'unknown'}`,
    `Execution: ${receipt.execution_status ?? status.execution_status ?? 'unknown'}`,
    `Block: ${receipt.block_number ?? 'unconfirmed'}`,
    `Fee: ${decimal(BigInt(receipt.actual_fee?.amount ?? '0x0'), 18)} STRK`,
  ];
  const reason = receipt.revert_reason ?? status.failure_reason;
  if (reason) lines.push(`Revert reason: ${reason}`);
  // Preserve the anchor only on the first chunk; other chunks contain escaped plain text.
  const [first, ...other] = lines;
  return chunks(other, 4000).map((text, i) => i === 0 ? `${first}\n${text}` : text);
}
export async function respond(text, username, config, node, block, spec) {
  const match = /^\/(\w+)(?:@(\w+))?/.exec(text);
  if (!match || (match[2] && match[2].toLowerCase() !== username.toLowerCase())) return [];
  const verb = match[1].toLowerCase();
  const argument = text.slice(match[0].length).trim().split(/\s+/)[0];
  if (verb === 'start' || verb === 'help') return [welcome(username)];
  if (!['status', 'balance', 'tx'].includes(verb)) return chunks(['Unknown command. Try /help.']);
  let felt;
  if (verb === 'balance' || verb === 'tx') {
    try { felt = normalizeFelt(argument, verb === 'balance' ? 'address' : 'hash'); }
    catch { return chunks([verb === 'balance' ? 'Invalid address. Use /balance 0x…' : 'Invalid transaction hash. Use /tx 0x…']); }
  }
  if (!block) return chunks(['Node busy. Try again later.']);
  try {
    if (verb === 'status') return blockStatus(config, block, spec);
    if (verb === 'balance') return await balances(config, node, felt);
    return await transaction(config, node, felt);
  } catch (e) {
    if (e instanceof RpcError) return chunks(['Node busy. Try again later.']);
    throw e;
  }
}
