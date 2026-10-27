import { NodeBusy, RpcError } from './errors.mjs';
import { normalize, unsigned } from './felt.mjs';
import { amount, decimal, escapeHtml, links, plainText, short, textLines, utc } from './format.mjs';
import { looksLikeName } from './names.mjs';
import { ageOf, usdPair } from './prices.mjs';
import { callback, setting, SETTINGS } from './settings.mjs';
import { balanceOf } from './tokens.mjs';

export const COMMANDS = Object.freeze([
  { command: 'network', description: 'Enable or disable chain alerts' },
  { command: 'guard', description: 'Configure seed and link protection' },
  { command: 'start', description: 'Welcome and privacy' },
  { command: 'help', description: 'Commands and privacy' },
  { command: 'status', description: 'Chain head and gas prices' },
  { command: 'balance', description: 'Exact token balances for an address' },
  { command: 'tx', description: 'Transaction status, fee and revert reason' },
  { command: 'price', description: 'Pragma oracle prices, their age and sources' },
  { command: 'feed', description: 'Post a token\'s trades on Ekubo and AVNU' },
  { command: 'unfeed', description: 'Stop the trade feed' },
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
/** In a private chat, a pasted address, name.stark or transaction hash is looked up as if it were a command. */
export function parsePaste(message) {
  if (message?.chat?.type !== 'private') return null;
  const match = /^\s*(0x[0-9a-fA-F]{1,64}|[a-z0-9-]+\.stark)\s*$/.exec(message.text ?? '');
  return match ? { name: 'paste', argument: match[1] } : null;
}

const HELP = `Cairn · Starknet lookups, wallet alerts and trade feeds
Lookups, for everyone:
/status — Chain head and gas prices
/balance <address> [token] — Exact balances, one token or every verified one
/tx <hash> — Status, fee and revert reason
/price [SYMBOL…] — Pragma oracle prices, with their age and sources
In a private chat, paste an address, a name.stark or a transaction hash to look it up.
Feeds and alerts, set by group administrators (anyone in a private chat):
/feed <token> [min|$usd] [buys|all] — Every buy of a token on Ekubo and AVNU (all: sells too), with its USD value and trader
/network on|off — Chain stall and recovery alerts
/guard seed|links on|off — Message protection (on by default)
/unfeed — Stop this chat's feed
/watch <address> [label] — Every transfer in or out, on any token, and every approval
/unwatch <address|label> — Stop watching
/whale <token> <amount> — Every transfer of a token at or above an amount
/unwhale <token> — Stop a whale alert
/min <token> <amount> — Skip watch alerts below an amount (0 removes it)
/mute <token address> — Silence one token in this chat, such as a spam airdrop
/unmute <token address> — Undo /mute
/track <hash> — One message on L2 acceptance, one on L1 acceptance or a revert
This chat:
/list — Its feed, watches, alerts, floors and mutes, with Remove buttons
/export — Everything Cairn stores for it, as JSON
/forget — Delete all of it
/start — Welcome and privacy
/help — Command guide

A name.stark works wherever an address does, and an address shows as its .stark name only when that name resolves back to it. Set up in a forum topic, a feed, watch or whale posts into that topic. A group gets at most 3 alert messages per update: when more are due, the third summarises the rest.

On-chain facts, not financial advice.
Public balances and transfers only.
Tokens outside Cairn's registry are marked unverified: anyone can deploy a token with any symbol, and none gets a USD value.
The operator stores this chat's id and type, its settings (trade feed, watched addresses and labels, whale alerts, floors, mutes, tracked transactions, and the forum topic of each), the tokens seen moving for a watched address, alert delivery records for 7 days, a pasted address or hash for a day (for its button), and the update offset. Shared by every chat: token metadata and .stark names read from the chain. /export shows all of it; /forget deletes it. For the rate limit, each person's id and command times are kept for one minute. Never message text, Telegram names or usernames.`;
const GROUP_SETUP = `Cairn is in this group. To set it up, as an administrator:
1. /feed <token> [min|$usd] [buys|all] to post the group token's trades.
2. /watch <address> <label> for each wallet the group follows.
3. /whale <token> <amount> for large transfers of a token.
4. /min and /mute to cut noise.
Run each in a forum topic to post there. Members can use /status, /balance, /tx, /price and /list. Cairn reads only the commands addressed to it.`;

export async function answer(command, context) {
  const { config, rpc, username, clean, head, spec } = context;
  const text = (value) => textLines(value, clean);
  const fmt = context.fmt ?? links(config, clean);
  const link = (kind, value) => fmt.link(kind, value);
  if (command.name === 'start' || command.name === 'help') {
    if (command.name === 'start' && command.argument === 'setup' && context.chat && context.chat.type !== 'private') return text(GROUP_SETUP);
    return [...text(HELP), `<a href="https://t.me/${escapeHtml(clean(username))}?startgroup=setup">Add Cairn to a group</a>`];
  }
  if (command.name === 'price') return price(command.argument, context);
  if (!['status', 'balance', 'tx'].includes(command.name)) return text('Unknown command. Use /help for available commands.');
  let input, tokenArgument, name = null;
  if (command.name === 'balance') {
    const [address = '', token, ...extra] = command.argument.split(/\s+/).filter(Boolean);
    if (looksLikeName(address)) name = address;
    else try { input = normalize(address, 'address'); } catch (error) { return text(error.message); }
    if (extra.length) return text('Usage: /balance <address|name.stark> [SYMBOL|token address].');
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
        if (name !== null) {
          const resolved = context.names ? await context.names.resolve(name) : { error: 'Names are off here: use the 0x address.' };
          if (resolved.error) return text(resolved.error);
          ({ address: input, name } = resolved);
        }
        let chosen = null;
        if (tokenArgument !== undefined) {
          const resolved = await context.tokens.resolve(tokenArgument, head.timestamp, context.names);
          if (resolved.error) return text(resolved.error);
          chosen = resolved.token;
        }
        const block_id = { block_number: head.block_number };
        name ??= await context.names?.display(input, head.timestamp) ?? null;
        const who = name === null ? link('contract', input) : fmt.contract(input, `${escapeHtml(name)} · ${short(input)}`);
        const lines = [...text(`Balances · ${config.chain} · block ${head.block_number}\n${utc(head.timestamp)}`), who];
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
            let token;
            try { token = await context.tokens.get(address, head.timestamp); }
            catch (error) {
              if (context.signal.aborted || !(error instanceof NodeBusy)) throw error;
              lines.push(`${fmt.contract(address)}: node busy. Other tokens are shown independently.`);
              continue;
            }
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

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * /price [SYMBOL…]: Pragma's median for each verified token's pair at the head block, scaled by the decimals it
 * returns, with its age in chain time and its number of sources; older than CAIRN_PRICE_MAX_AGE is stale.
 * Each pair is read on its own, so one that fails hides no other. Without symbols, every token with a pair.
 */
async function price(argument, context) {
  const { config, head, prices, tokens } = context;
  const text = (value) => textLines(value, context.clean);
  if (!prices?.enabled) return text('Prices are off on this instance: its network file has no contracts.pragma, so Cairn reads no prices and shows no USD values.');
  const asked = argument.split(/[\s,]+/).filter(Boolean);
  if (asked.length > 20) return text('Usage: /price [SYMBOL…], at most 20 symbols, such as /price STRK ETH.');
  if (!head) return text('node busy — the lookup is unavailable. Please try again shortly.');
  const once = (list) => list.filter((s, i) => list.findIndex((t) => t.toLowerCase() === s.toLowerCase()) === i);
  const wanted = asked.length ? once(asked) : config.tokens.filter((t) => t.pragma_pair).map((t) => t.symbol);
  if (!wanted.length) return text('No token in this network file has a pragma_pair, so there is no price to show.');
  const lines = [`<b>Pragma prices</b> · block ${head.block_number} · ${utc(head.timestamp)}`];
  for (const symbol of wanted) {
    const token = tokens.bySymbol(symbol);
    if (!token) {
      lines.push(`${escapeHtml(plainText(symbol, 20))}: not a verified token here, so Cairn shows no price for it. Verified: ${config.tokens.map((t) => escapeHtml(t.symbol)).join(', ')}.`);
      continue;
    }
    const pair = token.pragma_pair, name = escapeHtml(token.symbol);
    if (!pair) { lines.push(`${name}: no Pragma pair in this network file, so no price.`); continue; }
    const label = pair.split('/')[0] === token.symbol.toUpperCase() ? pair : `${name} (${pair})`;
    let sample;
    try { sample = await prices.sample(pair, head.block_number); }
    catch (error) {
      if (context.signal.aborted || !(error instanceof NodeBusy)) throw error;
      lines.push(`${label}: node busy, so the price is unavailable for now. Try again shortly.`);
      continue;
    }
    if (sample.missing) { lines.push(`${label}: no price (Pragma answers 0 for this pair).`); continue; }
    if (sample.error) { lines.push(`${label}: unavailable (Pragma ${escapeHtml(sample.error)}).`); continue; }
    const age = ageOf(sample, head.timestamp), stale = age > prices.maxAge, value = decimal(sample.price, sample.decimals);
    const shown = usdPair(pair) ? `$${value}` : `${value} ${pair.split('/')[1]}`;
    lines.push(`${stale ? '⚠️' : '•'} <b>${label}</b> ${shown} · ${stale ? 'stale, ' : ''}updated ${age} s ago · ${plural(sample.sources, 'source')}`);
  }
  lines.push(`Alerts show USD values only from prices updated within ${prices.maxAge} s of chain time.`);
  return lines;
}

/**
 * A pasted value: a transaction the node knows gets the /tx reply and a Track button; otherwise an address, or
 * a name.stark, gets the /balance reply and a Watch button. Buttons carry a short id; the value waits in
 * CAIRN_DATA for a day.
 */
async function paste(value, context) {
  const { rpc, head, subs, chat } = context;
  if (!head) return () => ({ lines: textLines('node busy — the lookup is unavailable. Please try again shortly.', context.clean) });
  if (looksLikeName(value)) {
    let r;
    try { r = context.names ? await context.names.resolve(value) : { error: 'Names are off here: paste the 0x address.' }; }
    catch (error) {
      if (context.signal.aborted || !(error instanceof NodeBusy)) throw error;
      r = { error: 'node busy — the lookup is unavailable. Please try again shortly.' };
    }
    if (r.error) return () => ({ lines: textLines(r.error, context.clean) });
    const lines = [`<b>${escapeHtml(r.name)}</b>`, ...await answer({ name: 'balance', argument: r.address }, context)];
    return () => ({ lines, keyboard: [[{ text: '👁 Watch this address', callback_data: `ow:${subs.offer(chat, 'watch', r.address, head.timestamp)}` }]] });
  }
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
