import { NodeBusy, RpcError } from './errors.mjs';
import { normalize, unsigned } from './felt.mjs';
import { amount, decimal, escapeHtml, links, textLines, utc } from './format.mjs';
import { callback, setting, SETTINGS } from './settings.mjs';
import { balanceOf } from './tokens.mjs';

export const COMMANDS = Object.freeze([
  { command: 'start', description: 'Welcome and privacy' },
  { command: 'help', description: 'Commands and privacy' },
  { command: 'status', description: 'Chain head and gas prices' },
  { command: 'balance', description: 'Exact token balances for an address' },
  { command: 'tx', description: 'Transaction status, fee and revert reason' },
  { command: 'watch', description: 'Alert on every transfer and approval of an address' },
  { command: 'unwatch', description: 'Stop watching an address' },
  { command: 'list', description: 'This chat\'s watches and alerts, with Remove buttons' },
  { command: 'whale', description: 'Alert on large transfers of a token' },
  { command: 'unwhale', description: 'Stop a whale alert' },
  { command: 'min', description: 'Skip watch alerts below an amount of a token' },
  { command: 'mute', description: 'Silence one token in this chat' },
  { command: 'unmute', description: 'Undo /mute' },
  { command: 'track', description: 'Follow one transaction until it is final' },
  { command: 'export', description: 'Everything Cairn stores for this chat, as JSON' },
  { command: 'forget', description: 'Delete everything Cairn stores for this chat' },
]);
export function parseCommand(message, username) {
  const match = /^\/(\w+)(?:@(\w+))?(?=\s|$)(?:\s+([\s\S]*))?$/.exec(message?.text ?? '');
  if (!match || (match[2] && match[2].toLowerCase() !== username.toLowerCase())) return null;
  return { name: match[1].toLowerCase(), argument: (match[3] ?? '').trim() };
}
/** In a private chat, a pasted address or transaction hash is looked up as if it were a command. */
export function parsePaste(message) {
  if (message?.chat?.type !== 'private') return null;
  const match = /^\s*(0x[0-9a-fA-F]{1,64})\s*$/.exec(message.text ?? '');
  return match ? { name: 'paste', argument: match[1] } : null;
}

const HELP = `Cairn · Starknet lookups and wallet alerts
Lookups, for everyone:
/status — Chain head and gas prices
/balance <address> [token] — Exact balances, one token or every verified one
/tx <hash> — Status, fee and revert reason
In a private chat, paste an address or a transaction hash to look it up.
Alerts, set by group administrators (anyone in a private chat):
/watch <address> [label] — Every transfer in or out, on any token, and every approval
/unwatch <address|label> — Stop watching
/whale <token> <amount> — Every transfer of a token at or above an amount
/unwhale <token> — Stop a whale alert
/min <token> <amount> — Skip watch alerts below an amount (0 removes it)
/mute <token address> — Silence one token in this chat, such as a spam airdrop
/unmute <token address> — Undo /mute
/track <hash> — One message on L2 acceptance, one on L1 acceptance or a revert
This chat:
/list — Its watches, alerts, floors and mutes, with Remove buttons
/export — Everything Cairn stores for it, as JSON
/forget — Delete all of it
/start — Welcome and privacy
/help — Command guide

On-chain facts, not financial advice.
Public balances and transfers only.
Tokens outside Cairn's registry are marked unverified: anyone can deploy a token with any symbol.
The operator stores this chat's id and type, its settings (watched addresses and labels, whale alerts, floors, mutes, tracked transactions), the tokens seen moving for a watched address, alert delivery records for 7 days, and the update offset. Never message text, names or usernames. /export shows it; /forget deletes it.`;
const GROUP_SETUP = `Cairn is in this group. To set it up, as an administrator:
1. /watch <address> <label> for each wallet the group follows.
2. /whale <token> <amount> for large transfers of a token.
3. /min and /mute to cut noise.
Members can use /status, /balance, /tx and /list. Cairn reads only the commands addressed to it.`;

