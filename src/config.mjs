import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export class Failure extends Error {
  constructor(message, exit = 1) { super(message); this.exit = exit; }
}

export function normalize(value, kind = 'address') {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new Error(`Invalid ${kind}: use 0x followed by 1 to 64 hex digits.`);
  }
  const n = BigInt(value);
  const bound = kind === 'address' ? 2n ** 251n - 256n : 2n ** 251n + 17n * 2n ** 192n + 1n;
  if (n === 0n || n >= bound) throw new Error(`Invalid ${kind}: value must be nonzero and below the ${kind === 'address' ? 'address' : 'felt'} limit.`);
  return `0x${n.toString(16).padStart(64, '0')}`;
}

// Discard transport error bodies. Scrub reflected secrets in the few outside fields we do display.
export function redactor(env) {
  const secrets = [env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_BOT_TOKEN?.split(':').slice(1).join(':'), env.STARKNET_RPC_URL];
  try {
    const u = new URL(env.STARKNET_RPC_URL);
    if (u.pathname !== '/') secrets.push(u.pathname, ...u.pathname.split('/').filter(s => s.length >= 6));
    secrets.push(u.username, u.password, ...u.searchParams.values());
  } catch {}
  for (const s of [...secrets]) {
    if (!s) continue;
    try { secrets.push(decodeURIComponent(s), encodeURIComponent(s)); } catch {}
  }
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  return value => values.reduce((s, secret) => s.split(secret).join('[redacted]'), String(value));
}

export function config(env, args) {
  const bad = text => { throw new Failure(text, 2); };
  if (args.length !== 1 || !['run', 'tick', 'doctor'].includes(args[0])) bad('Usage: node cairn.mjs run|tick|doctor (no flags)');
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(env.TELEGRAM_BOT_TOKEN ?? '')) bad('TELEGRAM_BOT_TOKEN: a valid bot token is required');
  const url = (key, fallback, origin = false) => {
    const value = env[key] ?? fallback;
    let u;
    try { u = new URL(value); } catch { bad(`${key}: an http(s) URL is required`); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash || /[\s\\]/.test(value)) bad(`${key}: use an http(s) URL without credentials, whitespace or fragment`);
    if (origin && value !== u.origin) bad(`${key}: use an origin with no path or trailing slash`);
    return value;
  };
  const integer = (key, fallback, min, max = Number.MAX_SAFE_INTEGER) => {
    const s = env[key] ?? String(fallback), n = Number(s);
    if (!/^\d+$/.test(s) || !Number.isSafeInteger(n) || n < min || n > max) bad(`${key}: expected whole decimal digits from ${min} to ${max}`);
    return n;
  };
  const c = {
    command: args[0], token: env.TELEGRAM_BOT_TOKEN,
    telegram: url('TELEGRAM_API_ROOT', 'https://api.telegram.org', true),
    rpc: url('STARKNET_RPC_URL'), explorer: url('CAIRN_EXPLORER_URL', 'https://voyager.online').replace(/\/$/, ''),
    chain: env.CAIRN_CHAIN ?? 'SN_MAIN', data: env.CAIRN_DATA ?? './data',
    pollMs: integer('CAIRN_POLL_MS', 10000, 50), tgTimeout: integer('CAIRN_TG_TIMEOUT', 30, 0, 50),
    rps: integer('CAIRN_RPC_RPS', 5, 1, 100), rpcTimeout: integer('CAIRN_RPC_TIMEOUT_MS', 10000, 100),
    log: env.CAIRN_LOG ?? 'info',
  };
  if (!['SN_MAIN', 'SN_SEPOLIA'].includes(c.chain)) bad('CAIRN_CHAIN: use SN_MAIN or SN_SEPOLIA');
  if (!['error', 'warn', 'info', 'debug'].includes(c.log)) bad('CAIRN_LOG: use error, warn, info or debug');
  if (!c.data || c.data.includes('\0')) bad('CAIRN_DATA: use a nonempty directory path');
  const file = env.CAIRN_NETWORK_FILE ?? fileURLToPath(new URL(`../networks/${c.chain}.json`, import.meta.url));
  let network;
  try { network = JSON.parse(readFileSync(file, 'utf8')); } catch { bad(`${file}: cannot read a JSON network file`); }
  const invalid = (path, reason) => bad(`${file}: ${path}: ${reason}`);
  if (network?.chain !== c.chain) invalid('chain', 'must equal CAIRN_CHAIN');
  if (!Array.isArray(network.tokens) || network.tokens.length < 1 || network.tokens.length > 50) invalid('tokens', 'expected 1 to 50 tokens');
  const symbols = new Set(), addresses = new Set();
  c.tokens = network.tokens.map((t, i) => {
    const at = `tokens[${i}]`;
    if (typeof t?.symbol !== 'string' || !/^[A-Za-z0-9.]{1,11}$/.test(t.symbol)) invalid(`${at}.symbol`, 'expected 1 to 11 letters, digits or dots');
    if (symbols.has(t.symbol.toLowerCase())) invalid(`${at}.symbol`, 'duplicate symbol');
    symbols.add(t.symbol.toLowerCase());
    let address;
    try { address = normalize(t.address); } catch { invalid(`${at}.address`, 'expected a nonzero Starknet address below 2^251 - 256'); }
    if (addresses.has(address)) invalid(`${at}.address`, 'duplicate address');
    addresses.add(address);
    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) invalid(`${at}.decimals`, 'expected an integer from 0 to 36');
    return { symbol: t.symbol, address, decimals: t.decimals };
  });
  return c;
}
