// Configuration: the environment and the network file, validated before any network call. A problem exits 2
// with every reason; no reason ever repeats a value that came from the environment (some are secrets).
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXIT, ExitError } from "./errors.mjs";
import { parseAddress } from "./felt.mjs";
import { LOG_LEVELS } from "./log.mjs";

/** The repository root: the directory of cairn.mjs, where `networks/` lives. */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const CHAINS = Object.freeze(["SN_MAIN", "SN_SEPOLIA"]);
const TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{30,}$/;
const SYMBOL_PATTERN = /^[A-Za-z0-9.]{1,11}$/;
const MAX_TOKENS = 50;

/**
 * Checks a network file's content. `name` is how the file is shown in reasons.
 * @returns {{ problems: string[], tokens: { symbol: string, address: string, decimals: number }[] }}
 *   `address` is normalised; a reason reads `<file>: <JSON path>: <reason>`.
 */
export function validateNetwork(data, { name, chain }) {
  const problems = [];
  const tokens = [];
  const bad = (path, reason) => problems.push(`${name}: ${path}: ${reason}`);

  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { problems: [`${name}: the file must hold a JSON object`], tokens };
  }
  if (data.chain !== chain) bad("chain", `must be "${chain}" to match CAIRN_CHAIN, found ${JSON.stringify(data.chain)?.slice(0, 40)}`);

  if (!Array.isArray(data.tokens) || data.tokens.length < 1 || data.tokens.length > MAX_TOKENS) {
    bad("tokens", `must be a list of 1 to ${MAX_TOKENS} tokens`);
    return { problems, tokens };
  }
  const symbols = new Map();
  const addresses = new Map();
  data.tokens.forEach((t, i) => {
    const at = `tokens[${i}]`;
    if (t === null || typeof t !== "object" || Array.isArray(t)) return bad(at, "must be an object with symbol, address and decimals");
    let ok = true;

    if (typeof t.symbol !== "string" || !SYMBOL_PATTERN.test(t.symbol)) {
      bad(`${at}.symbol`, "must be 1 to 11 letters, digits or dots");
      ok = false;
    } else if (symbols.has(t.symbol.toLowerCase())) {
      bad(`${at}.symbol`, `repeats tokens[${symbols.get(t.symbol.toLowerCase())}].symbol (symbols are unique, ignoring case)`);
      ok = false;
    } else symbols.set(t.symbol.toLowerCase(), i);

    const address = parseAddress(t.address);
    if (!address.ok) {
      bad(`${at}.address`, address.reason);
      ok = false;
    } else if (addresses.has(address.value)) {
      bad(`${at}.address`, `repeats tokens[${addresses.get(address.value)}].address (addresses are unique once normalised)`);
      ok = false;
    } else addresses.set(address.value, i);

    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) {
      bad(`${at}.decimals`, "must be an integer from 0 to 36");
      ok = false;
    }
    if (ok) tokens.push({ symbol: t.symbol, address: address.value, decimals: t.decimals });
  });
  return { problems, tokens };
}

/**
 * Reads and validates the whole configuration.
 * @param {Record<string, string | undefined>} env
 * @throws {ExitError} with code 2 and every problem found
 */
