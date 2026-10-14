// State in CAIRN_DATA/state.db (node:sqlite). Round 1 stores: the update offset, the command list last sent to
// Telegram, and the ids and types of the chats that wrote. Never stored: message text, names, usernames, the
// token or the RPC URL. The directory has mode 700 and its files 600, and a change commits (WAL, synchronous
// FULL) before anything that depends on it is sent, so a SIGKILL cannot lose it or repeat it.
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS chats (chat_id INTEGER PRIMARY KEY, type TEXT NOT NULL) STRICT;
`;

/**
 * Opens (and creates) the store in `dir`.
 * @returns {Promise<object>} the store; call `close()` when done
 */
export async function openStore(dir, log) {
  // Loaded here, after the caller has set its warning handler: Node 22 prints an experimental warning.
  const { DatabaseSync } = await import("node:sqlite");

  process.umask(0o077);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((statSync(dir).mode & 0o077) !== 0) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      log.warn("data_dir_mode", { note: "CAIRN_DATA is readable by others and cannot be changed" });
    }
  }

  const db = new DatabaseSync(join(dir, "state.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);

  const getKv = db.prepare("SELECT value FROM kv WHERE key = ?");
  const setKv = db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const setChat = db.prepare("INSERT INTO chats (chat_id, type) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET type = excluded.type");

  const read = (key) => getKv.get(key)?.value ?? null;

  /** Runs `fn` in one transaction: all of it commits, or none of it. */
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }

  return {
    /** The next `offset` for getUpdates (the last handled update_id + 1), or null on the first start. */
    offset() {
      const v = read("offset");
      return v === null ? null : Number(v);
    },

    /** Records that update `updateId` is handled (and its chat), before the reply is sent. */
    saveUpdate(updateId, chat) {
      transaction(() => {
        setKv.run("offset", String(updateId + 1));
        if (chat && Number.isSafeInteger(chat.id) && typeof chat.type === "string") setChat.run(chat.id, chat.type.slice(0, 20));
      });
    },

    /** The key of the command list Telegram holds, or null. */
    commandsKey: () => read("commands"),
    setCommandsKey: (key) => setKv.run("commands", key),

    chatCount: () => db.prepare("SELECT COUNT(*) AS n FROM chats").get().n,

    close() {
      try {
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch {}
      db.close();
    },
  };
}
