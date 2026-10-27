export class CairnError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
export class NodeBusy extends CairnError {
  /** `why`: what the last try got (an HTTP status, no answer…), for an operator; never a URL. */
  constructor(why = null) {
    super('node busy: check the RPC origin or retry later.');
    this.why = why;
  }
}
/**
 * A request pinned to one endpoint failed there (round 4): a continuation token is only valid on the endpoint that
 * issued it, so the scanner restarts that range on another endpoint instead.
 */
export class EndpointLost extends NodeBusy {}
/**
 * Telegram could not be reached, answered 5xx or kept answering 429 (round 4): `tick` exits 1 as before, while `run`
 * reports it on /healthz, waits and tries again. A 401 (exit 3) and a 409 (another instance) still stop `run`.
 */
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

/** The RPC URLs of the environment: STARKNET_RPC_URLS (round 4) when set, else STARKNET_RPC_URL. */
export const rpcUrlsOf = (env) => (env.STARKNET_RPC_URLS !== undefined ? env.STARKNET_RPC_URLS.split(',') : [env.STARKNET_RPC_URL])
  .map((url) => String(url ?? '').trim()).filter(Boolean);

/** Every secret the environment holds, as it could appear in a log line: the token and each RPC URL's path and query. */
function secrets(env) {
  const out = [env.TELEGRAM_BOT_TOKEN, env.STARKNET_RPC_URL, env.STARKNET_RPC_URLS];
  if (env.TELEGRAM_BOT_TOKEN) out.push(env.TELEGRAM_BOT_TOKEN.split(':')[1]);
  for (const value of rpcUrlsOf(env)) {
    out.push(value);
    try {
      const rpc = new URL(value);
      out.push(...rpc.pathname.split('/').filter((v) => v.length >= 4), ...rpc.searchParams.values());
    } catch { /* Invalid URL validation errors still redact its complete environment value. */ }
  }
  return out.filter((s) => s && s.length >= 4).sort((a, b) => b.length - a.length);
}

/**
 * One JSON line on standard error: { level, event, ...fields }. Every secret of the environment is removed from
 * each text value, so neither the event nor a field can carry the token or an RPC path.
 */
export function log(level, event, fields = {}) {
  const levels = ['error', 'warn', 'info', 'debug'];
  const configured = levels.indexOf(process.env.CAIRN_LOG ?? 'info');
  if (configured >= 0 && levels.indexOf(level) > configured) return;
  const hidden = secrets(process.env);
  const clean = (value) => {
    if (typeof value !== 'string') return value;
    for (const secret of hidden) value = value.replaceAll(secret, '[redacted]');
    return value;
  };
  const record = { level, event: clean(event) };
  for (const [key, value] of Object.entries(fields)) record[key] = clean(value);
  process.stderr.write(`${JSON.stringify(record)}\n`);
}
