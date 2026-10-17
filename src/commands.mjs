import { NodeBusy, RpcError } from './errors.mjs';
import { normalize, SELECTORS, u256, unsigned } from './felt.mjs';
import { amount, escapeHtml, short, textLines, utc } from './format.mjs';

export const COMMANDS = Object.freeze([
  { command: 'start', description: 'Welcome and privacy' },
  { command: 'help', description: 'Commands and privacy' },
  { command: 'status', description: 'Chain head and gas prices' },
  { command: 'balance', description: 'Registry token balances for an address' },
  { command: 'tx', description: 'Transaction status, fee and revert reason' },
]);
export function parseCommand(message, username) {
  const match = /^\/(\w+)(?:@(\w+))?(?=\s|$)(?:\s+([\s\S]*))?$/.exec(message?.text ?? '');
  if (!match || (match[2] && match[2].toLowerCase() !== username.toLowerCase())) return null;
  return { name: match[1].toLowerCase(), argument: (match[3] ?? '').trim() };
}
export async function answer(command, context) {
  const { config, rpc, username, clean, head, spec } = context;
  const text = (value) => textLines(value, clean);
  const link = (kind, value) => `<a href="${escapeHtml(clean(`${config.explorer}/${kind}/${value}`))}">${short(value)}</a>`;
  if (command.name === 'start' || command.name === 'help') {
    return [...text('Cairn · Starknet lookups\n/start — Welcome and privacy\n/help — Command guide\n/status — Chain head and gas prices\n/balance <address> — Registry token balances\n/tx <hash> — Status, fee and revert reason\n\nOn-chain facts, not financial advice.\nPublic balances and transfers only.\nThe operator stores the update offset and registered command list, never message text, names or usernames.\nLookups do not store addresses or hashes.'),
      `<a href="https://t.me/${escapeHtml(clean(username))}?startgroup=setup">Add Cairn to a group</a>`];
  }
  if (!['status', 'balance', 'tx'].includes(command.name)) return text('Unknown command. Use /help for available commands.');
  let input;
  if (command.name !== 'status') {
    try { input = normalize(command.argument, command.name === 'tx' ? 'hash' : 'address'); }
    catch (error) { return text(error.message); }
  } else if (command.argument) return text('Usage: /status (no arguments).');
  if (!head) return text('node busy — the lookup is unavailable. Please try again shortly.');
  try {
    switch (command.name) {
      case 'status':
        return text(`Starknet · ${config.chain}\nHead: ${head.block_number}\n${utc(head.timestamp)}\nL1 gas: ${unsigned(head.l1_gas_price.price_in_fri)} FRI\nL1-data gas: ${unsigned(head.l1_data_gas_price.price_in_fri)} FRI\nL2 gas: ${unsigned(head.l2_gas_price.price_in_fri)} FRI\nRPC spec: ${spec}`);
      case 'balance': {
        const block_id = { block_number: head.block_number };
        const lines = [...text(`Balances · ${config.chain} · block ${head.block_number}\n${utc(head.timestamp)}`), link('contract', input)];
        try { await rpc.call('starknet_getClassHashAt', { block_id, contract_address: input }); }
        catch (error) {
          if (error instanceof RpcError && error.code === 20) lines.push(...text('Account not deployed (balances still available).'));
          else if (error instanceof NodeBusy) throw error;
          else if (error instanceof RpcError) lines.push(...text(`Account deployment unavailable (${error.message}).`));
          else throw error;
        }
        for (const token of config.tokens) {
          try {
            const params = { request: { contract_address: token.address, entry_point_selector: SELECTORS.balance_of, calldata: [input] }, block_id };
            let result;
            try { result = await rpc.call('starknet_call', params); }
            catch (error) {
              if (!(error instanceof RpcError && error.code === 21)) throw error;
              params.request.entry_point_selector = SELECTORS.balanceOf;
              result = await rpc.call('starknet_call', params);
            }
            lines.push(...text(amount(u256(result), token.decimals, token.symbol)));
          } catch (error) {
            if (context.signal.aborted) throw error;
            lines.push(...text(`${token.symbol}: ${error instanceof NodeBusy ? 'node busy' : error instanceof RpcError ? error.message : 'error: invalid balance response'}. Other tokens are shown independently.`));
          }
        }
        return lines;
      }
      case 'tx': {
        const params = { transaction_hash: input };
        const status = await rpc.call('starknet_getTransactionStatus', params);
        let receipt;
        try { receipt = await rpc.call('starknet_getTransactionReceipt', params); }
        catch (error) {
          if (!(error instanceof RpcError && error.code === 29)) throw error;
          return [...text(`Transaction · ${config.chain}\nFinality: ${status.finality_status}\nExecution: ${status.execution_status ?? 'not yet executed'}\nBlock and fee: not yet available`), link('tx', input)];
        }
        const fee = receipt.actual_fee;
        const feeText = fee?.unit === 'FRI' ? amount(unsigned(fee.amount), 18, 'STRK') : fee?.unit === 'WEI' ? amount(unsigned(fee.amount), 18, 'ETH') : 'not yet available';
        const lines = [...text(`Transaction · ${config.chain}\nFinality: ${status.finality_status ?? receipt.finality_status}\nExecution: ${receipt.execution_status ?? status.execution_status ?? 'not yet executed'}\nBlock: ${receipt.block_number ?? 'not yet included'}\nFee: ${feeText}`), link('tx', input)];
        if (receipt.revert_reason) lines.push(...text(`Revert reason:\n${receipt.revert_reason}`));
        return lines;
      }
    }
  } catch (error) {
    if (context.signal.aborted) throw error;
    if (command.name === 'tx' && error instanceof RpcError && error.code === 29) return [...text('Transaction not found. Check the hash and selected chain.'), link('tx', input)];
    return text(error instanceof RpcError ? `Lookup unavailable (${error.message}). Try again later.` : 'node busy — the lookup is unavailable. Please try again shortly.');
  }
}
