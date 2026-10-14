#!/usr/bin/env node
// Cairn: a read-only Telegram bot for Starknet (ARCHITECTURE.md is the specification).
//
//   node cairn.mjs run      long-polls Telegram and answers commands until SIGTERM or SIGINT
//   node cairn.mjs tick     one pass, then one JSON line: {"updates","sent","head"}
//   node cairn.mjs doctor   checks the token and the node, then one JSON line: {"bot","chain","block","spec"}
//
// There are no flags: the configuration is the environment (.env.example lists it). Standard output
// carries only the command's JSON line; reasons and logs go to standard error, one JSON object per line.
import { loadConfig, secretsOf } from "./src/config.mjs";
import { EXIT, Fatal } from "./src/errors.mjs";
import { configureLog, log } from "./src/log.mjs";
import { NodeUnavailable } from "./src/rpc.mjs";
import { TelegramError, TelegramUnreachable } from "./src/telegram.mjs";

const MODES = ["run", "tick", "doctor"];
const NODE_MAJOR = 24;
// SIGTERM must end `run` within 3 s: past this, the process exits whatever is still pending.
const STOP_GRACE_MS = 2500;

// Writes the JSON line (if any), lets standard error drain, then exits with `code`.
function exit(code, line) {
  const out = line ? new Promise((r) => process.stdout.write(`${JSON.stringify(line)}\n`, r)) : null;
  const err = new Promise((r) => process.stderr.write("", r));
  Promise.all([out, err]).then(() => process.exit(code));
}

function fail(code, reason) {
  log.error("exit", { code, reason });
  exit(code);
}

// A bug must still end as one JSON log line and exit 1, never as a bare stack trace.
function crashed(e) {
  log.error("crashed", { error: String(e?.stack ?? e).slice(0, 2000) });
  exit(EXIT.UNREACHABLE);
}

async function main() {
  // Whatever Cairn creates (CAIRN_DATA and its files) is readable by its user only: 700 and 600.
  process.umask(0o077);
  configureLog({ level: process.env.CAIRN_LOG?.trim(), secrets: secretsOf(process.env) });
  process.on("uncaughtException", crashed);
  process.on("unhandledRejection", crashed);

  const args = process.argv.slice(2);
  if (args.length !== 1 || !MODES.includes(args[0])) {
    return fail(EXIT.CONFIG, `usage: node cairn.mjs run|tick|doctor, with no other argument (got ${JSON.stringify(args.join(" ").slice(0, 60))}); settings come from the environment, see .env.example`);
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (major < NODE_MAJOR) return fail(EXIT.CONFIG, `Cairn needs Node.js ${NODE_MAJOR} or later (for node:sqlite), this is Node.js ${process.versions.node}`);
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    if (e instanceof Fatal) return fail(e.exitCode, e.message);
    throw e;
  }
  configureLog({ level: config.logLevel, secrets: config.secrets });
  for (const warning of config.warnings) log.warn("config", { warning });

  const stop = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      if (stop.signal.aborted) return;
      log.info("stopping", { signal });
      stop.abort();
      setTimeout(() => {
        log.warn("stopped_forcibly", { after_ms: STOP_GRACE_MS });
        process.exit(EXIT.OK);
      }, STOP_GRACE_MS).unref();
    });
  }

  try {
    // Loaded after the version check: the modes need node:sqlite, which older Node.js lacks.
    const modes = await import("./src/modes.mjs");
    const { code, line } = await modes[args[0]](config, stop.signal);
    exit(code, line);
  } catch (e) {
    if (stop.signal.aborted) return exit(EXIT.OK);
    if (e instanceof Fatal) return fail(e.exitCode, e.message);
    if (e instanceof TelegramUnreachable) return fail(EXIT.UNREACHABLE, `${e.message} (TELEGRAM_API_ROOT is ${config.telegramApiRoot})`);
    if (e instanceof TelegramError) return fail(EXIT.UNREACHABLE, `${e.message} (check TELEGRAM_API_ROOT, ${config.telegramApiRoot})`);
    if (e instanceof NodeUnavailable) return fail(EXIT.UNREACHABLE, e.message);
    crashed(e);
  }
}

main();
