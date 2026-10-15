// Logs: one JSON object per line, on standard error only (standard output carries only a command's JSON
// line). Every line has `t`, `level` and `event`. The secrets the configuration holds (the bot token, the
// RPC URL and its parts) are scrubbed from every string before it is written, whoever logged it: the
// callers never log them on purpose, and this catches what an error message might carry.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let threshold = LEVELS.info;
let secrets = [];

export function configureLog({ level, secrets: list = [] } = {}) {
  if (Object.hasOwn(LEVELS, level)) threshold = LEVELS[level];
  // Longest first, so that a secret holding another is replaced whole.
  secrets = [...new Set(list.filter((s) => typeof s === "string" && s.length >= 4))].sort((a, b) => b.length - a.length);
}

export function scrub(text) {
  let out = String(text);
  for (const s of secrets) out = out.replaceAll(s, "<redacted>");
  return out;
}

function write(level, event, fields) {
  if (LEVELS[level] > threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...fields }, (_, v) =>
    typeof v === "string" ? scrub(v) : typeof v === "bigint" ? v.toString() : v);
  process.stderr.write(`${line}\n`);
}

export const log = {
  error: (event, fields = {}) => write("error", event, fields),
  warn: (event, fields = {}) => write("warn", event, fields),
  info: (event, fields = {}) => write("info", event, fields),
  debug: (event, fields = {}) => write("debug", event, fields),
};

// A short description of a fetch error for a log line: the cause's code (ECONNREFUSED, ENOTFOUND…) or
// message. A connection tried on several addresses fails with an AggregateError: its first error speaks.
export function reasonOf(e) {
  if (e?.name === "TimeoutError") return "timed out";
  const cause = e?.cause?.errors?.[0] ?? e?.cause;
  if (cause?.code) return String(cause.code);
  return String(cause?.message ?? e?.message ?? e).slice(0, 300);
}
