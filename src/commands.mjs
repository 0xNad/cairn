// The command list, the command parser and the lookups: /start, /help, /status, /balance and /tx (round 1),
// and the reply to an address or a hash pasted in a private chat. Round 2's settings are in settings.mjs. A
// reply is { lines, keyboard }: HTML lines, and inline buttons under its last message.
import { NodeBusy, RpcError } from './errors.mjs';
import { normalize, unsigned } from './felt.mjs';
import { amount, escapeHtml, feeText, textLines, utc } from './format.mjs';
import { offer } from './offers.mjs';
import { tokenAmount, tokenName } from './tokens.mjs';

export const COMMANDS = Object.freeze([
  { command: 'start', description: 'Welcome and privacy' },
  { command: 'help', description: 'Commands and privacy' },
  { command: 'status', description: 'Chain head and gas prices' },
  { command: 'balance', description: 'Token balances for an address' },
  { command: 'tx', description: 'Transaction status, fee and revert reason' },
  { command: 'watch', description: 'Alert when an address moves any token' },
  { command: 'unwatch', description: 'Stop watching an address' },
  { command: 'list', description: "This chat's subscriptions" },
  { command: 'whale', description: 'Post every transfer of a token above an amount' },
  { command: 'unwhale', description: 'Stop the whale posts of a token' },
  { command: 'min', description: 'Hide watch alerts under an amount' },
  { command: 'mute', description: 'Silence a token in this chat' },
  { command: 'unmute', description: 'Undo /mute' },
  { command: 'track', description: 'Follow a transaction to L2 and L1' },
  { command: 'export', description: 'Everything stored for this chat' },
  { command: 'forget', description: 'Delete everything stored for this chat' },
]);
export function parseCommand(message, username) {
  const match = /^\/(\w+)(?:@(\w+))?(?=\s|$)(?:\s+([\s\S]*))?$/.exec(message?.text ?? '');
  if (!match || (match[2] && match[2].toLowerCase() !== username.toLowerCase())) return null;
  return { name: match[1].toLowerCase(), argument: (match[3] ?? '').trim() };
}

const BUSY = 'node busy — the lookup is unavailable. Please try again shortly.';
const help = (config) => `Cairn · Starknet lookups and wallet alerts
/start — Welcome and privacy
/help — Command guide
/status — Chain head and gas prices
/balance <address> [token] — Token balances
/tx <hash> — Status, fee and revert reason
/watch <address> [label] — Alerts when it moves any token, or grants an approval
/unwatch <address|label> — Stop watching it
/list — This chat's subscriptions, with Remove buttons
/whale <token> <amount> — Post every transfer of a token from that amount up
/unwhale <token> — Stop the whale posts of a token
/min <token> <amount> — Hide watch alerts under an amount (0 removes the floor)
/mute <token address> — Silence a token in this chat, such as a spam airdrop
/unmute <token address> — Undo /mute
/track <hash> — One post on L2 acceptance, then one on L1 acceptance or a revert
/export — Everything stored for this chat, as JSON
/forget — Delete everything stored for this chat
A token is a registry symbol (${config.tokens.slice(0, 3).map((t) => t.symbol).join(', ')}…) or a token contract address; any other contract is marked unverified. In a private chat, paste an address or a transaction hash. In groups, only administrators change the settings; /list and the lookups are open to everyone.

On-chain facts, not financial advice.
Public balances and transfers only.
The operator stores, per chat, its subscriptions (addresses and their labels, thresholds, floors, mutes, tracked hashes), its alerts of the last 7 days (transaction hashes and message ids) and, for a day, an address or hash pasted for its Watch or Track button; also the update offset, the command list, token metadata and, for one minute, a user's id with the times of their commands (the rate limit). Never message text, names or usernames; /balance and /tx store nothing. /export shows a chat's data and /forget deletes it.`;

export async function answer(command, context) {
  const text = (value) => ({ lines: textLines(value, context.clean) });
  switch (command.name) {
    case 'start':
    case 'help':
      return { lines: [...textLines(help(context.config), context.clean),
        `<a href="https://t.me/${escapeHtml(context.clean(context.username))}?startgroup=setup">Add Cairn to a group</a>`] };
    case 'status': return text(command.argument ? 'Usage: /status (no arguments).' : status(context));
    case 'balance': return balanceCommand(command.argument, context);
    case 'tx': {
      let hash;
      try { hash = normalize(command.argument, 'hash'); } catch (error) { return text(error.message); }
      return { lines: await transaction(hash, context) };
    }
    default: return text('Unknown command. Use /help for available commands.');
  }
}

function status({ config, head, spec }) {
  if (!head) return BUSY;
  try {
    return `Starknet · ${config.chain}\nHead: ${head.block_number}\n${utc(head.timestamp)}\nL1 gas: ${unsigned(head.l1_gas_price?.price_in_fri)} FRI\nL1-data gas: ${unsigned(head.l1_data_gas_price?.price_in_fri)} FRI\nL2 gas: ${unsigned(head.l2_gas_price?.price_in_fri)} FRI\nRPC spec: ${spec}`;
  } catch { return BUSY; } // a header without valid gas prices
}

async function balanceCommand(argument, context) {
  const text = (value) => ({ lines: textLines(value, context.clean) });
  const [first = '', token, ...extra] = argument.split(/\s+/).filter(Boolean);
  let address;
  try { address = normalize(first, 'address'); } catch (error) { return text(error.message); }
  if (extra.length) return text('Usage: /balance <address> [SYMBOL|token address]');
  if (!context.head) return text(BUSY);
  let only = null;
  if (token) {
    try {
      const found = await context.tokens.resolve(token, context.head.timestamp);
      if (found.error) return text(found.error);
      only = found.token;
    } catch (error) {
      if (context.signal.aborted || !(error instanceof NodeBusy || error instanceof RpcError)) throw error;
      return text(BUSY);
    }
  }
  return { lines: await balances(address, only, context) };
}

