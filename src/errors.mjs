// Exit codes (ARCHITECTURE.md, "Exit codes") and the one error type that carries them.

export const EXIT = Object.freeze({
  OK: 0,
  /** Telegram unreachable, the node unreachable (doctor only) or a 409 conflict. */
  UNREACHABLE: 1,
  /** A bad command line, environment value or network file, or a node on the wrong chain or spec version. */
  CONFIG: 2,
  /** Telegram rejected the bot token (401). Kept apart from 1 so that a supervisor does not restart in a loop. */
  REJECTED: 3,
});

/**
 * Stops the process with `code`. `lines` are the reasons for standard error: they are written as logs, so
 * they must never hold a secret (nothing that comes from the environment is ever echoed).
 */
export class ExitError extends Error {
  constructor(code, ...lines) {
    super(lines.join("; "));
    this.name = "ExitError";
    this.code = code;
    this.lines = lines;
  }
}
