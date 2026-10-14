// The configuration: the environment and the network file, validated in full before any network call.
// Any problem is a Fatal with exit code 2 and a reason an operator can act on. Secret values (the token,
// the RPC URL) are never repeated in a reason.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, Fatal } from "./errors.mjs";
import { hex64, parseAddress } from "./felt.mjs";

// The directory of cairn.mjs: the default network files are next to it.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const CHAINS = { SN_MAIN: "Starknet mainnet", SN_SEPOLIA: "Starknet Sepolia" };
const TOKEN = /^\d+:[A-Za-z0-9_-]{30,}$/;
const LOG_LEVELS = ["error", "warn", "info", "debug"];
// setTimeout's limit: a longer delay would fire at once.
const MAX_MS = 2 ** 31 - 1;
const NUMBERS = [
  // variable, default, min, max, unit
  ["CAIRN_POLL_MS", 10_000, 50, MAX_MS, "milliseconds"],
  ["CAIRN_TG_TIMEOUT", 30, 0, 50, "seconds"],
  ["CAIRN_RPC_RPS", 5, 1, 100, "calls per second"],
  ["CAIRN_RPC_TIMEOUT_MS", 10_000, 100, MAX_MS, "milliseconds"],
];

// A value as given, trimmed; an empty value counts as unset.
const read = (env, name) => {
  const v = env[name];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};
// A non-secret value, quoted and cut short, for a reason.
const quote = (v) => JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v);

