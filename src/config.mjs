// The command line, the environment and the network file, all validated before any network call. Every
// refusal is a ConfigError (exit 2) whose message names what to fix and never repeats a secret.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAddress } from "./felt.mjs";
import { LEVELS } from "./log.mjs";

export class ConfigError extends Error {}

export const COMMANDS = ["run", "tick", "doctor"];
export const CHAINS = ["SN_MAIN", "SN_SEPOLIA"];
/** The repository's root, where cairn.mjs and networks/ live. */
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const TOKEN = /^\d+:[A-Za-z0-9_-]{30,}$/;
const SYMBOL = /^[A-Za-z0-9.]{1,11}$/;
const clip = (s, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A whole number in decimal digits within [min, max], or the default when unset. */
function integer(env, name, fallback, min, max = Infinity) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a whole number in decimal digits, got "${clip(raw)}"`);
  const v = Number(raw);
  if (v < min || v > max) throw new ConfigError(`${name} must be ${max === Infinity ? `at least ${min}` : `from ${min} to ${max}`}, got ${clip(raw)}`);
  return v;
}

/** An http(s) URL. `secret` keeps the value out of the message. */
function httpUrl(name, raw, { secret = false } = {}) {
  const shown = secret ? "" : ` (got "${clip(raw)}")`;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a URL${shown}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ConfigError(`${name} must be an http or https URL${shown}`);
  return u;
}

/**
 * Reads the configuration: `argv` (the arguments after `cairn.mjs`) and `env`. Throws ConfigError.
 * `secrets` lists every string that must never be written anywhere (see log.mjs).
 */
export function loadConfig(argv, env) {
  if (argv.length !== 1 || !COMMANDS.includes(argv[0])) {
    const got = argv.length ? `got "${clip(argv.join(" "))}"` : "got no command";
    throw new ConfigError(`usage: node cairn.mjs run|tick|doctor (one command, no flags: configuration comes from the environment); ${got}`);
  }
  const command = argv[0];

  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new ConfigError("TELEGRAM_BOT_TOKEN is not set: ask @BotFather for a token");
  if (!TOKEN.test(token)) throw new ConfigError("TELEGRAM_BOT_TOKEN is malformed: it should look like 123456:ABC… (digits, a colon, then at least 30 letters, digits, _ or -)");

  const apiRootRaw = env.TELEGRAM_API_ROOT || "https://api.telegram.org";
  const apiRoot = httpUrl("TELEGRAM_API_ROOT", apiRootRaw);
  if (apiRoot.pathname !== "/" || apiRoot.search || apiRoot.hash || apiRoot.username || apiRoot.password) {
    throw new ConfigError(`TELEGRAM_API_ROOT must be an origin with no path, such as https://api.telegram.org (got "${clip(apiRootRaw)}")`);
  }

  const rpcRaw = env.STARKNET_RPC_URL;
  if (!rpcRaw) throw new ConfigError("STARKNET_RPC_URL is not set: give the URL of a Starknet JSON-RPC 0.10 node");
  const rpc = httpUrl("STARKNET_RPC_URL", rpcRaw, { secret: true });

  const chain = env.CAIRN_CHAIN || "SN_MAIN";
  if (!CHAINS.includes(chain)) throw new ConfigError(`CAIRN_CHAIN must be SN_MAIN or SN_SEPOLIA, got "${clip(chain)}"`);

  const explorerRaw = env.CAIRN_EXPLORER_URL || "https://voyager.online";
  const explorerUrl = httpUrl("CAIRN_EXPLORER_URL", explorerRaw);
  const explorer = explorerUrl.href.replace(/\/+$/, "");

  const logLevel = env.CAIRN_LOG || "info";
  if (!LEVELS.includes(logLevel)) throw new ConfigError(`CAIRN_LOG must be error, warn, info or debug, got "${clip(logLevel)}"`);

  const config = {
    command,
    token,
    apiRoot: apiRoot.origin,
    rpcUrl: rpc.href,
    rpcOrigin: rpc.origin,
    chain,
    explorer,
    dataDir: resolve(env.CAIRN_DATA || "./data"),
    pollMs: integer(env, "CAIRN_POLL_MS", 10_000, 50),
    tgTimeout: integer(env, "CAIRN_TG_TIMEOUT", 30, 0, 50),
    rps: integer(env, "CAIRN_RPC_RPS", 5, 1, 100),
    rpcTimeoutMs: integer(env, "CAIRN_RPC_TIMEOUT_MS", 10_000, 100),
    logLevel,
  };
  const networkFile = env.CAIRN_NETWORK_FILE || join(ROOT, "networks", `${chain}.json`);
  const networkName = env.CAIRN_NETWORK_FILE || `networks/${chain}.json`;
  config.network = loadNetwork(networkFile, chain, networkName);
  config.secrets = secretsOf(token, rpc);
  return config;
}

