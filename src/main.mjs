// The command line: reads the configuration, runs the command, and maps every failure to its exit code.
//   0 done · 1 Telegram or (doctor) the node unreachable, or a 409 · 2 a bad command line, environment,
//   network file or data directory, or the wrong node · 3 Telegram rejected the token
import { ConfigError, loadConfig } from "./config.mjs";
import { doctor, run, tick } from "./bot.mjs";
import { logger } from "./log.mjs";
import { NodeUnavailable } from "./rpc.mjs";
import { WrongNode } from "./starknet.mjs";
import { StoreError } from "./store.mjs";
import { TelegramError } from "./telegram.mjs";

const COMMANDS = { run, tick, doctor };

/** The exit code for a failure, with its reason logged. */
function failed(e, log) {
  if (e instanceof WrongNode) return log.error("wrong_node", { reason: e.message }), 2;
  if (e instanceof StoreError) return log.error("bad_data_dir", { reason: e.message }), 2;
  if (e instanceof TelegramError) {
    if (e.code === 401) return log.error("token_rejected", { reason: "Telegram rejected the bot token (401): check TELEGRAM_BOT_TOKEN" }), 3;
    if (e.code === 409) return log.error("conflict", { reason: "Telegram answered 409: another instance is running with this token (or a webhook is set)" }), 1;
    return log.error("telegram_unreachable", { reason: e.message }), 1;
  }
  if (e instanceof NodeUnavailable) return log.error("node_unreachable", { reason: e.message }), 1;
  log.error("crashed", { reason: String(e?.stack ?? e) });
  return 1;
}

/** Runs `node cairn.mjs <argv>`; returns the exit code. Only a command's JSON line goes to standard output. */
export async function main(argv, env) {
  // Everything Cairn creates (CAIRN_DATA and its files) is private to its user: 700 and 600.
  process.umask(0o077);
  let cfg;
  try {
    cfg = loadConfig(argv, env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    logger("error").error("bad_config", { reason: e.message });
    return 2;
  }
  const log = logger(cfg.logLevel, cfg.secrets);
  try {
    const line = await COMMANDS[cfg.command](cfg, log);
    if (line) process.stdout.write(`${JSON.stringify(line)}\n`);
    return 0;
  } catch (e) {
    return failed(e, log);
  }
}
