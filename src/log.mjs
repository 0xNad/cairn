// Logs: one JSON object per line on standard error, with at least `level` and `event`. Every line passes
// through redact(), so neither the bot token nor the RPC URL's path or query can reach a log.

export const LEVELS = ["error", "warn", "info", "debug"];

/** Replaces every secret in `text` with `<redacted>`. Secrets shorter than 4 characters are left alone. */
export function redact(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("<redacted>");
  return out;
}

/** A logger at `level` (`error` < `warn` < `info` < `debug`) that never writes a secret. */
export function logger(level = "info", secrets = []) {
  const rank = LEVELS.indexOf(level);
  const write = (lvl) => (event, fields = {}) => {
    if (LEVELS.indexOf(lvl) > rank) return;
    const line = JSON.stringify({ time: new Date().toISOString(), level: lvl, event, ...fields });
    process.stderr.write(`${redact(line, secrets)}\n`);
  };
  return { error: write("error"), warn: write("warn"), info: write("info"), debug: write("debug"), redact: (t) => redact(t, secrets) };
}
