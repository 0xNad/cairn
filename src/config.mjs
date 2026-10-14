import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeFelt } from './felt.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function httpUrl(value, name, originOnly = false) {
  let u;
  try { u = new URL(value); } catch { throw new Error(`${name}: invalid URL`); }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password || (originOnly && (u.href !== u.origin + '/' || value.endsWith('/')))) {
    throw new Error(`${name}: expected ${originOnly ? 'an HTTP(S) origin without a path' : 'an HTTP(S) URL'}`);
  }
  return originOnly ? u.origin : value;
}
function integer(value, name, min, max = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new Error(`${name}: expected a whole number from ${min} to ${max}`);
  return Number(value);
}
export function config(env = process.env) {
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(env.TELEGRAM_BOT_TOKEN ?? '')) throw new Error('TELEGRAM_BOT_TOKEN: invalid or missing');
  const telegramRoot = httpUrl(env.TELEGRAM_API_ROOT ?? 'https://api.telegram.org', 'TELEGRAM_API_ROOT', true);
  const rpcUrl = httpUrl(env.STARKNET_RPC_URL ?? '', 'STARKNET_RPC_URL');
  const chain = env.CAIRN_CHAIN ?? 'SN_MAIN';
  if (!['SN_MAIN', 'SN_SEPOLIA'].includes(chain)) throw new Error('CAIRN_CHAIN: invalid');
  const networkFile = env.CAIRN_NETWORK_FILE ?? join(root, 'networks', `${chain}.json`);
  const data = env.CAIRN_DATA ?? './data';
  const explorer = httpUrl(env.CAIRN_EXPLORER_URL ?? 'https://voyager.online', 'CAIRN_EXPLORER_URL').replace(/\/$/, '');
  const pollMs = integer(env.CAIRN_POLL_MS ?? '10000', 'CAIRN_POLL_MS', 50);
  const tgTimeout = integer(env.CAIRN_TG_TIMEOUT ?? '30', 'CAIRN_TG_TIMEOUT', 0, 50);
  const rps = integer(env.CAIRN_RPC_RPS ?? '5', 'CAIRN_RPC_RPS', 1, 100);
  const rpcTimeoutMs = integer(env.CAIRN_RPC_TIMEOUT_MS ?? '10000', 'CAIRN_RPC_TIMEOUT_MS', 100);
  const log = env.CAIRN_LOG ?? 'info';
  if (!['error', 'warn', 'info', 'debug'].includes(log)) throw new Error('CAIRN_LOG: invalid');
  let registry;
  try { registry = JSON.parse(readFileSync(networkFile, 'utf8')); }
  catch { throw new Error(`${networkFile}: missing, unreadable or invalid JSON`); }
  const bad = (path, reason) => { throw new Error(`${networkFile}: ${path}: ${reason}`); };
  if (!registry || registry.chain !== chain) bad('chain', `expected ${chain}`);
  if (!Array.isArray(registry.tokens) || registry.tokens.length < 1 || registry.tokens.length > 50) bad('tokens', 'expected 1 to 50 tokens');
  const symbols = new Set(), addresses = new Set();
  registry.tokens.forEach((t, i) => {
    if (!t || typeof t.symbol !== 'string' || !/^[A-Za-z0-9.]{1,11}$/.test(t.symbol) || symbols.has(t.symbol.toLowerCase())) bad(`tokens[${i}].symbol`, 'invalid or duplicate symbol');
    symbols.add(t.symbol.toLowerCase());
    try { t.address = normalizeFelt(t.address, 'address'); }
    catch { bad(`tokens[${i}].address`, 'invalid address'); }
    if (addresses.has(t.address)) bad(`tokens[${i}].address`, 'duplicate address');
    addresses.add(t.address);
    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) bad(`tokens[${i}].decimals`, 'expected an integer from 0 to 36');
  });
  return { token: env.TELEGRAM_BOT_TOKEN, telegramRoot, rpcUrl, chain, networkFile, data, explorer, pollMs, tgTimeout, rps, rpcTimeoutMs, log, tokens: registry.tokens };
}
