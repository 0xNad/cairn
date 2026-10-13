// State in CAIRN_DATA (ARCHITECTURE.md, "State and the data directory"): node:sqlite at state.db, in a
// directory of mode 700 with files of mode 600. Round 1 keeps two values: the update offset and the command
// list last sent to Telegram. It stores no chat id, message text, name or username.
//
// Each handled update is saved, with whatever it changed, before its reply is sent: a kill can lose that
// one reply, but no update is ever handled twice. Later rounds add tables through MIGRATIONS.
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { refuse } from "./errors.mjs";

/** Schema versions, in order: PRAGMA user_version is the number applied. Never edit one, append. */
const MIGRATIONS = [
  // 1 (round 1): small values by name: "offset" (the next update_id to ask for), "commands" (JSON).
  "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
];
const FILES = ["state.db", "state.db-wal", "state.db-shm"];

export function openStore(dir, log) {
  try {
    if (existsSync(dir)) {
      const mode = statSync(dir).mode & 0o777;
      if (mode & 0o077) log.warn("data_dir_open", { reason: `CAIRN_DATA has mode ${mode.toString(8)}: run chmod 700 on it, it holds the bot's state` });
    } else mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    throw refuse(`CAIRN_DATA (${dir}) cannot be created: ${e.code ?? e.message}`);
  }
  let db;
  try {
    db = new DatabaseSync(join(dir, "state.db"));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY;");
    migrate(db);
  } catch (e) {
    db?.close();
    throw refuse(`CAIRN_DATA (${dir}) holds no usable state.db: ${e.message}`);
  }
  // Created under umask 077 already; this also tightens files an older run or a copy left open.
  for (const f of FILES) if (existsSync(join(dir, f))) chmodSync(join(dir, f), 0o600);

  const get = db.prepare("SELECT value FROM kv WHERE key = ?");
  const put = db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  const read = (key) => get.get(key)?.value;
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };

  return {
    /** The offset for getUpdates: the last handled update_id + 1, or 0 before the first. */
    offset: () => Number(read("offset") ?? 0),
    /** Records update `id` as handled, after `changes()` (its writes), in one transaction. */
    handled(id, changes) {
      transaction(() => {
        changes?.();
        if (id + 1 > Number(read("offset") ?? 0)) put.run("offset", String(id + 1));
      });
    },
    get: read,
    set: (key, value) => put.run(key, value),
    close: () => db.close(),
  };
}

function migrate(db) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version > MIGRATIONS.length) throw new Error(`its schema is version ${version}, newer than this Cairn (${MIGRATIONS.length})`);
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
