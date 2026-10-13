import { normalize } from './config.mjs';
import { RpcError } from './transport.mjs';
import { amount, short, u256, unsigned, utc } from './format.mjs';

export const COMMANDS = [
  { command: 'start', description: 'Welcome and commands' },
  { command: 'help', description: 'Commands and privacy' },
  { command: 'status', description: 'Chain head and gas prices' },
  { command: 'balance', description: 'Public token balances for an address' },
  { command: 'tx', description: 'Transaction status and fee' },
];
const BALANCE_OF = '0x035a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33';
const LEGACY_BALANCE = '0x02e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e';
const BUSY = 'Node busy. Please try again.';
const count = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RpcError();
  return value;
};

export async function reply(message, { c, bot, rpc, head }) {
  if (typeof message?.text !== 'string' || !Number.isSafeInteger(message.chat?.id)) return [];
  const match = /^\/(\w+)(?:@(\w+))?/.exec(message.text);
  if (!match || (match[2] && match[2].toLowerCase() !== bot.toLowerCase())) return [];
  const command = match[1];
  const args = message.text.slice(match[0].length).trim();
  if (command === 'help' || command === 'start') return [
    { text: 'Cairn · Starknet lookups', bold: true },
    '/balance <address> — token balances',
    '/tx <hash> — transaction status and fee',
    '/status — chain head and gas prices',
    '/help — commands and privacy',
    '/start — welcome', '',
    'On-chain facts, not financial advice.', 'Public balances and transfers only.', '',
    'The operator stores the handled-update offset and registered command list. No message text, names or usernames are stored.', '',
    { text: 'Add Cairn to a group', href: `https://t.me/${bot}?startgroup=setup` },
  ];
  if (!['status', 'balance', 'tx'].includes(command)) return ['Unknown command. Use /help to see the commands.'];
  let input;
  if (command !== 'status') {
    try { input = normalize(args, command === 'balance' ? 'address' : 'hash'); }
    catch (e) { return [e.message]; }
  }
  if (!head) return [BUSY];
  try {
    if (command === 'status') return [
      { text: `${c.chain} · Block ${count(head.block_number)}`, bold: true },
      utc(head.timestamp), '',
      `L1 gas: ${unsigned(head.l1_gas_price?.price_in_fri)} FRI`,
      `L1 data gas: ${unsigned(head.l1_data_gas_price?.price_in_fri)} FRI`,
      `L2 gas: ${unsigned(head.l2_gas_price?.price_in_fri)} FRI`, '',
      `RPC spec: ${rpc.spec}`,
    ];
    if (command === 'balance') {
      const lines = [{ text: `Balances · ${short(input)}`, href: `${c.explorer}/contract/${input}` }];
      const block_id = { block_number: count(head.block_number) };
      try { await rpc.call('starknet_getClassHashAt', { block_id, contract_address: input }); }
      catch (e) {
        if (e.code === 20) lines.push('Address not deployed; tokens can still be held here.');
        else { if (e.exit || e.name === 'AbortError') throw e; lines.push('Deployment check unavailable.'); }
      }
      for (const token of c.tokens) {
        try {
          const request = { contract_address: token.address, entry_point_selector: BALANCE_OF, calldata: [input] };
          let felts;
          try { felts = await rpc.call('starknet_call', { request, block_id }); }
          catch (e) {
            if (e.code !== 21) throw e;
            felts = await rpc.call('starknet_call', { request: { ...request, entry_point_selector: LEGACY_BALANCE }, block_id });
          }
          lines.push(`${amount(u256(felts), token.decimals)} ${token.symbol}`);
        } catch (e) {
          if (e.exit || e.name === 'AbortError') throw e;
          lines.push(`${token.symbol}: ${e.code === 40 ? 'contract error' : 'unavailable — node busy'}`);
        }
      }
      return lines;
    }
    const params = { transaction_hash: input };
    const status = await rpc.call('starknet_getTransactionStatus', params);
    const receipt = await rpc.call('starknet_getTransactionReceipt', params);
    if (typeof status?.finality_status !== 'string' || typeof receipt?.execution_status !== 'string') throw new RpcError();
    const lines = [
      { text: `${receipt.execution_status} · ${status.finality_status}`, bold: true },
      `Block ${count(receipt.block_number)}`,
      receipt.actual_fee?.unit === 'FRI' ? `Fee: ${amount(unsigned(receipt.actual_fee.amount), 18)} STRK` : 'Fee unavailable: node did not report FRI.',
      { text: `Transaction · ${short(input)}`, href: `${c.explorer}/tx/${input}` },
    ];
    if (receipt.execution_status === 'REVERTED') lines.push('', 'Revert reason:', typeof receipt.revert_reason === 'string' ? receipt.revert_reason : 'Not provided by the node.');
    return lines;
  } catch (e) {
    if (e.exit || e.name === 'AbortError') throw e;
    return [e.code === 29 ? 'Transaction not found.' : BUSY];
  }
}
