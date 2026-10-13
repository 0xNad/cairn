import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CairnError } from './errors.mjs';
import { normalize } from './felt.mjs';

function bad(reason) { throw new CairnError(reason, 2); }
function url(value, name, originOnly = false) {
  let result;
  try { result = new URL(value); } catch { bad(`${name}: must be an http(s) URL.`); }
  if (!['http:', 'https:'].includes(result.protocol) || result.username || result.password || result.hash) bad(`${name}: invalid http(s) URL.`);
  if (originOnly && (result.pathname !== '/' || result.search)) bad(`${name}: must be an origin without a path or query.`);
  return originOnly ? result.origin : result.href;
}
function integer(env, key, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const raw = env[key] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) bad(`${key}: must be a decimal integer from ${min} to ${max}.`);
  return value;
}
export function loadConfig(args, env = process.env) {
  if (args.length !== 1 || !['run', 'tick', 'doctor'].includes(args[0])) bad('Usage: node cairn.mjs run|tick|doctor (no flags).');
  const token = env.TELEGRAM_BOT_TOKEN;
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) bad('TELEGRAM_BOT_TOKEN: missing or malformed BotFather token.');
  const telegramRoot = url(env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org', 'TELEGRAM_API_ROOT', true);
  const rpcUrl = url(env.STARKNET_RPC_URL, 'STARKNET_RPC_URL');
  const chain = env.CAIRN_CHAIN ?? 'SN_MAIN';
  if (!['SN_MAIN', 'SN_SEPOLIA'].includes(chain)) bad('CAIRN_CHAIN: must be SN_MAIN or SN_SEPOLIA.');
  const explorer = url(env.CAIRN_EXPLORER_URL ?? 'https://voyager.online', 'CAIRN_EXPLORER_URL').replace(/\/$/, '');
  const config = {
    mode: args[0], token, telegramRoot, rpcUrl, chain, explorer,
    data: env.CAIRN_DATA ?? './data',
    pollMs: integer(env, 'CAIRN_POLL_MS', 10000, 50),
    tgTimeout: integer(env, 'CAIRN_TG_TIMEOUT', 30, 0, 50),
    rpcRps: integer(env, 'CAIRN_RPC_RPS', 5, 1, 100),
    rpcTimeout: integer(env, 'CAIRN_RPC_TIMEOUT_MS', 10000, 100),
    logLevel: env.CAIRN_LOG ?? 'info',
  };
  if (!['error', 'warn', 'info', 'debug'].includes(config.logLevel)) bad('CAIRN_LOG: must be error, warn, info or debug.');
  if (!config.data) bad('CAIRN_DATA: must name a data directory.');
  const path = env.CAIRN_NETWORK_FILE ?? fileURLToPath(new URL(`../networks/${chain}.json`, import.meta.url));
  let network;
  try { network = JSON.parse(readFileSync(path, 'utf8')); } catch { bad(`${path}: missing, unreadable or not JSON.`); }
  const entryBad = (at, why) => bad(`${path}: ${at}: ${why}`);
  if (network?.chain !== chain) entryBad('chain', 'must equal CAIRN_CHAIN.');
  if (!Array.isArray(network.tokens) || network.tokens.length < 1 || network.tokens.length > 50) entryBad('tokens', 'must contain 1 to 50 tokens.');
  const symbols = new Set(), addresses = new Set();
  config.tokens = network.tokens.map((t, i) => {
    const at = `tokens[${i}]`;
    if (typeof t?.symbol !== 'string' || !/^[A-Za-z0-9.]{1,11}$/.test(t.symbol)) entryBad(`${at}.symbol`, 'use 1 to 11 letters, digits or dots.');
    if (symbols.has(t.symbol.toLowerCase())) entryBad(`${at}.symbol`, 'duplicate symbol ignoring case.');
    symbols.add(t.symbol.toLowerCase());
    let address;
    try { address = normalize(t.address); } catch { entryBad(`${at}.address`, 'invalid Starknet address.'); }
    if (addresses.has(address)) entryBad(`${at}.address`, 'duplicate normalized address.');
    addresses.add(address);
    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) entryBad(`${at}.decimals`, 'must be an integer from 0 to 36.');
    return { symbol: t.symbol, address, decimals: t.decimals };
  });
  return config;
}