export async function answer(command, context) {
  const { config, rpc, username, clean, head, spec } = context;
  const text = (value) => textLines(value, clean);
  const fmt = context.fmt ?? links(config, clean);
  const link = (kind, value) => fmt.link(kind, value);
  if (command.name === 'start' || command.name === 'help') {
    if (command.name === 'start' && command.argument === 'setup' && context.chat && context.chat.type !== 'private') return text(GROUP_SETUP);
    return [...text(HELP), `<a href="https://t.me/${escapeHtml(clean(username))}?startgroup=setup">Add Cairn to a group</a>`];
  }
  if (!['status', 'balance', 'tx'].includes(command.name)) return text('Unknown command. Use /help for available commands.');
  let input, tokenArgument;
  if (command.name === 'balance') {
    const [address = '', token, ...extra] = command.argument.split(/\s+/).filter(Boolean);
    try { input = normalize(address, 'address'); } catch (error) { return text(error.message); }
    if (extra.length) return text('Usage: /balance <address> [SYMBOL|token address].');
    tokenArgument = token;
  } else if (command.name === 'tx') {
    try { input = normalize(command.argument, 'hash'); } catch (error) { return text(error.message); }
  } else if (command.argument) return text('Usage: /status (no arguments).');
  if (!head) return text('node busy — the lookup is unavailable. Please try again shortly.');
  try {
    switch (command.name) {
      case 'status':
        return text(`Starknet · ${config.chain}\nHead: ${head.block_number}\n${utc(head.timestamp)}\nL1 gas: ${unsigned(head.l1_gas_price.price_in_fri)} FRI\nL1-data gas: ${unsigned(head.l1_data_gas_price.price_in_fri)} FRI\nL2 gas: ${unsigned(head.l2_gas_price.price_in_fri)} FRI\nRPC spec: ${spec}`);
      case 'balance': {
        let chosen = null;
        if (tokenArgument !== undefined) {
          const resolved = await context.tokens.resolve(tokenArgument, head.timestamp);
          if (resolved.error) return text(resolved.error);
          chosen = resolved.token;
        }
        const block_id = { block_number: head.block_number };
        const lines = [...text(`Balances · ${config.chain} · block ${head.block_number}\n${utc(head.timestamp)}`), link('contract', input)];
        try { await rpc.call('starknet_getClassHashAt', { block_id, contract_address: input }); }
        catch (error) {
          if (error instanceof RpcError && error.code === 20) lines.push(...text('Account not deployed (balances still available).'));
          else if (error instanceof NodeBusy) throw error;
          else if (error instanceof RpcError) lines.push(...text(`Account deployment unavailable (${error.message}).`));
          else throw error;
        }
        const show = async (token, nonZeroOnly = false) => {
          try {
            const value = await balanceOf(rpc, token.address, input, block_id);
            if (!nonZeroOnly || value > 0n) lines.push(`${decimal(value, token.decimals)} ${fmt.token(token)}`);
          } catch (error) {
            if (context.signal.aborted) throw error;
            lines.push(`${fmt.token(token)}: ${escapeHtml(error instanceof NodeBusy ? 'node busy' : error instanceof RpcError ? error.message : 'error: invalid balance response')}. Other tokens are shown independently.`);
          }
        };
        if (chosen) { await show(chosen); return lines; }
        for (const token of config.tokens) await show({ ...token, verified: true });
        // A watched address also lists the other tokens seen moving for it since its watch began.
        const muted = new Set(context.subs?.muted(context.chat?.id) ?? []);
        const extra = (context.subs?.seen(context.chat?.id, input) ?? []).filter((t) => !context.tokens.registry.has(t) && !muted.has(t));
        if (extra.length) {
          lines.push(...text('Also seen moving since this chat began watching it:'));
          const before = lines.length;
          for (const address of extra) {
            const token = await context.tokens.get(address, head.timestamp);
            if (token) await show(token, true);
          }
          if (lines.length === before) lines.pop();
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

/**
 * A pasted value: a transaction the node knows gets the /tx reply and a Track button; otherwise an address
 * gets the /balance reply and a Watch button. Buttons carry a short id; the value waits in CAIRN_DATA for a day.
 */
async function paste(value, context) {
  const { rpc, head, subs, chat } = context;
  if (!head) return () => ({ lines: textLines('node busy — the lookup is unavailable. Please try again shortly.', context.clean) });
  let hash, address = null, known = false;
  try { hash = normalize(value, 'hash'); } catch (error) { return () => ({ lines: textLines(error.message, context.clean) }); }
  try { address = normalize(value, 'address'); } catch { /* only a hash */ }
  try { await rpc.call('starknet_getTransactionStatus', { transaction_hash: hash }); known = true; }
  catch (error) {
    if (context.signal.aborted || !(error instanceof RpcError)) {
      if (error instanceof NodeBusy && !context.signal.aborted) return () => ({ lines: textLines('node busy — the lookup is unavailable. Please try again shortly.', context.clean) });
      throw error;
    }
  }
  if (known || !address) {
    const lines = await answer({ name: 'tx', argument: hash }, context);
    return () => ({ lines, keyboard: [[{ text: '⏱ Track this transaction', callback_data: `ot:${subs.offer(chat, 'track', hash, head.timestamp)}` }]] });
  }
  const lines = await answer({ name: 'balance', argument: address }, context);
  return () => ({ lines, keyboard: [[{ text: '👁 Watch this address', callback_data: `ow:${subs.offer(chat, 'watch', address, head.timestamp)}` }]] });
}

/** Routes a command to its handler and returns its commit, as settings handlers do. */
export async function respond(command, context) {
  if (command.name === 'paste') return paste(command.argument, context);
  if (SETTINGS.has(command.name)) return setting(command, context);
  const lines = await answer(command, context);
  return () => ({ lines });
}
export { callback };
