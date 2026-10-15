import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { CairnError } from './errors.mjs';

const ADDRESS_LIMIT = 2n ** 251n - 256n;
const FIELD_LIMIT = 2n ** 251n + 17n * 2n ** 192n + 1n;

export function normalize(value, type = 'address') {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{1,64}$/i.test(value)) {
    throw new CairnError(`Invalid ${type}: use 0x followed by 1 to 64 hexadecimal digits.`, 2);
  }
  const n = BigInt(value);
  if (n <= 0n || n >= (type === 'address' ? ADDRESS_LIMIT : FIELD_LIMIT)) {
    throw new CairnError(`Invalid ${type}: the value is zero or outside Starknet's range.`, 2);
  }
  return '0x' + n.toString(16).padStart(64, '0');
}

function url(value, name, originOnly = false) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new CairnError(`${name}: provide an absolute http(s) URL.`, 2); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new CairnError(`${name}: provide an http(s) URL without credentials or a fragment.`, 2);
  }
  if (originOnly && (parsed.pathname !== '/' || parsed.search)) {
    throw new CairnError(`${name}: provide an origin without a path or query.`, 2);
  }
  return originOnly ? parsed.origin : parsed.href;
}

function integer(env, name, fallback, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const text = env[name] ?? String(fallback);
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CairnError(`${name}: use a whole decimal number from ${minimum} to ${maximum}.`, 2);
  }
  return value;
}

function registry(file, chain) {
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new CairnError(`${file}: file is missing, unreadable or not valid JSON.`, 2); }
  const bad = (path, reason) => { throw new CairnError(`${file}: ${path}: ${reason}`, 2); };
  if (data?.chain !== chain) bad('chain', 'must equal CAIRN_CHAIN.');
  if (!Array.isArray(data.tokens) || data.tokens.length < 1 || data.tokens.length > 50) {
    bad('tokens', 'list between 1 and 50 tokens.');
  }
  const symbols = new Set(), addresses = new Set();
  return data.tokens.map((token, i) => {
    const path = `tokens[${i}]`;
    if (typeof token?.symbol !== 'string' || !/^[A-Za-z0-9.]{1,11}$/.test(token.symbol)) {
      bad(`${path}.symbol`, 'use 1 to 11 letters, digits or dots.');
    }
    const symbol = token.symbol.toLowerCase();
    if (symbols.has(symbol)) bad(`${path}.symbol`, 'symbol is repeated, ignoring case.');
    symbols.add(symbol);
    let address;
    try { address = normalize(token.address); } catch { bad(`${path}.address`, 'use a nonzero Starknet address within range.'); }
    if (addresses.has(address)) bad(`${path}.address`, 'address is repeated after normalization.');
    addresses.add(address);
    if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36) {
      bad(`${path}.decimals`, 'use an integer from 0 to 36.');
    }
    return { symbol: token.symbol, address, decimals: token.decimals };
  });
}

function redactor(token, rpc) {
  const parsed = new URL(rpc);
  const values = new Set([token, token.split(':')[1], rpc, ...parsed.searchParams.values()]);
  // Provider keys may be embedded in arbitrary path segments. Remove those from outside text as well.
  for (const segment of parsed.pathname.split('/')) if (segment.length >= 8) {
    values.add(segment);
    try { values.add(decodeURIComponent(segment)); } catch {}
  }
  const secrets = [...values].filter(Boolean).sort((a, b) => b.length - a.length);
  return (input) => {
    let text = String(input);
    for (const secret of secrets) text = text.split(secret).join('[redacted]');
    return text;
  };
}

export function configure(args, env) {
  if (args.length !== 1 || !['run', 'tick', 'doctor'].includes(args[0])) {
    throw new CairnError('Usage: node cairn.mjs run|tick|doctor. Configure Cairn through the environment.', 2);
  }
  const token = env.TELEGRAM_BOT_TOKEN;
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) {
    throw new CairnError('TELEGRAM_BOT_TOKEN: provide the bot token from BotFather.', 2);
  }
  const rpc = url(env.STARKNET_RPC_URL, 'STARKNET_RPC_URL');
  const api = url(env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org', 'TELEGRAM_API_ROOT', true);
  const chain = env.CAIRN_CHAIN ?? 'SN_MAIN';
  if (!['SN_MAIN', 'SN_SEPOLIA'].includes(chain)) throw new CairnError('CAIRN_CHAIN: use SN_MAIN or SN_SEPOLIA.', 2);
  const explorer = url(env.CAIRN_EXPLORER_URL ?? 'https://voyager.online', 'CAIRN_EXPLORER_URL').replace(/\/$/, '');
  const networkFile = env.CAIRN_NETWORK_FILE ?? fileURLToPath(new URL(`../networks/${chain}.json`, import.meta.url));
  const data = env.CAIRN_DATA ?? './data';
  if (!data || data.includes('\0')) throw new CairnError('CAIRN_DATA: provide a directory path.', 2);
  const logLevel = env.CAIRN_LOG ?? 'info';
  if (!['error', 'warn', 'info', 'debug'].includes(logLevel)) throw new CairnError('CAIRN_LOG: use error, warn, info or debug.', 2);
  const clean = redactor(token, rpc);
  return {
    mode: args[0], token, rpc, api, chain, explorer, networkFile, data: resolve(data), clean, logLevel,
    tokens: registry(networkFile, chain),
    pollMs: integer(env, 'CAIRN_POLL_MS', 10000, 50),
    tgTimeout: integer(env, 'CAIRN_TG_TIMEOUT', 30, 0, 50),
    rpcRps: integer(env, 'CAIRN_RPC_RPS', 5, 1, 100),
    rpcTimeout: integer(env, 'CAIRN_RPC_TIMEOUT_MS', 10000, 100),
  };
}
