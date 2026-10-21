import { NodeBusy, RpcError } from './errors.mjs';
import { normalize, unsigned } from './felt.mjs';
import { amount, escapeHtml, short, textLines, utc } from './format.mjs';
import { balanceOf, tokenAmount } from './tokens.mjs';

export const COMMANDS = Object.freeze([
  { command: 'start', description: 'Welcome and privacy' },
  { command: 'help', description: 'Commands and privacy' },
  { command: 'status', description: 'Chain head and gas prices' },
  { command: 'balance', description: 'Wallet balances, optionally any ERC-20 token' },
  { command: 'tx', description: 'Transaction status, fee and revert reason' },
  ...[
    ['watch', 'Watch a wallet, optionally with a label'], ['unwatch', 'Remove a wallet by address or label'],
    ['list', 'Watched wallets and Remove buttons'], ['whale', 'Alert on large transfers of a token'],
    ['unwhale', 'Remove a whale threshold'], ['min', 'Set a minimum wallet transfer amount'],
    ['mute', 'Silence one token'], ['unmute', 'Restore alerts for a token'],
    ['track', 'Track L2 execution and L1 finality'], ['export', 'Export all stored chat data as JSON'],
    ['forget', 'Permanently delete this chat’s data'],
  ].map(([command, description]) => ({ command, description })),
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
    return [...text('Cairn · Starknet wallets\n/start — Welcome and privacy\n/help — Command guide\n/status — Chain head and gas prices\n/balance <address> [SYMBOL|token address] — Exact balances\n/tx <hash> — Status, fee and revert reason\n/watch <address> [label] — New wallet activity\n/unwatch <address|label> — Remove a watch\n/list — Watches and Remove buttons\n/whale <SYMBOL|token address> <amount> — Large transfers\n/unwhale <SYMBOL|token address> — Stop whale alerts\n/min <SYMBOL|token address> <amount> — Watch transfer floor\n/mute <token address> · /unmute <token address> — Control noise\n/track <hash> — L2 execution, then L1 finality or failure\n/export — All stored chat data as JSON\n/forget — Delete this chat’s data\n\nGroup settings, export and deletion require an admin; /list and lookups are public. Limits: 5 whales, 10 tracks, 10 commands per user per 60 seconds.\nOn-chain facts, not financial advice. Public balances and transfers only. No keys, signing or trading.\nStored: chat IDs, user IDs for rate limits, settings, watches, tracks, button actions and alert delivery records. Never Telegram names, usernames or incoming message text. A private pasted address/hash offers a Watch/Track button. Use /forget to erase these records.'),
      `<a href="https://t.me/${escapeHtml(clean(username))}?startgroup=setup">Add Cairn to a group</a>`];
  }
  if (!['status', 'balance', 'tx'].includes(command.name)) return text('Unknown command. Use /help for available commands.');
  let input, requested;
  if (command.name !== 'status') {
    try {
      const words = command.argument.split(/\s+/);
      if (command.name === 'balance' && words.length > 2) return text('Usage: /balance <address> [SYMBOL|token address]');
      input = normalize(command.name === 'balance' ? words[0] : command.argument, command.name === 'tx' ? 'hash' : 'address');
      if (command.name === 'balance') {
        requested = words[1];
        if (requested && !config.tokens.some(t => t.symbol.toLowerCase() === requested.toLowerCase())) normalize(requested);
      }
    }
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
        const metadataErrors = [];
        let selection = config.tokens.map(t => ({ ...t, verified: true }));
        if (requested) {
          const token = await context.tokens.get(requested);
          if (!token) return text('This token does not expose valid ERC-20 decimals (0–36).');
          selection = [token];
        } else if (context.tokens) {
          const watch = context.chat?.watches.find(w => w.address === input);
          for (const address of watch?.seen ?? []) {
            if (selection.some(t => t.address === address)) continue;
            try {
              const token = await context.tokens.get(address);
              if (token) selection.push({ ...token, nonzeroOnly: true });
              else metadataErrors.push(`${link('contract', address)} · ERC-20 metadata unavailable.`);
            } catch (error) {
              if (context.signal.aborted) throw error;
              metadataErrors.push(`${link('contract', address)} · node busy; other balances are shown independently.`);
            }
          }
        }
        for (const token of selection) {
          try {
            const value = await balanceOf(rpc, input, token, head.block_number);
            if (!token.nonzeroOnly || value !== 0n) lines.push(tokenAmount(value, token, context));
          } catch (error) {
            if (context.signal.aborted) throw error;
            lines.push(`${tokenAmount(0n, token, context).replace(/^0 /, '')}: ${escapeHtml(error instanceof NodeBusy ? 'node busy' : error instanceof RpcError ? error.message : 'error: invalid balance response')}. Other tokens are shown independently.`);
          }
        }
        return [...lines, ...metadataErrors];
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