export function loadConfig(env, { cwd = process.cwd() } = {}) {
  const problems = [];

  /** A whole number written in decimal digits, within [min, max]. */
  const whole = (name, fallback, min, max = Infinity) => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    if (!/^[0-9]{1,15}$/.test(raw)) {
      problems.push(`${name}: must be a whole number written in decimal digits`);
      return fallback;
    }
    const n = Number(raw);
    if (n < min || n > max) problems.push(`${name}: must be ${max === Infinity ? `at least ${min}` : `from ${min} to ${max}`}`);
    return n;
  };

  /** An http(s) URL, or null (with a problem noted). */
  const httpUrl = (name, raw) => {
    let url;
    try {
      url = new URL(raw);
    } catch {
      problems.push(`${name}: must be an http or https URL`);
      return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      problems.push(`${name}: must be an http or https URL`);
      return null;
    }
    return url;
  };

  // Telegram
  const token = env.TELEGRAM_BOT_TOKEN;
  if (token === undefined) problems.push("TELEGRAM_BOT_TOKEN: required (create a bot with @BotFather)");
  else if (!TOKEN_PATTERN.test(token)) problems.push("TELEGRAM_BOT_TOKEN: is not a bot token (expected <id>:<secret>)");

  let telegramRoot = "https://api.telegram.org";
  if (env.TELEGRAM_API_ROOT !== undefined) {
    const url = httpUrl("TELEGRAM_API_ROOT", env.TELEGRAM_API_ROOT);
    if (url) {
      if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
        problems.push("TELEGRAM_API_ROOT: must be an origin only (scheme, host and port): no path, query or credentials");
      } else telegramRoot = url.origin;
    }
  }

  // Starknet
  let rpcUrl = null;
  if (env.STARKNET_RPC_URL === undefined) problems.push("STARKNET_RPC_URL: required (any Starknet JSON-RPC 0.10 node)");
  else if (httpUrl("STARKNET_RPC_URL", env.STARKNET_RPC_URL)) rpcUrl = env.STARKNET_RPC_URL;

  const chain = env.CAIRN_CHAIN ?? "SN_MAIN";
  const chainOk = CHAINS.includes(chain);
  if (!chainOk) problems.push(`CAIRN_CHAIN: must be ${CHAINS.join(" or ")}`);

  let explorer = "https://voyager.online";
  if (env.CAIRN_EXPLORER_URL !== undefined) {
    const url = httpUrl("CAIRN_EXPLORER_URL", env.CAIRN_EXPLORER_URL);
    if (url) {
      if (url.search || url.hash || url.username || url.password) {
        problems.push("CAIRN_EXPLORER_URL: must not have a query, a fragment or credentials");
      } else explorer = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    }
  }

  // Behaviour
  const pollMs = whole("CAIRN_POLL_MS", 10_000, 50);
  const tgTimeout = whole("CAIRN_TG_TIMEOUT", 30, 0, 50);
  const rpcRps = whole("CAIRN_RPC_RPS", 5, 1, 100);
  const rpcTimeoutMs = whole("CAIRN_RPC_TIMEOUT_MS", 10_000, 100);
  let logLevel = "info";
  if (env.CAIRN_LOG !== undefined) {
    if (LOG_LEVELS.includes(env.CAIRN_LOG)) logLevel = env.CAIRN_LOG;
    else problems.push(`CAIRN_LOG: must be ${LOG_LEVELS.join(", ")}`);
  }

  // Files
  if (env.CAIRN_DATA === "") problems.push("CAIRN_DATA: must not be empty");
  const dataDir = resolve(cwd, env.CAIRN_DATA ?? "data");
  try {
    if (!statSync(dataDir).isDirectory()) problems.push("CAIRN_DATA: exists and is not a directory");
  } catch {} // not there yet: created at the first start

  let network = null;
  let networkFile = null;
  if (env.CAIRN_NETWORK_FILE === "") problems.push("CAIRN_NETWORK_FILE: must not be empty");
  else if (chainOk) {
    const given = env.CAIRN_NETWORK_FILE;
    networkFile = given ?? `networks/${chain}.json`;
    const path = given === undefined ? join(ROOT, "networks", `${chain}.json`) : resolve(cwd, given);
    let data;
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      const why = e instanceof SyntaxError ? `is not valid JSON (${e.message.slice(0, 80)})` : `cannot be read (${e.code ?? "error"})`;
      problems.push(`${networkFile}: ${why}`);
    }
    if (data !== undefined) {
      const found = validateNetwork(data, { name: networkFile, chain });
      problems.push(...found.problems);
      network = { chain, tokens: found.tokens };
    }
  }

  if (problems.length) throw new ExitError(EXIT.CONFIG, ...problems);

  const config = {
    telegramRoot, chain, network, networkFile, dataDir, explorer, pollMs, tgTimeout, rpcRps, rpcTimeoutMs, logLevel,
  };
  // The two secrets are not enumerable: printing or serialising the configuration cannot leak them.
  Object.defineProperty(config, "token", { value: token, enumerable: false });
  Object.defineProperty(config, "rpcUrl", { value: rpcUrl, enumerable: false });
  return Object.freeze(config);
}
