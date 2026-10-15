import { CairnError, RpcError } from './errors.mjs';
import { amount, escapeHtml as html, messages, normalize, short, textLines, u256, uint, utc } from './format.mjs';

export const COMMANDS = [
  { command: 'start', description: 'Welcome, privacy and group setup' },
  { command: 'help', description: 'Commands and lookup examples' },
  { command: 'status', description: 'Chain head, UTC time and gas prices' },
  { command: 'balance', description: 'Public token balances: /balance 0x…' },
  { command: 'tx', description: 'Transaction finality and fee: /tx 0x…' }
];
const SELECTORS = {
  balance_of: '0x035a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33',
  balanceOf: '0x02e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e'
};

export class Commands {
  constructor(config, rpc, username) { this.config = config; this.rpc = rpc; this.username = username; }

  link(kind, value) {
    return `<a href="${html(this.config.explorer + '/' + kind + '/' + value)}">${html(short(value))}</a>`;
  }

  welcome() {
    return [
      '<b>Cairn · Starknet lookups</b>',
      '/start — Welcome and group setup', '/help — Commands and privacy',
      '/status — Chain head, time and gas', '/balance &lt;address&gt; — Token balances', '/tx &lt;hash&gt; — Transaction status and fee',
      '', 'On-chain facts, not financial advice.', 'Public balances and transfers only.',
      'The operator stores the update offset and registered command list. Message text, names, usernames and secrets are never stored.',
      `<a href="https://t.me/${html(this.username)}?startgroup=setup">Add Cairn to a group</a>`,
      'In groups: use /status or /status@' + html(this.username) + '. No wallet connection is needed.'
    ];
  }

  async reply(message, head) {
    if (typeof message?.text !== 'string' || message.from?.is_bot) return [];
    const match = /^\/(\w+)(?:@(\w+))?(?=\s|$)/.exec(message.text);
    if (!match || (match[2] && match[2].toLowerCase() !== this.username.toLowerCase())) return [];
    const cmd = match[1].toLowerCase();
    const args = message.text.slice(match[0].length).trim().split(/\s+/).filter(Boolean);
    if (cmd === 'help' || cmd === 'start') return messages(this.welcome());
    if (!['status', 'balance', 'tx'].includes(cmd)) return ['Unknown command. Use /help to see the commands.'];
    let value;
    if (cmd === 'balance' || cmd === 'tx') {
      try {
        if (args.length !== 1) throw new Error(`Use /${cmd} with one ${cmd === 'balance' ? 'address' : 'transaction hash'}.`);
        value = normalize(args[0], cmd === 'balance' ? 'address' : 'hash');
      } catch (e) { return [html(e.message)]; }
    } else if (args.length) return ['Use /status without arguments. See /help.'];
    if (!head) return ['Node busy — try again shortly.'];
    try {
      if (cmd === 'status') return messages(this.status(head));
      if (cmd === 'balance') return messages(await this.balance(value, head));
      return messages(await this.transaction(value));
    } catch (e) {
      if (e instanceof CairnError && e.exitCode === 2) throw e;
      return ['Node busy — try again shortly.'];
    }
  }

  status(head) {
    return ['<b>Starknet status</b>', `${html(this.config.chain)} · Block ${head.block_number}`,
      utc(head.timestamp), `L1 gas: ${amount(uint(head.l1_gas_price.price_in_fri), 0)} FRI`,
      `L1 data gas: ${amount(uint(head.l1_data_gas_price.price_in_fri), 0)} FRI`,
      `L2 gas: ${amount(uint(head.l2_gas_price.price_in_fri), 0)} FRI`, `RPC spec: ${html(this.rpc.spec)}`];
  }

  async balance(address, head) {
    const block_id = { block_number: head.block_number };
    const lines = ['<b>Public balances</b>', this.link('contract', address), `Block ${head.block_number}`];
    try { await this.rpc.call('starknet_getClassHashAt', { contract_address: address, block_id }); }
    catch (e) {
      if (e instanceof RpcError && e.code === 20) lines.push('Account not deployed; token balances can still exist.');
      else lines.push('Account deployment check unavailable.');
    }
    for (const token of this.config.tokens) {
      const request = { contract_address: token.address, entry_point_selector: SELECTORS.balance_of, calldata: [address] };
      try {
        let result;
        try { result = await this.rpc.call('starknet_call', { request, block_id }); }
        catch (e) {
          if (!(e instanceof RpcError) || e.code !== 21) throw e;
          result = await this.rpc.call('starknet_call', { request: { ...request, entry_point_selector: SELECTORS.balanceOf }, block_id });
        }
        lines.push(`${amount(u256(result), token.decimals)} ${html(token.symbol)}`);
      } catch (e) {
        lines.push(`${html(token.symbol)}: ${e instanceof RpcError ? `error (RPC ${e.code})` : 'node busy; balance unavailable'}`);
      }
    }
    return lines;
  }

  async transaction(hash) {
    let status, receipt;
    try {
      status = await this.rpc.call('starknet_getTransactionStatus', { transaction_hash: hash });
      receipt = await this.rpc.call('starknet_getTransactionReceipt', { transaction_hash: hash });
    } catch (e) {
      if (e instanceof RpcError && e.code === 29) return ['Transaction not found.', this.link('tx', hash)];
      throw e;
    }
    const lines = ['<b>Transaction</b>', this.link('tx', hash),
      `Finality: ${html(status.finality_status ?? receipt.finality_status ?? 'Unavailable')}`,
      `Execution: ${html(status.execution_status ?? receipt.execution_status ?? 'Not executed yet')}`,
      `Block: ${Number.isSafeInteger(receipt.block_number) ? receipt.block_number : 'Not included yet'}`];
    if (receipt.actual_fee?.unit === 'FRI') lines.push(`Fee: ${amount(uint(receipt.actual_fee.amount), 18)} STRK`);
    else lines.push('Fee in STRK: unavailable (node did not report FRI).');
    if (receipt.revert_reason || status.failure_reason) {
      lines.push('Revert reason:', ...textLines(this.config.redact(receipt.revert_reason ?? status.failure_reason)));
    }
    return lines;
  }
}
