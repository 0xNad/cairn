// The errors that end a command with a given exit code (ARCHITECTURE.md, "Exit codes"). Anything else that
// goes wrong is handled where it happens: a busy node gets a "node busy" reply, a refused message is skipped.

export class Exit extends Error {
  /** `code` is the exit code; `reasons` are what goes to standard error, one per line. */
  constructor(code, ...reasons) {
    super(reasons[0]);
    this.code = code;
    this.reasons = reasons;
  }
}

/** 2: a bad command line, environment value or network file, or a node on the wrong chain or spec. */
export const refuse = (...reasons) => new Exit(2, ...reasons);
/** 1: Telegram unreachable, or the node unreachable (doctor only). `run` waits these out instead. */
export const unreachable = (reason) => Object.assign(new Exit(1, reason), { transient: true });
/** 1: Telegram answered 409: another instance is polling with this token (or a webhook is set). */
export const conflict = (description) =>
  new Exit(1, `another instance is running: Telegram answered 409 Conflict (${description}). Stop the other instance, or remove the webhook, then start again`);
/** 3: Telegram rejected the token. A supervisor should not restart in a loop on it. */
export const rejected = () => new Exit(3, "Telegram rejected the bot token (401 Unauthorized): check TELEGRAM_BOT_TOKEN with @BotFather");

/** Whether `e` is the abort of a shutdown (SIGTERM or SIGINT), not a failure. */
export const isAbort = (e) => e?.name === "AbortError";
