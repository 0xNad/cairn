// The environment and the network file (ARCHITECTURE.md, "The environment" and "The network file"), read
// and validated before any network call. Every problem is reported at once, so an operator fixes them in
// one go; the secrets (the bot token, the RPC URL) are never echoed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { refuse } from "./errors.mjs";
import { parseAddress } from "./felt.mjs";
import { LEVELS, secretsOf } from "./log.mjs";

/** The directory of cairn.mjs: the default network files sit next to it. */
const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The chains Cairn knows, with the id `starknet_chainId` answers (the name as a short string). */
export const CHAINS = {
  SN_MAIN: { id: 0x534e5f4d41494en, label: "Starknet mainnet" },
  SN_SEPOLIA: { id: 0x534e5f5345504f4c4941n, label: "Starknet Sepolia testnet" },
};

const NUMBERS = [
  // [variable, default, min, max]
  ["CAIRN_POLL_MS", 10_000, 50, Infinity],
  ["CAIRN_TG_TIMEOUT", 30, 0, 50],
  ["CAIRN_RPC_RPS", 5, 1, 100],
  ["CAIRN_RPC_TIMEOUT_MS", 10_000, 100, Infinity],
];

/** Reads the configuration from `env`; throws an exit-2 refusal listing every problem. */
export function loadConfig(env) {
  const problems = [];
  const value = (name, fallback) => {
    const v = env[name];
    if (v === undefined) return fallback;
    if (v === "") {
      problems.push(`${name} is set but empty: unset it${fallback === undefined ? " or give it a value" : " to use the default"}`);
      return undefined;
    }
    return v;
  };

  const token = value("TELEGRAM_BOT_TOKEN");
  if (token === undefined && env.TELEGRAM_BOT_TOKEN === undefined) problems.push("TELEGRAM_BOT_TOKEN is required: the token @BotFather gave your bot");
  else if (token !== undefined && !/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) problems.push("TELEGRAM_BOT_TOKEN is not a bot token: it should look like <digits>:<at least 30 letters, digits, _ or ->");

  const telegramRoot = origin(value("TELEGRAM_API_ROOT", "https://api.telegram.org"), "TELEGRAM_API_ROOT", problems);

  const rpcRaw = value("STARKNET_RPC_URL");
  if (rpcRaw === undefined && env.STARKNET_RPC_URL === undefined) problems.push("STARKNET_RPC_URL is required: the URL of a Starknet JSON-RPC 0.10 node");
  const rpc = rpcRaw === undefined ? undefined : rpcEndpoint(rpcRaw, problems);

  const chain = value("CAIRN_CHAIN", "SN_MAIN");
  if (chain !== undefined && !CHAINS[chain]) problems.push(`CAIRN_CHAIN is ${JSON.stringify(chain)}: it should be SN_MAIN or SN_SEPOLIA`);

  const explorer = explorerUrl(value("CAIRN_EXPLORER_URL", "https://voyager.online"), problems);
  const data = value("CAIRN_DATA", "./data");
  const logLevel = value("CAIRN_LOG", "info");
  if (logLevel !== undefined && !LEVELS.includes(logLevel)) problems.push(`CAIRN_LOG is ${JSON.stringify(logLevel)}: it should be ${LEVELS.join(", ")}`);

  const numbers = {};
  for (const [name, fallback, min, max] of NUMBERS) {
    const v = value(name, String(fallback));
    if (v === undefined) continue;
    const n = /^\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isSafeInteger(n)) problems.push(`${name} is ${JSON.stringify(v)}: it should be a whole number in decimal digits`);
    else if (n < min || n > max) problems.push(`${name} is ${n}: it should be ${max === Infinity ? `at least ${min}` : `from ${min} to ${max}`}`);
    else numbers[name] = n;
  }

  // The network file is read last: its default depends on CAIRN_CHAIN, and it is only worth reading when
  // the chain is known.
  const networkFile = value("CAIRN_NETWORK_FILE", CHAINS[chain] ? join(HERE, "networks", `${chain}.json`) : undefined);
  const tokens = networkFile !== undefined && CHAINS[chain] ? readNetwork(networkFile, chain, problems) : [];

  if (problems.length) throw refuse(...problems);
  return {
    token, telegramRoot, rpc, chain, networkFile, tokens, data, explorer, logLevel,
    pollMs: numbers.CAIRN_POLL_MS,
    tgTimeout: numbers.CAIRN_TG_TIMEOUT,
    rps: numbers.CAIRN_RPC_RPS,
    rpcTimeoutMs: numbers.CAIRN_RPC_TIMEOUT_MS,
    secrets: secretsOf(env),
  };
}

