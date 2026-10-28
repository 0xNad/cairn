import { accessSync, constants, lstatSync, readFileSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CairnError } from './errors.mjs';
import { normalize } from './felt.mjs';
import { parseBlocklist } from './guard.mjs';
import { VENUES } from './venues.mjs';

/** Round 3's optional contracts, each venue's included: each one switches its feature on, a missing one off. */
export const CONTRACTS = Object.freeze(['pragma', 'naming', ...VENUES.map((v) => v.contract)]);
const PAIR = /^[A-Z0-9]{1,10}\/[A-Z0-9]{1,10}$/;

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
function dataDirectory(value) {
  if (!value) bad('CAIRN_DATA: must name a data directory.');
  const path = resolve(value);
  let ancestor = path;
  for (;;) {
    let info;
    try { info = lstatSync(ancestor); }
    catch (error) {
      if (error.code !== 'ENOENT') bad('CAIRN_DATA: directory or parent is unreadable or not a directory.');
      ancestor = dirname(ancestor);
      continue;
    }
    if (ancestor === path && info.isSymbolicLink()) bad('CAIRN_DATA: must be a real directory, not a symbolic link.');
    try {
      if (!statSync(ancestor).isDirectory()) bad('CAIRN_DATA: must name a directory, not a file.');
      accessSync(ancestor, constants.W_OK | constants.X_OK);
    } catch (error) {
      if (error instanceof CairnError) throw error;
      bad('CAIRN_DATA: directory or parent is not writable and searchable.');
    }
    return path;
  }
}
/** Round 4: STARKNET_RPC_URLS, when set, replaces STARKNET_RPC_URL with failover endpoints, in order; at most 8. */
function endpoints(env) {
  if (env.STARKNET_RPC_URLS === undefined) return [url(env.STARKNET_RPC_URL, 'STARKNET_RPC_URL')];
  const parts = env.STARKNET_RPC_URLS.split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) bad('STARKNET_RPC_URLS: list one or more http(s) URLs, separated by commas.');
  const unique = [...new Set(parts.map((part, i) => url(part, `STARKNET_RPC_URLS endpoint ${i + 1}`)))];
  if (unique.length > 8) bad('STARKNET_RPC_URLS: at most 8 endpoints.');
  return unique;
}
function bindHost(value) {
  if (isIP(value) || /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(value)) return value;
  bad('CAIRN_HTTP_HOST: must be an IP address or a host name, such as 127.0.0.1.');
}
function operatorChat(value) {
  if (value === undefined || value === '') return null;
  const id = Number(value);
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(id) || id === 0) bad('CAIRN_OPERATOR_CHAT: must be a Telegram chat id, such as 123456789 or -1001234567890.');
  return id;
}
export function loadConfig(args, env = process.env) {
  if (args.length !== 1 || !['run', 'tick', 'doctor'].includes(args[0])) bad('Usage: node cairn.mjs run|tick|doctor (no flags).');
  const token = env.TELEGRAM_BOT_TOKEN;
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) bad('TELEGRAM_BOT_TOKEN: missing or malformed BotFather token.');
  const telegramRoot = url(env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org', 'TELEGRAM_API_ROOT', true);
  const rpcUrls = endpoints(env), rpcUrl = rpcUrls[0];
  const chain = env.CAIRN_CHAIN ?? 'SN_MAIN';
  if (!['SN_MAIN', 'SN_SEPOLIA'].includes(chain)) bad('CAIRN_CHAIN: must be SN_MAIN or SN_SEPOLIA.');
  const explorer = url(env.CAIRN_EXPLORER_URL ?? 'https://voyager.online', 'CAIRN_EXPLORER_URL').replace(/\/$/, '');
  const config = {
    mode: args[0], token, telegramRoot, rpcUrl, rpcUrls, chain, explorer,
    data: dataDirectory(env.CAIRN_DATA ?? './data'),
    pollMs: integer(env, 'CAIRN_POLL_MS', 10000, 50),
    tgTimeout: integer(env, 'CAIRN_TG_TIMEOUT', 30, 0, 50),
    rpcRps: integer(env, 'CAIRN_RPC_RPS', 5, 1, 100),
    rpcTimeout: integer(env, 'CAIRN_RPC_TIMEOUT_MS', 10000, 100),
    maxBlocks: integer(env, 'CAIRN_MAX_BLOCKS', 500, 1, 10000),
    maxWatches: integer(env, 'CAIRN_MAX_WATCHES', 20, 1, 200),
    priceMaxAge: integer(env, 'CAIRN_PRICE_MAX_AGE', 900, 1, 31_536_000),
    logLevel: env.CAIRN_LOG ?? 'info',
    // Round 4: network alerts, reorgs, confirmations, gaps, the operator, health and the guards.
    stallSeconds: integer(env, 'CAIRN_STALL_SECONDS', 120, 2, 86_400),
    reorgDepth: integer(env, 'CAIRN_REORG_DEPTH', 64, 1, 1000),
    confirmations: integer(env, 'CAIRN_CONFIRMATIONS', 0, 0, 100),
    maxGap: integer(env, 'CAIRN_MAX_GAP', 50_000, 0, 10_000_000), // 0: never skip
    operatorChat: operatorChat(env.CAIRN_OPERATOR_CHAT),
    httpPort: env.CAIRN_HTTP_PORT === undefined || env.CAIRN_HTTP_PORT === '' ? null : integer(env, 'CAIRN_HTTP_PORT', 0, 0, 65_535),
    httpHost: bindHost(env.CAIRN_HTTP_HOST ?? '127.0.0.1'),
  };
  if (!['error', 'warn', 'info', 'debug'].includes(config.logLevel)) bad('CAIRN_LOG: must be error, warn, info or debug.');
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
    const pair = t.pragma_pair ?? null;
    if (pair !== null && (typeof pair !== 'string' || !PAIR.test(pair))) entryBad(`${at}.pragma_pair`, 'use BASE/QUOTE in capitals and digits, such as STRK/USD.');
    return { symbol: t.symbol, address, decimals: t.decimals, pragma_pair: pair };
  });
  const contracts = network.contracts ?? {};
  if (typeof contracts !== 'object' || Array.isArray(contracts)) entryBad('contracts', 'must be an object of contract addresses.');
  config.contracts = {};
  for (const key of CONTRACTS) {
    if (contracts[key] === undefined || contracts[key] === null) continue;
    try { config.contracts[key] = normalize(contracts[key]); } catch { entryBad(`contracts.${key}`, 'invalid Starknet address.'); }
  }
  const list = env.CAIRN_BLOCKLIST ?? fileURLToPath(new URL('../blocklist/domains.txt', import.meta.url));
  let listed;
  try { listed = readFileSync(list, 'utf8'); } catch { bad(`CAIRN_BLOCKLIST: ${list} is missing or unreadable.`); }
  const parsed = parseBlocklist(listed);
  if (parsed.error) bad(`CAIRN_BLOCKLIST: ${parsed.error}`);
  config.blocklist = parsed.domains;
  return config;
}
