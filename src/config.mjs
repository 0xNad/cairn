import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CairnError } from './errors.mjs';
import { normalize } from './format.mjs';

export function loadConfig(env = process.env) {
  const bad = (name, why) => { throw new CairnError(`${name}: ${why}`, 2); };
  const number = (name, fallback, min, max = Number.MAX_SAFE_INTEGER) => {
    const s = env[name] ?? String(fallback);
    if (!/^\d+$/.test(s) || !Number.isSafeInteger(Number(s)) || Number(s) < min || Number(s) > max) bad(name, `must be an integer from ${min} to ${max}`);
    return Number(s);
  };
  const url = (name, fallback, origin = false) => {
    const s = env[name] ?? fallback;
    let u;
    try { u = new URL(s); } catch { bad(name, 'must be an http(s) URL'); }
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.hash || (origin && (u.pathname !== '/' || u.search))) bad(name, origin ? 'must be an http(s) origin without a path' : 'must be an http(s) URL without user information or a fragment');
    return origin ? u.origin : u.href;
  };
  const token = env.TELEGRAM_BOT_TOKEN;
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) bad('TELEGRAM_BOT_TOKEN', 'required; use the BotFather token format');
  const tgRoot = url('TELEGRAM_API_ROOT', 'https://api.telegram.org', true);
  const rpcUrl = url('STARKNET_RPC_URL');
  const explorer = url('CAIRN_EXPLORER_URL', 'https://voyager.online').replace(/\/$/, '');
  const chain = env.CAIRN_CHAIN ?? 'SN_MAIN';
  if (!['SN_MAIN', 'SN_SEPOLIA'].includes(chain)) bad('CAIRN_CHAIN', 'must be SN_MAIN or SN_SEPOLIA');
  const log = env.CAIRN_LOG ?? 'info';
  if (!['error', 'warn', 'info', 'debug'].includes(log)) bad('CAIRN_LOG', 'must be error, warn, info or debug');
  const pollMs = number('CAIRN_POLL_MS', 10000, 50);
  const tgTimeout = number('CAIRN_TG_TIMEOUT', 30, 0, 50);
  const rpcRps = number('CAIRN_RPC_RPS', 5, 1, 100);
  const rpcTimeout = number('CAIRN_RPC_TIMEOUT_MS', 10000, 100);
  const networkFile = env.CAIRN_NETWORK_FILE ?? fileURLToPath(new URL(`../networks/${chain}.json`, import.meta.url));
  let network;
  try { network = JSON.parse(readFileSync(networkFile, 'utf8')); }
  catch { bad(networkFile, 'file is unreadable or not valid JSON'); }
  const invalid = (path, why) => bad(networkFile, `${path}: ${why}`);
  if (network?.chain !== chain) invalid('chain', 'must equal CAIRN_CHAIN');
  if (!Array.isArray(network.tokens) || network.tokens.length < 1 || network.tokens.length > 50) invalid('tokens', 'must contain 1 to 50 entries');
  const symbols = new Set(), addresses = new Set();
  const tokens = network.tokens.map((t, i) => {
    const p = `tokens[${i}]`;
    if (typeof t?.symbol !== 'string' || !/^[A-Za-z0-9.]{1,11}$/.test(t.symbol)) invalid(`${p}.symbol`, 'must be 1 to 11 letters, digits or dots');
    if (symbols.has(t.symbol.toLowerCase())) invalid(`${p}.symbol`, 'duplicate symbol');
    symbols.add(t.symbol.toLowerCase());
    let address;
    try { address = normalize(t.address); } catch { invalid(`${p}.address`, 'must be a valid nonzero Starknet address'); }
    if (addresses.has(address)) invalid(`${p}.address`, 'duplicate address');
    addresses.add(address);
    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) invalid(`${p}.decimals`, 'must be an integer from 0 to 36');
    return { symbol: t.symbol, address, decimals: t.decimals };
  });
  const rpc = new URL(rpcUrl);
  const secrets = [token, token.split(':')[1], rpcUrl, rpc.pathname === '/' ? '' : rpc.pathname,
    ...rpc.pathname.split('/').filter((s) => s.length >= 8), ...rpc.searchParams.values()].filter(Boolean).sort((a, b) => b.length - a.length);
  const redact = (s) => secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), String(s));
  return { token, tgRoot, rpcUrl, explorer, chain, log, pollMs, tgTimeout, rpcRps, rpcTimeout, tokens, data: resolve(env.CAIRN_DATA ?? './data'), redact };
}