function httpUrl(v) {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

// What must never be written anywhere: the token (and its secret half), the RPC URL and its parts, since
// providers put keys in the path, the query or the user info. Computed from the raw environment, so the
// log can scrub them even when the configuration is refused.
export function secretsOf(env) {
  const out = [];
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (token) out.push(token, token.slice(token.indexOf(":") + 1));
  const raw = env.STARKNET_RPC_URL?.trim();
  if (raw) {
    const u = httpUrl(raw);
    if (!u) out.push(raw);
    else {
      // The origin alone is not secret: logs show it. Anything beyond it may be.
      for (const s of [raw, u.href]) if (s !== u.origin && s !== `${u.origin}/`) out.push(s);
      out.push(`${u.pathname}${u.search}`, u.search, u.search.slice(1), u.username, u.password);
      if (u.pathname !== "/") out.push(u.pathname, `${u.origin}${u.pathname}`);
      const parts = [...u.pathname.split("/"), ...[...u.searchParams.values()]];
      for (const p of parts) {
        if (p.length < 8) continue;
        out.push(p);
        try {
          out.push(decodeURIComponent(p));
        } catch {}
      }
    }
  }
  return out.filter((s) => s && s !== "/");
}

export function loadConfig(env = process.env, cwd = process.cwd()) {
  const problems = [];

  const token = read(env, "TELEGRAM_BOT_TOKEN");
  if (!token) problems.push("TELEGRAM_BOT_TOKEN is not set: give it the token @BotFather sent you");
  else if (!TOKEN.test(token)) problems.push("TELEGRAM_BOT_TOKEN does not look like a bot token (digits, a colon, then at least 30 letters, digits, _ or -)");

  let telegramApiRoot = "https://api.telegram.org";
  const root = read(env, "TELEGRAM_API_ROOT");
  if (root !== undefined) {
    const u = httpUrl(root);
    if (!u || u.pathname !== "/" || u.search || u.hash || u.username || u.password) problems.push("TELEGRAM_API_ROOT must be an http(s) origin with no path, such as https://api.telegram.org");
    else telegramApiRoot = u.origin;
  }

  const rpcUrl = read(env, "STARKNET_RPC_URL");
  let rpcOrigin = null;
  if (!rpcUrl) problems.push("STARKNET_RPC_URL is not set: give it a Starknet JSON-RPC 0.10 URL, such as https://starknet-rpc.publicnode.com");
  else {
    const u = httpUrl(rpcUrl);
    if (!u || u.hostname === "") problems.push("STARKNET_RPC_URL must be an http(s) URL, such as https://starknet-rpc.publicnode.com");
    else rpcOrigin = u.origin;
  }

  const chain = read(env, "CAIRN_CHAIN") ?? "SN_MAIN";
  const chainOk = Object.hasOwn(CHAINS, chain);
  if (!chainOk) problems.push(`CAIRN_CHAIN must be SN_MAIN or SN_SEPOLIA, not ${quote(chain)}`);

  let explorer = "https://voyager.online";
  const ex = read(env, "CAIRN_EXPLORER_URL");
  if (ex !== undefined) {
    const u = httpUrl(ex);
    if (!u || u.search || u.hash) problems.push(`CAIRN_EXPLORER_URL must be an http(s) URL with no query, such as https://voyager.online, not ${quote(ex)}`);
    else explorer = `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  }

  const numbers = {};
  for (const [name, fallback, min, max, unit] of NUMBERS) {
    const v = read(env, name);
    const range = max === MAX_MS ? `at least ${min}` : `from ${min} to ${max}`;
    if (v === undefined) numbers[name] = fallback;
    else if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) problems.push(`${name} must be a whole number of ${unit}, ${range}, not ${quote(v)}`);
    else numbers[name] = Number(v);
  }

  const logLevel = read(env, "CAIRN_LOG") ?? "info";
  if (!LOG_LEVELS.includes(logLevel)) problems.push(`CAIRN_LOG must be error, warn, info or debug, not ${quote(logLevel)}`);

  const dataDir = resolve(cwd, read(env, "CAIRN_DATA") ?? "./data");

  if (problems.length) throw new Fatal(EXIT.CONFIG, problems.join("; "));

  const given = read(env, "CAIRN_NETWORK_FILE");
  const networkFile = given ? resolve(cwd, given) : join(ROOT, "networks", `${chain}.json`);
  const network = loadNetwork(networkFile, given ?? `networks/${chain}.json`, chain);

  return {
    token, telegramApiRoot, rpcUrl, rpcOrigin, chain, chainName: CHAINS[chain], explorer, dataDir, logLevel,
    networkFile, tokens: network.tokens,
    pollMs: numbers.CAIRN_POLL_MS, tgTimeout: numbers.CAIRN_TG_TIMEOUT, rpcRps: numbers.CAIRN_RPC_RPS, rpcTimeoutMs: numbers.CAIRN_RPC_TIMEOUT_MS,
    secrets: secretsOf(env),
  };
}

// Reads and validates the network file; `shown` is how its path is named in reasons.
export function loadNetwork(path, shown, chain) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Fatal(EXIT.CONFIG, `${shown}: ${e.code === "ENOENT" ? "no such file (set CAIRN_NETWORK_FILE, or restore the file)" : `cannot be read (${e.code ?? e.message})`}`);
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Fatal(EXIT.CONFIG, `${shown}: not valid JSON (${e.message})`);
  }
  const problems = validateNetwork(doc, chain);
  if (problems.length) throw new Fatal(EXIT.CONFIG, problems.map(([at, why]) => (at ? `${shown}: ${at}: ${why}` : `${shown}: ${why}`)).join("; "));
  return { chain, tokens: doc.tokens.map((t) => ({ symbol: t.symbol, address: parseAddress(t.address).value, decimals: t.decimals })) };
}

// The problems of a network file, as [JSON path, reason]; keys other than chain and tokens are ignored.
export function validateNetwork(doc, chain) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return [["", "must be a JSON object with chain and tokens"]];
  const problems = [];
  if (doc.chain !== chain) problems.push(["chain", doc.chain === undefined ? `missing, should be "${chain}"` : `is ${JSON.stringify(doc.chain)}, but CAIRN_CHAIN is ${chain}`]);
  const tokens = doc.tokens;
  if (!Array.isArray(tokens)) return [...problems, ["tokens", "must be a list of 1 to 50 tokens"]];
  if (tokens.length < 1 || tokens.length > 50) problems.push(["tokens", `must list 1 to 50 tokens, lists ${tokens.length}`]);
  const symbols = new Map(), addresses = new Map();
  tokens.slice(0, 50).forEach((t, i) => {
    const at = `tokens[${i}]`;
    if (!t || typeof t !== "object" || Array.isArray(t)) return problems.push([at, "must be an object with symbol, address and decimals"]);
    if (typeof t.symbol !== "string" || !/^[A-Za-z0-9.]{1,11}$/.test(t.symbol)) problems.push([`${at}.symbol`, "must be 1 to 11 letters, digits or dots"]);
    else if (symbols.has(t.symbol.toLowerCase())) problems.push([`${at}.symbol`, `${JSON.stringify(t.symbol)} repeats ${symbols.get(t.symbol.toLowerCase())} (symbols are compared ignoring case)`]);
    else symbols.set(t.symbol.toLowerCase(), `tokens[${i}].symbol`);
    const a = typeof t.address === "string" ? parseAddress(t.address) : { error: "must be a string" };
    if (a.error) problems.push([`${at}.address`, `not a valid address: ${a.error}`]);
    else if (addresses.has(a.value)) problems.push([`${at}.address`, `repeats ${addresses.get(a.value)} (${hex64(a.value)})`]);
    else addresses.set(a.value, `tokens[${i}].address`);
    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) problems.push([`${at}.decimals`, t.decimals === undefined ? "missing, must be an integer from 0 to 36" : "must be an integer from 0 to 36"]);
  });
  return problems;
}
