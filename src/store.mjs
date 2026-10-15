// State in CAIRN_DATA: one SQLite database (node:sqlite), state.db. The directory is mode 700 and every file
// in it mode 600 (cairn.mjs sets the umask to 077, and the modes are set again here). Stored: the last
// update handled, the command list sent to Telegram, and the chats Cairn answered (id and type). Never
// message text, names or usernames, the token or the RPC URL.
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** CAIRN_DATA cannot be created or opened: exit 2. */
export class StoreError extends Error {}

/** Each migration takes the database from version i to i + 1. Later rounds append; none is ever edited. */
const MIGRATIONS = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE chats (id INTEGER PRIMARY KEY, type TEXT NOT NULL, first_update INTEGER NOT NULL, last_update INTEGER NOT NULL);`,
];

export function openStore(dir) {
  let db;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const file = join(dir, "state.db");
    db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    // A rollback journal (deleted after each commit) rather than WAL, and temporary tables in memory:
    // nothing but state.db stays in CAIRN_DATA, and nothing is written anywhere else.
    db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA temp_store = MEMORY; PRAGMA busy_timeout = 5000;");
    migrate(db);
  } catch (e) {
    db?.close();
    throw new StoreError(`CAIRN_DATA (${dir}) cannot be used: ${e.code ?? e.message}`);
  }

  const getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
  const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  const upsertChat = db.prepare(`INSERT INTO chats (id, type, first_update, last_update) VALUES (?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET type = excluded.type, last_update = excluded.last_update`);

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
    get: (key) => getMeta.get(key)?.value ?? null,
    set: (key, value) => setMeta.run(key, String(value)),
    /** The last update_id handled, or null before the first. */
    lastUpdate() {
      const v = getMeta.get("last_update_id")?.value;
      return v === undefined ? null : Number(v);
    },
    /**
     * Records an update as handled, with its chat, in one transaction. It is called before the reply is
     * sent, so an update is never answered twice, even across a SIGKILL right after the reply.
     */
    handled(updateId, chat) {
      transaction(() => {
        setMeta.run("last_update_id", String(updateId));
        if (chat && Number.isSafeInteger(chat.id)) upsertChat.run(chat.id, String(chat.type ?? "unknown"), updateId, updateId);
      });
    },
    close: () => db.close(),
  };
}

function migrate(db) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
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
