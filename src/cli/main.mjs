// The command line: `run`, `tick` or `doctor`, no flags. Reasons for a stop go to standard error as JSON lines;
// standard output carries only a command's own JSON line.
import { loadConfig } from "../config.mjs";
import { EXIT, ExitError } from "../errors.mjs";
import { createLogger } from "../log.mjs";
import { NodeUnavailable } from "../rpc.mjs";
import { TelegramError, TelegramUnreachable } from "../telegram.mjs";
import { isAbort } from "../util.mjs";
import { createApp, secretsOf } from "./app.mjs";
import { doctor } from "./doctor.mjs";
import { run } from "./run.mjs";
import { tick } from "./tick.mjs";

const COMMANDS = { run, tick, doctor };
const USAGE = "usage: node cairn.mjs run | tick | doctor (there are no flags: all configuration comes from the environment, see .env.example)";
/** After SIGTERM the process leaves by itself within this long, whatever is still in flight. */
const EXIT_GRACE_MS = 2000;

/** @returns {Promise<number>} the exit code */
export async function main(argv, env) {
  const log = createLogger({ level: "info" });
  try {
    if (argv.length !== 1 || !Object.hasOwn(COMMANDS, argv[0])) throw new ExitError(EXIT.CONFIG, USAGE);
    const config = loadConfig(env);
    log.setLevel(config.logLevel);
    for (const secret of secretsOf(config)) log.addSecret(secret);

    // Node 22 prints an "experimental" warning for node:sqlite: keep stderr to JSON lines.
    process.removeAllListeners("warning");
    process.on("warning", (w) => log.warn("node_warning", { name: w.name, message: String(w.message).slice(0, 200) }));

    const controller = new AbortController();
    const stop = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      setTimeout(() => process.exit(EXIT.OK), EXIT_GRACE_MS).unref();
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);

    return await COMMANDS[argv[0]](createApp(config, { log, signal: controller.signal }));
  } catch (e) {
    return stopWith(e, log);
  }
}

/** Says why the process stops and picks the exit code. */
function stopWith(e, log) {
  if (e instanceof ExitError) {
    for (const reason of e.lines) log.fatal(reason);
    return e.code;
  }
  if (isAbort(e)) return EXIT.OK; // interrupted by SIGTERM or SIGINT
  if (e instanceof TelegramUnreachable) {
    log.fatal(`Telegram is unreachable (${e.message})`);
    return EXIT.UNREACHABLE;
  }
  if (e instanceof TelegramError) {
    log.fatal(`Telegram refused a request (${e.code}): ${e.message}`);
    return EXIT.UNREACHABLE;
  }
  if (e instanceof NodeUnavailable) {
    log.fatal(`the Starknet node is unreachable (${e.message})`);
    return EXIT.UNREACHABLE;
  }
  log.fatal("unexpected error", { error: e?.name ?? "error", code: e?.code });
  log.debug("stack", { stack: String(e?.stack ?? "").slice(0, 2000) });
  return EXIT.UNREACHABLE;
}
