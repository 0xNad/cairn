export class CairnError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
export class NodeBusy extends CairnError {
  constructor() { super('node busy: check the RPC origin or retry later.'); }
}
export class Migration extends CairnError {
  constructor(chatId) { super('Telegram chat migrated.'); this.chatId = chatId; }
}
export class RpcError extends Error {
  constructor(code) {
    super(`RPC error ${Number.isSafeInteger(code) ? code : 'unknown'}`);
    this.code = code;
  }
}
export function log(level, event) {
  const levels = ['error', 'warn', 'info', 'debug'];
  const configured = levels.indexOf(process.env.CAIRN_LOG ?? 'info');
  if (configured >= 0 && levels.indexOf(level) > configured) return;
  const secrets = [process.env.TELEGRAM_BOT_TOKEN, process.env.STARKNET_RPC_URL];
  if (process.env.TELEGRAM_BOT_TOKEN) secrets.push(process.env.TELEGRAM_BOT_TOKEN.split(':')[1]);
  try {
    const rpc = new URL(process.env.STARKNET_RPC_URL);
    secrets.push(...rpc.pathname.split('/').filter((v) => v.length >= 4), ...rpc.searchParams.values());
  } catch { /* Invalid URL validation errors still redact its complete environment value. */ }
  for (const secret of secrets) if (secret) event = event.replaceAll(secret, '[redacted]');
  process.stderr.write(`${JSON.stringify({ level, event })}\n`);
}
