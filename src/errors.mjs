export class CairnError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
export class NodeBusy extends CairnError {
  constructor() { super('node busy: check the RPC origin or retry later.'); }
}
/** Round 4: the one endpoint a paged read was pinned to failed; the read starts again on the next endpoint. */
export class EndpointLost extends NodeBusy {}
/** Round 4: Telegram is unreachable or failing (5xx, retries spent): `run` keeps going and /healthz says so. */
export class TelegramDown extends CairnError {}
/** A request Telegram refused with a 4xx other than 401, 403, 409 and 429: the caller decides what it means. */
export class TelegramRefused extends CairnError {
  constructor(method, code, json) {
    super(`Telegram request ${method} failed (${code}).`);
    this.code = code;
    this.description = typeof json?.description === 'string' ? json.description : '';
    this.parameters = json?.parameters ?? {};
  }
  get migratedTo() { return Number.isSafeInteger(this.parameters.migrate_to_chat_id) ? this.parameters.migrate_to_chat_id : null; }
  get notModified() { return /message is not modified/i.test(this.description); }
}
export class RpcError extends Error {
  constructor(code) {
    super(`RPC error ${Number.isSafeInteger(code) ? code : 'unknown'}`);
    this.code = code;
  }
}
/** One JSON line on stderr, secrets redacted; `fields` adds plain numbers or names, such as the HTTP port. */
export function log(level, event, fields = {}) {
  const levels = ['error', 'warn', 'info', 'debug'];
  const configured = levels.indexOf(process.env.CAIRN_LOG ?? 'info');
  if (configured >= 0 && levels.indexOf(level) > configured) return;
  const secrets = [process.env.TELEGRAM_BOT_TOKEN, process.env.STARKNET_RPC_URL];
  if (process.env.TELEGRAM_BOT_TOKEN) secrets.push(process.env.TELEGRAM_BOT_TOKEN.split(':')[1]);
  const urls = [process.env.STARKNET_RPC_URL, ...(process.env.STARKNET_RPC_URLS ?? '').split(',').map((v) => v.trim())].filter(Boolean);
  secrets.push(process.env.STARKNET_RPC_URLS, ...urls);
  for (const value of urls) {
    try {
      const rpc = new URL(value);
      secrets.push(...rpc.pathname.split('/').filter((v) => v.length >= 4), ...rpc.searchParams.values());
    } catch { /* Invalid URL validation errors still redact its complete environment value. */ }
  }
  for (const secret of secrets) if (secret) event = event.replaceAll(secret, '[redacted]');
  process.stderr.write(`${JSON.stringify({ level, event, ...fields })}\n`);
}
