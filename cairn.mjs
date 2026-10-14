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
import { doctor, run, tick } from "./src/modes.mjs";
import { NodeUnavailable } from "./src/rpc.mjs";
import { TelegramError, TelegramUnreachable } from "./src/telegram.mjs";

const MODES = { run, tick, doctor };
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

async function main() {
  // Whatever Cairn creates (CAIRN_DATA and its files) is readable by its user only: 700 and 600.
  process.umask(0o077);
  configureLog({ level: process.env.CAIRN_LOG?.trim(), secrets: secretsOf(process.env) });

  const args = process.argv.slice(2);
  if (args.length !== 1 || !Object.hasOwn(MODES, args[0])) {
    return fail(EXIT.CONFIG, `usage: node cairn.mjs run|tick|doctor, with no other argument (got ${JSON.stringify(args.join(" ").slice(0, 60))}); settings come from the environment, see .env.example`);
  }
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    if (e instanceof Fatal) return fail(e.exitCode, e.message);
    throw e;
  }
  configureLog({ level: config.logLevel, secrets: config.secrets });

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
    const { code, line } = await MODES[args[0]](config, stop.signal);
    exit(code, line);
  } catch (e) {
    if (stop.signal.aborted) return exit(EXIT.OK);
    if (e instanceof Fatal) return fail(e.exitCode, e.message);
    if (e instanceof TelegramUnreachable) return fail(EXIT.UNREACHABLE, `${e.message} (TELEGRAM_API_ROOT is ${config.telegramApiRoot})`);
    if (e instanceof TelegramError) return fail(EXIT.UNREACHABLE, `${e.message} (check TELEGRAM_API_ROOT, ${config.telegramApiRoot})`);
    if (e instanceof NodeUnavailable) return fail(EXIT.UNREACHABLE, e.message);
    log.error("crashed", { error: String(e?.stack ?? e).slice(0, 2000) });
    exit(EXIT.UNREACHABLE);
  }
}

main();
