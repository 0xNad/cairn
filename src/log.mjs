// Logs: one JSON object per line on standard error, with at least `level` and `event` (ARCHITECTURE.md,
// "Output conventions"). Standard output carries only a command's JSON line.
//
// Cairn never logs message text, the bot token or an RPC URL beyond its origin. As a second line of defence,
// every line is scrubbed of the secrets it was given before it is written.

export const LEVELS = ["error", "warn", "info", "debug"];

export function createLogger({ level = "info", secrets = [], write = (line) => process.stderr.write(line) } = {}) {
  const max = LEVELS.indexOf(level);
  // Longest first, so that a secret containing another is scrubbed whole. Short fragments ("rpc", "v0_10")
  // are not secrets and would garble the log.
  const hidden = [...new Set(secrets)].filter((s) => typeof s === "string" && s.length >= 8).sort((a, b) => b.length - a.length);
  const emit = (lvl) => (event, fields = {}) => {
    if (LEVELS.indexOf(lvl) > max) return;
    let line = JSON.stringify({ time: new Date().toISOString(), level: lvl, event, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const s of hidden) line = line.split(s).join("<redacted>");
    write(`${line}\n`);
  };
  return { error: emit("error"), warn: emit("warn"), info: emit("info"), debug: emit("debug") };
}

/**
 * The secrets in an environment, before or after it is validated: the bot token and its secret half, and
 * the RPC URL with each part of its path, query and credentials that could be a provider's key.
 */
export function secretsOf(env) {
  const out = [];
  const token = env.TELEGRAM_BOT_TOKEN;
  if (token) out.push(token, token.slice(token.indexOf(":") + 1));
  const rpc = env.STARKNET_RPC_URL;
  if (rpc) {
    out.push(rpc);
    try {
      const u = new URL(rpc);
      out.push(`${u.pathname}${u.search}`, u.search, u.username, u.password);
      // A fragment looks like a key when it is long or mixes in digits: "v0_10" and "starknet" do not.
      const keyLike = (s) => s.length >= 16 || (s.length >= 8 && /\d/.test(s));
      for (const part of u.pathname.split("/")) out.push(...[part, safeDecode(part)].filter(keyLike));
      for (const v of u.searchParams.values()) out.push(v);
    } catch {}
  }
  return out.filter((s) => s && s !== "/");
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