/** Every form in which the token or the RPC URL's secret parts could appear in text. */
function secretsOf(token, rpc) {
  const list = [token, token.slice(token.indexOf(":") + 1), rpc.href];
  const pathAndQuery = `${rpc.pathname}${rpc.search}`;
  if (pathAndQuery !== "/") list.push(pathAndQuery, rpc.pathname, rpc.search);
  // Path segments and query values long enough to be keys (short ones such as "rpc" are not secrets).
  for (const part of rpc.pathname.split("/")) {
    if (part.length < 8) continue;
    list.push(part);
    try {
      list.push(decodeURIComponent(part));
    } catch {}
  }
  for (const [, v] of rpc.searchParams) if (v.length >= 8) list.push(v);
  if (rpc.username) list.push(rpc.username);
  if (rpc.password) list.push(rpc.password);
  // Also their JSON-escaped and URL-encoded forms.
  const all = new Set();
  for (const s of list.filter((x) => x && x.length >= 4 && x !== "/")) {
    all.add(s);
    all.add(JSON.stringify(s).slice(1, -1));
    all.add(encodeURIComponent(s));
  }
  return [...all].sort((a, b) => b.length - a.length);
}

/**
 * Reads and checks a network file. A bad entry is refused as `<file>: <JSON path>: <reason>`, a file that is
 * missing, unreadable or not JSON as `<file>: <reason>`. Keys other than chain and tokens are ignored.
 */
export function loadNetwork(file, chain, name = file) {
  let text, doc;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new ConfigError(`${name}: cannot be read (${e.code === "ENOENT" ? "no such file" : e.code ?? e.message})`);
  }
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${name}: is not valid JSON (${e.message})`);
  }
  const bad = (path, why) => new ConfigError(`${name}: ${path}: ${why}`);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new ConfigError(`${name}: must hold a JSON object`);
  if (doc.chain !== chain) throw bad("chain", `must be "${chain}", the value of CAIRN_CHAIN, but is ${clip(JSON.stringify(doc.chain) ?? "missing")}`);
  if (!Array.isArray(doc.tokens)) throw bad("tokens", "must be a list of tokens");
  if (doc.tokens.length < 1 || doc.tokens.length > 50) throw bad("tokens", `must list 1 to 50 tokens, lists ${doc.tokens.length}`);
  const symbols = new Map(), addresses = new Map(), tokens = [];
  doc.tokens.forEach((t, i) => {
    const at = `tokens[${i}]`;
    if (!t || typeof t !== "object" || Array.isArray(t)) throw bad(at, "must be an object with symbol, address and decimals");
    if (typeof t.symbol !== "string" || !SYMBOL.test(t.symbol)) throw bad(`${at}.symbol`, "must be 1 to 11 letters, digits or dots");
    const lower = t.symbol.toLowerCase();
    if (symbols.has(lower)) throw bad(`${at}.symbol`, `repeats tokens[${symbols.get(lower)}].symbol (symbols are compared ignoring case)`);
    symbols.set(lower, i);
    const address = parseAddress(t.address);
    if (address.problem) throw bad(`${at}.address`, `is not a valid address: ${address.problem === "missing" ? "it is missing" : address.problem}`);
    if (addresses.has(address.value)) throw bad(`${at}.address`, `repeats tokens[${addresses.get(address.value)}].address once normalised`);
    addresses.set(address.value, i);
    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) throw bad(`${at}.decimals`, "must be a whole number from 0 to 36");
    tokens.push({ symbol: t.symbol, address: address.value, decimals: t.decimals });
  });
  return { chain, tokens };
}
