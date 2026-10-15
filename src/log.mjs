// Logs: one JSON object per line on standard error, never on standard output. A line always has `ts`
// (wall clock, logs only), `level` and `event`. Nothing that comes from a user or from the environment is
// logged on purpose; every line also goes through a redactor that knows the secrets, as a second guard.
import { writeFd } from "./util.mjs";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
export const LOG_LEVELS = Object.freeze(Object.keys(LEVELS));

/** @param {{ level?: string, write?: (line: string) => void }} [options] */
export function createLogger({ level = "info", write = (line) => writeFd(2, line) } = {}) {
  let threshold = LEVELS[level] ?? LEVELS.info;
  const secrets = new Set();

  /** Replaces every known secret in `text` by "[redacted]". */
  function redact(text) {
    let out = String(text);
    for (const s of secrets) if (out.includes(s)) out = out.split(s).join("[redacted]");
    return out;
  }

  function emit(lvl, event, fields = {}) {
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, event, ...fields });
    write(`${redact(line)}\n`);
  }

  const at = (lvl) => (event, fields) => {
    if (LEVELS[lvl] <= threshold) emit(lvl, event, fields);
  };

  return {
    error: at("error"),
    warn: at("warn"),
    info: at("info"),
    debug: at("debug"),
    /** Always written, whatever the level: the reasons a process stops (exit codes 1, 2 and 3). */
    fatal: (message, fields) => emit("error", "fatal", { message, ...fields }),
    setLevel(name) {
      if (name in LEVELS) threshold = LEVELS[name];
    },
    /** Teaches the redactor a secret (and its JSON-escaped form). Very short strings are ignored. */
    addSecret(value) {
      const s = String(value ?? "");
      if (s.length < 8) return;
      secrets.add(s);
      secrets.add(JSON.stringify(s).slice(1, -1));
    },
    redact,
  };
}
