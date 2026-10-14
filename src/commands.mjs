import { normalize } from './config.mjs';
import { CairnError, NodeBusy, RpcError } from './errors.mjs';
import { amount, escapeHtml as esc, link, messages, outsideLines, short, time, u256 } from './format.mjs';

export const COMMANDS = [
  { command: 'start', description: 'What Cairn does and how to add it to a group' },
  { command: 'help', description: 'Commands, public data and operator storage' },
  { command: 'status', description: 'Starknet head, block time and gas prices' },
  { command: 'balance', description: 'Exact public token balances: /balance 0x…' },
  { command: 'tx', description: 'Transaction status and fee: /tx 0x…' },
];
const BALANCE_OF = '0x035a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33';
const BALANCE_OF_LEGACY = '0x02e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e';
const BUSY = ['Node busy. Please try again shortly.'];

export function parse(message, username) {
  if (!message?.chat || typeof message.text !== 'string' || message.from?.is_bot) return null;
  const match = /^\/(\w+)(?:@(\w+))?(?=\s|$)/.exec(message.text);
  if (!match || (match[2] && match[2].toLowerCase() !== username.toLowerCase())) return null;
  return { name: match[1].toLowerCase(), args: message.text.slice(match[0].length).trim().split(/\s+/).filter(Boolean) };
}

function welcome(username) {
  return [
    '<b>Cairn</b> reads public Starknet data.', '',
    '/start — Welcome and group setup',
    '/help — Commands and privacy',
    '/status — Chain head, time and gas prices',
    '/balance &lt;address&gt; — Exact balances for the configured tokens',
    '/tx &lt;hash&gt; — Finality, execution and fee', '',
    'On-chain facts, not financial advice.',
    'Public balances and transfers only.', '',
    'The operator stores the update offset and registered command list locally. Message text, names and usernames are not stored.',
    link(`https://t.me/${username}?startgroup=setup`, 'Add Cairn to a group'),
  ];
}

function status(context) {
  const { config, rpc, head } = context;
  return [
    `<b>${esc(config.chain)}</b>`,
    `Head block: <b>${head.block_number}</b>`,
    time(head.timestamp), '',
    `L1 gas: ${BigInt(head.l1_gas_price.price_in_fri)} FRI`,
    `L1 data gas: ${BigInt(head.l1_data_gas_price.price_in_fri)} FRI`,
    `L2 gas: ${BigInt(head.l2_gas_price.price_in_fri)} FRI`,
    `RPC spec: ${esc(config.clean(rpc.identity.spec))}`,
  ];
}

async function balances(address, context) {
  const { config, rpc, head } = context;
  const block_id = { block_number: head.block_number };
  const lines = ['<b>Public balances</b>', link(`${config.explorer}/contract/${address}`, short(address)), `At block ${head.block_number}`];
  try { await rpc.call('starknet_getClassHashAt', { contract_address: address, block_id }); }
  catch (error) {
    if (error instanceof RpcError && error.code === 20) lines.push('Account not deployed. Tokens may still be held here.');
    else if (error instanceof NodeBusy) lines.push('Account status unavailable: node busy.');
    else if (error instanceof RpcError) lines.push('Account deployment status unavailable.');
    else throw error;
  }
  lines.push('');
  for (const token of config.tokens) {
    const request = { contract_address: token.address, entry_point_selector: BALANCE_OF, calldata: [address] };
    try {
      let result;
      try { result = await rpc.call('starknet_call', { request, block_id }); }
      catch (error) {
        if (!(error instanceof RpcError) || error.code !== 21) throw error;
        result = await rpc.call('starknet_call', { request: { ...request, entry_point_selector: BALANCE_OF_LEGACY }, block_id });
      }
      lines.push(esc(amount(u256(result), token.decimals, token.symbol)));
    } catch (error) {
      if (error instanceof CairnError && !(error instanceof NodeBusy)) throw error;
      if (rpc.signal.aborted) throw error;
      const reason = error instanceof NodeBusy ? 'node busy' : error instanceof RpcError ? `lookup failed (RPC ${error.code})` : 'invalid balance returned by node';
      lines.push(`${esc(token.symbol)}: unavailable, ${reason}.`);
    }
  }
  return lines;
}

async function transaction(hash, context) {
  const { config, rpc } = context;
  try {
    const receipt = await rpc.call('starknet_getTransactionReceipt', { transaction_hash: hash });
    const status = await rpc.call('starknet_getTransactionStatus', { transaction_hash: hash });
    const lines = ['<b>Transaction</b>', link(`${config.explorer}/tx/${hash}`, short(hash)),
      `Finality: ${esc(config.clean(status.finality_status ?? receipt.finality_status ?? 'unavailable'))}`,
      `Execution: ${esc(config.clean(status.execution_status ?? receipt.execution_status ?? 'unavailable'))}`,
      `Block: ${Number.isSafeInteger(receipt.block_number) ? receipt.block_number : 'not yet accepted'}`,
    ];
    if (receipt.actual_fee?.unit === 'FRI') lines.push(`Fee: ${esc(amount(receipt.actual_fee.amount, 18, 'STRK'))}`);
    else lines.push('Fee: unavailable in STRK.');
    const reason = receipt.revert_reason ?? status.failure_reason;
    if (reason) lines.push('', '<b>Revert reason</b>', ...outsideLines(config.clean(reason)));
    return lines;
  } catch (error) {
    if (error instanceof RpcError && error.code === 29) return ['Transaction not found.', link(`${config.explorer}/tx/${hash}`, short(hash))];
    if (error instanceof NodeBusy) return BUSY;
    if (error instanceof RpcError) return ['Transaction lookup failed. Please try again.'];
    throw error;
  }
}

export async function answer(command, context) {
  const { name, args } = command;
  if (name === 'start' || name === 'help') return messages(welcome(context.username));
  if (!['status', 'balance', 'tx'].includes(name)) return ['Unknown command. Use /help to see the commands.'];
  let value;
  if (name === 'balance' || name === 'tx') {
    try {
      if (args.length !== 1) throw new CairnError(`Provide one ${name === 'balance' ? 'address' : 'transaction hash'}. Use /${name} 0x…`, 2);
      value = normalize(args[0], name === 'balance' ? 'address' : 'transaction hash');
    } catch (error) { return [esc(error.message)]; }
  }
  if (!context.head) return BUSY;
  try {
    const lines = name === 'status' ? status(context) : name === 'balance' ? await balances(value, context) : await transaction(value, context);
    return messages(lines);
  } catch (error) {
    if (context.rpc.signal.aborted || error instanceof CairnError && !(error instanceof NodeBusy)) throw error;
    context.log('warn', 'lookup_unavailable', { command: name });
    return BUSY;
  }
}
