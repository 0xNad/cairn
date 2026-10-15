#!/usr/bin/env node
// Cairn: a read-only Telegram bot for Starknet. ARCHITECTURE.md is the specification.
//
//   node cairn.mjs run | tick | doctor
//
// No flags: all configuration comes from the environment, validated before any network call. Standard
// output carries only the command's JSON line; reasons and logs go to standard error, one JSON object per
// line. Exit codes: 0 done, 1 Telegram (or, for doctor, the node) unreachable or another instance running,
// 2 a bad command line, environment, network file, chain or node version, 3 a token Telegram rejects.
import { createBot } from "./src/bot.mjs";
import { loadConfig } from "./src/config.mjs";
import { Exit, isAbort, refuse } from "./src/errors.mjs";
import { createLogger, secretsOf } from "./src/log.mjs";
import { createRpc } from "./src/rpc.mjs";
import { createChain } from "./src/starknet.mjs";
import { openStore } from "./src/store.mjs";
import { createTelegram } from "./src/telegram.mjs";

// CAIRN_DATA is created with mode 700 and its files 600, whatever the operator's umask.
process.umask(0o077);

const COMMANDS = ["run", "tick", "doctor"];
let log = createLogger({ secrets: secretsOf(process.env) });
let store = null;
const stop = new AbortController();

async function main(args) {
  if (args.length !== 1 || !COMMANDS.includes(args[0])) {
    // Arguments are echoed only when they look like words: a secret passed as a flag must not reach a log.
    const shown = args.every((a) => /^-{0,2}[A-Za-z][\w-]{0,30}$/.test(a)) ? `: ${args.join(" ")}` : "";
    const what = args.length === 0 ? "no command given" : COMMANDS.includes(args[0]) ? `${args[0]} takes no arguments${shown}` : `unknown command${shown}`;
    throw refuse(`${what}. Usage: node cairn.mjs run | tick | doctor (no flags: configuration comes from the environment)`);
  }
  const [command] = args;
  const config = loadConfig(process.env);
  log = createLogger({ level: config.logLevel, secrets: config.secrets });
  if (command !== "doctor") store = openStore(config.data, log);

  // SIGTERM or SIGINT aborts what is in flight (a held long poll first) and exits 0 within 3 s.
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.once(sig, () => {
      log.info("signal", { signal: sig });
      stop.abort();
      setTimeout(() => finish(0), 2500).unref();
    });
  }
  const signal = stop.signal;
  const rpc = createRpc({ url: config.rpc.url, headers: config.rpc.headers, rps: config.rps, timeoutMs: config.rpcTimeoutMs, log, signal });
  const tg = createTelegram({ root: config.telegramRoot, token: config.token, log, signal });
  const bot = createBot({ config, log, tg, chain: createChain(rpc), store, signal });
  return bot[command]();
}

/** Closes the state and exits with `code` once standard output is flushed. */
function finish(code, line) {
  try {
    store?.close();
  } catch {}
  store = null;
  if (line === undefined) process.exit(code);
  process.stdout.write(`${JSON.stringify(line)}\n`, () => process.exit(code));
}

try {
  const line = await main(process.argv.slice(2));
  finish(0, line ?? undefined);
} catch (e) {
  if (isAbort(e) && stop.signal.aborted) finish(0);
  else if (e instanceof Exit) {
    for (const reason of e.reasons) log.error("exit", { code: e.code, reason });
    finish(e.code);
  } else {
    log.error("crash", { error: String(e?.stack ?? e).slice(0, 2000) });
    finish(1);
  }
}