/** TELEGRAM_API_ROOT: an http(s) origin with no path, query or credentials. */
function origin(v, name, problems) {
  if (v === undefined) return undefined;
  let u;
  try {
    u = new URL(v);
  } catch {
    problems.push(`${name} is not a URL: it should be an http(s) origin like https://api.telegram.org`);
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") problems.push(`${name} uses ${u.protocol}: it should be an http(s) origin`);
  else if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) problems.push(`${name} has more than an origin: give only the scheme, host and port, like https://api.telegram.org`);
  else return u.origin;
  return undefined;
}

/**
 * STARKNET_RPC_URL: an http(s) URL. It is a secret (providers put keys in its path or query), so no reason
 * quotes it. Credentials in it become an Authorization header, which fetch requires.
 */
function rpcEndpoint(v, problems) {
  let u;
  try {
    u = new URL(v);
  } catch {
    problems.push("STARKNET_RPC_URL is not a URL: it should start with https:// (or http://)");
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    problems.push(`STARKNET_RPC_URL uses ${u.protocol}: it should be an http(s) URL`);
    return undefined;
  }
  const headers = {};
  if (u.username || u.password) {
    headers.authorization = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64")}`;
    u.username = "";
    u.password = "";
  }
  u.hash = "";
  return { url: u.href, origin: u.origin, headers };
}

/** CAIRN_EXPLORER_URL: an http(s) URL Cairn only builds links on, with no trailing slash. */
function explorerUrl(v, problems) {
  if (v === undefined) return undefined;
  let u;
  try {
    u = new URL(v);
  } catch {
    problems.push(`CAIRN_EXPLORER_URL is not a URL: it should be like https://voyager.online`);
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") problems.push(`CAIRN_EXPLORER_URL uses ${u.protocol}: it should be an http(s) URL`);
  else if (u.search || u.hash) problems.push("CAIRN_EXPLORER_URL should have no query or fragment: Cairn appends /tx/<hash> and /contract/<address>");
  else return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  return undefined;
}

/**
 * The network file: {"chain","tokens":[{"symbol","address","decimals"}…]}. Other keys are ignored in round
 * 1. Problems are "<file>: <JSON path>: <reason>", or "<file>: <reason>" for a file that cannot be read.
 */
export function readNetwork(file, chain, problems) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    problems.push(`${file}: ${e.code === "ENOENT" ? "no such file" : e.code ? `cannot be read (${e.code})` : `is not JSON (${e.message})`}`);
    return [];
  }
  const bad = (path, reason) => problems.push(`${file}: ${path}: ${reason}`);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    problems.push(`${file}: should hold a JSON object with "chain" and "tokens"`);
    return [];
  }
  if (doc.chain !== chain) bad("chain", `is ${JSON.stringify(doc.chain)}, but CAIRN_CHAIN is ${chain}`);
  if (!Array.isArray(doc.tokens) || doc.tokens.length < 1 || doc.tokens.length > 50) {
    bad("tokens", `should list 1 to 50 tokens, ${Array.isArray(doc.tokens) ? `lists ${doc.tokens.length}` : "is not a list"}`);
    return [];
  }
  const tokens = [];
  const symbols = new Map(), addresses = new Map();
  doc.tokens.forEach((t, i) => {
    const at = `tokens[${i}]`;
    if (!t || typeof t !== "object" || Array.isArray(t)) return bad(at, "should be an object with symbol, address and decimals");
    const before = problems.length;
    if (typeof t.symbol !== "string" || !/^[A-Za-z0-9.]{1,11}$/.test(t.symbol)) bad(`${at}.symbol`, `is ${JSON.stringify(t.symbol)}: it should be 1 to 11 letters, digits or dots`);
    else if (symbols.has(t.symbol.toLowerCase())) bad(`${at}.symbol`, `${JSON.stringify(t.symbol)} repeats ${symbols.get(t.symbol.toLowerCase())} (symbols are compared ignoring case)`);
    else symbols.set(t.symbol.toLowerCase(), `tokens[${i}].symbol`);
    const a = typeof t.address === "string" ? parseAddress(t.address) : { error: "should be a string like 0x0471…" };
    if (a.error) bad(`${at}.address`, `${typeof t.address === "string" ? `${JSON.stringify(t.address.slice(0, 80))} ` : ""}${a.error}`);
    else if (addresses.has(a.value)) bad(`${at}.address`, `is the address of ${addresses.get(a.value)} once normalised`);
    else addresses.set(a.value, at);
    if (t.decimals === undefined) bad(`${at}.decimals`, "is missing: it should be an integer from 0 to 36");
    else if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) bad(`${at}.decimals`, `is ${JSON.stringify(t.decimals)}: it should be an integer from 0 to 36`);
    if (problems.length === before) tokens.push({ symbol: t.symbol, address: a.value, hex: a.hex, decimals: t.decimals });
  });
  return tokens;
}