/**
 * The balances of `address` at the head: of `only`; or of every registry token, in registry order, then, when
 * the chat watches the address, of the tokens outside the registry seen moving for it (the non-zero ones).
 */
async function balances(address, only, context) {
  const { config, rpc, head, tokens, clean, link, chat } = context;
  const text = (value) => textLines(value, clean);
  const block_id = { block_number: head.block_number };
  const lines = [...text(`Balances · ${config.chain} · block ${head.block_number}\n${utc(head.timestamp)}`), link('contract', address)];
  try { await rpc.call('starknet_getClassHashAt', { block_id, contract_address: address }); }
  catch (error) {
    if (error instanceof RpcError && error.code === 20) lines.push(...text('Account not deployed (balances still available).'));
    else if (error instanceof NodeBusy) return text(BUSY);
    else if (error instanceof RpcError) lines.push(...text(`Account deployment unavailable (${error.message}).`));
    else throw error;
  }
  const reason = (error) => (error instanceof NodeBusy ? 'node busy' : error instanceof RpcError ? error.message : 'error: invalid balance response');
  for (const token of only ? [only] : tokens.registry.values()) {
    try {
      const raw = await tokens.balance(token, address, block_id);
      lines.push(...(token.verified ? text(amount(raw, token.decimals, token.symbol)) : [tokenAmount(raw, token, link)]));
    } catch (error) {
      if (context.signal.aborted) throw error;
      if (token.verified) lines.push(...text(`${token.symbol}: ${reason(error)}. Other tokens are shown independently.`));
      else lines.push(`${tokenName(token, link)}: ${escapeHtml(reason(error))}.`);
    }
  }
  const watch = only ? null : chat?.watches.find((w) => w.address === address);
  const seen = [];
  for (const tokenAddress of watch?.seen ?? []) {
    if (chat.muted.some((m) => m.token === tokenAddress)) continue;
    try {
      const token = await tokens.get(tokenAddress, head.timestamp);
      const raw = token ? await tokens.balance(token, address, block_id) : 0n;
      if (raw > 0n) seen.push(tokenAmount(raw, token, link));
    } catch (error) {
      if (context.signal.aborted) throw error; // a token that cannot be read now is left out
    }
  }
  if (seen.length) lines.push(...text('Also seen moving since the watch began:'), ...seen);
  return lines;
}

/** The /tx reply: finality, execution, block, fee, revert reason and link. `known` is a status already read. */
async function transaction(hash, context, known) {
  const { config, rpc, clean, link } = context;
  const text = (value) => textLines(value, clean);
  if (!context.head && !known) return text(BUSY);
  const params = { transaction_hash: hash };
  try {
    const status = known ?? await rpc.call('starknet_getTransactionStatus', params);
    let receipt;
    try { receipt = await rpc.call('starknet_getTransactionReceipt', params); }
    catch (error) {
      if (!(error instanceof RpcError && error.code === 29)) throw error;
      return [...text(`Transaction · ${config.chain}\nFinality: ${status.finality_status}\nExecution: ${status.execution_status ?? 'not yet executed'}\nBlock and fee: not yet available`), link('tx', hash)];
    }
    const lines = [...text(`Transaction · ${config.chain}\nFinality: ${status.finality_status ?? receipt.finality_status}\nExecution: ${receipt.execution_status ?? status.execution_status ?? 'not yet executed'}\nBlock: ${receipt.block_number ?? 'not yet included'}\nFee: ${feeText(receipt.actual_fee)}`), link('tx', hash)];
    if (receipt.revert_reason) lines.push(...text(`Revert reason:\n${receipt.revert_reason}`));
    return lines;
  } catch (error) {
    if (context.signal.aborted) throw error;
    if (error instanceof RpcError && error.code === 29) return [...text('Transaction not found. Check the hash and selected chain.'), link('tx', hash)];
    return text(error instanceof RpcError ? `Lookup unavailable (${error.message}). Try again later.` : BUSY);
  }
}

/**
 * An address or a transaction hash pasted in a private chat: the /tx reply with a Track button when the node
 * knows the transaction, else the /balance reply with a Watch button.
 */
export async function pasted(value, context) {
  const text = (line) => ({ lines: textLines(line, context.clean) });
  let hash;
  try { hash = normalize(value, 'hash'); } catch (error) { return text(error.message); }
  if (!context.head) return text(BUSY);
  let status = null;
  try { status = await context.rpc.call('starknet_getTransactionStatus', { transaction_hash: hash }); }
  catch (error) {
    if (context.signal.aborted) throw error;
    if (!(error instanceof RpcError && error.code === 29)) return text(error instanceof RpcError ? `Lookup unavailable (${error.message}). Try again later.` : BUSY);
  }
  if (status) {
    const lines = await transaction(hash, context, status);
    return { lines, keyboard: [[{ text: '📍 Track', callback_data: offer(context.state, context.chatId, 'track', hash, context.head.timestamp) }]] };
  }
  let address;
  try { address = normalize(value, 'address'); } catch { return text('No transaction has this hash, and it is too large to be an address.'); }
  const lines = await balances(address, null, context);
  return { lines, keyboard: [[{ text: '👁 Watch', callback_data: offer(context.state, context.chatId, 'watch', address, context.head.timestamp) }]] };
}
