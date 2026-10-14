// State in CAIRN_DATA/state.db (node:sqlite). The directory is mode 700 and its files 600 (cairn.mjs also
// sets the umask to 077). Nothing is written outside CAIRN_DATA, and the token, RPC URLs, message text,
// names and usernames are never stored.
//
// Round 1 stores two things in `meta`: the update offset and the command list sent to Telegram. The
// schema version is SQLite's user_version; each later round appends its migration to MIGRATIONS (round 2:
// chats, watches and the delivery ledger), and a database is brought up to date when it is opened.
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { EXIT, Fatal } from "./errors.mjs";

const MIGRATIONS = [
  // 1 (round 1): key/value settings: "offset" (the next update_id to ask for) and "commands" (JSON).
  "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
];

function prepareDir(dir) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
    if (!statSync(dir).isDirectory()) throw new Error("it is not a directory");
    chmodSync(dir, 0o700);
  } catch (e) {
    throw new Fatal(EXIT.CONFIG, `CAIRN_DATA (${dir}) cannot be used: ${e.code === "ENOENT" ? "its parent directory does not exist" : (e.code ?? e.message)}`);
  }
}

export function openStore(dir) {
  prepareDir(dir);
  const db = new DatabaseSync(join(dir, "state.db"));
  // WAL with synchronous FULL: a committed offset survives a SIGKILL right after it. Temporary tables
  // stay in memory, never in TMPDIR.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;");
  const version = db.prepare("PRAGMA user_version").get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec("COMMIT");
  }
  for (const f of readdirSync(dir)) if (f.startsWith("state.db")) chmodSync(join(dir, f), 0o600);

  const getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
  const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  const get = (key) => getMeta.get(key)?.value;

  return {
    // The next update_id to ask Telegram for: the last handled one + 1 (0 before the first).
    offset: () => Number(get("offset") ?? 0),
    setOffset: (n) => setMeta.run("offset", String(n)),
    commands: () => get("commands"),
    setCommands: (json) => setMeta.run("commands", json),
    close: () => db.close(),
  };
}
