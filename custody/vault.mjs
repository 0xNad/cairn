import { DatabaseSync } from "node:sqlite";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import {
  mkdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
export const json = (x) =>
  JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
function privatePath(path, directory = false) {
  const s = lstatSync(path);
  if (
    s.isSymbolicLink() ||
    s.uid !== process.getuid() ||
    s.mode & 0o077 ||
    (directory ? !s.isDirectory() : !s.isFile()) ||
    (!directory && s.nlink !== 1)
  )
    throw Error("Custody storage must be private, owned and not linked.");
}
export class Vault {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privatePath(directory, true);
    this.directory = directory;
    const master = join(directory, "master.key"),
      file = join(directory, "vault.db");
    if (existsSync(master) && !existsSync(file))
      throw Error("Custody database missing. Restore it with its master key.");
    if (!existsSync(master)) {
      if (existsSync(file))
        throw Error(
          "Custody master key missing. Restore it; never replace it.",
        );
      writeFileSync(master, randomBytes(32), { mode: 0o600, flag: "wx" });
    }
    privatePath(master);
    this.master = readFileSync(master);
    if (this.master.length !== 32) throw Error("Invalid custody master key.");
    if (existsSync(file)) privatePath(file);
    const mask = process.umask(0o077);
    try {
      this.db = new DatabaseSync(file);
    } finally {
      process.umask(mask);
    }
    chmodSync(file, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
  CREATE TABLE IF NOT EXISTS wallets (user INTEGER PRIMARY KEY,address TEXT NOT NULL UNIQUE,public_key TEXT NOT NULL,class_hash TEXT NOT NULL,secret TEXT NOT NULL,created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY,user INTEGER NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,expires INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'review',hash TEXT,signed TEXT,created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS notifications (id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(id,state));
  CREATE UNIQUE INDEX IF NOT EXISTS one_inflight ON intents(user) WHERE state IN ('signing','signed','pending','unknown');`);
  }
  seal(value, aad) {
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", this.master, iv);
    c.setAAD(Buffer.from(aad));
    const body = Buffer.concat([c.update(value, "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
  }
  open(value, aad) {
    const bytes = Buffer.from(value, "base64"),
      c = createDecipheriv("aes-256-gcm", this.master, bytes.subarray(0, 12));
    c.setAAD(Buffer.from(aad));
    c.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([c.update(bytes.subarray(28)), c.final()]).toString(
      "utf8",
    );
  }
  wallet(user) {
    return (
      this.db
        .prepare(
          "SELECT user,address,public_key,class_hash,created FROM wallets WHERE user=?",
        )
        .get(user) ?? null
    );
  }
  create(user, w, key) {
    if (!Number.isSafeInteger(user) || user <= 0) throw Error("Invalid owner.");
    const prior = this.wallet(user);
    if (prior) return prior;
    this.db
      .prepare("INSERT INTO wallets VALUES(?,?,?,?,?,?)")
      .run(
        user,
        w.address,
        w.publicKey,
        w.classHash,
        this.seal(key, `${user}:${w.address}`),
        Date.now(),
      );
    return this.wallet(user);
  }
  key(user) {
    const row = this.db
      .prepare("SELECT address,secret FROM wallets WHERE user=?")
      .get(user);
    if (!row) throw Error("Create a wallet first.");
    return this.open(row.secret, `${user}:${row.address}`);
  }
  inflight(user) {
    return (
      this.db
        .prepare(
          "SELECT id,user,kind,state,hash FROM intents WHERE user=? AND state IN ('signing','signed','pending','unknown') ORDER BY created DESC LIMIT 1",
        )
        .get(user) ?? null
    );
  }
  intent(user, id) {
    const r = this.db
      .prepare("SELECT * FROM intents WHERE id=? AND user=?")
      .get(id, user);
    return r ? { ...r, payload: JSON.parse(r.payload) } : null;
  }
  review(user, kind, payload, expires) {
    if (this.inflight(user))
      throw Error("Resolve the pending transaction in Activity first.");
    this.db
      .prepare(
        "UPDATE intents SET state='cancelled' WHERE user=? AND state='review'",
      )
      .run(user);
    const id = randomBytes(12).toString("hex");
    this.db
      .prepare(
        "INSERT INTO intents(id,user,kind,payload,expires,created) VALUES(?,?,?,?,?,?)",
      )
      .run(id, user, kind, json(payload), expires, Date.now());
    return this.intent(user, id);
  }
  claim(user, id) {
    const r = this.intent(user, id);
    if (!r || r.expires <= Date.now() || r.state !== "review")
      throw Error("This confirmation expired or was already used.");
    if (this.inflight(user))
      throw Error("Resolve the pending transaction first.");
    if (
      this.db
        .prepare(
          "UPDATE intents SET state='signing' WHERE id=? AND user=? AND state='review'",
        )
        .run(id, user).changes !== 1
    )
      throw Error("Confirmation already used.");
    return r;
  }
  signed(user, id, hash, tx) {
    this.db
      .prepare(
        "UPDATE intents SET state='signed',hash=?,signed=? WHERE id=? AND user=? AND state='signing'",
      )
      .run(hash, this.seal(json(tx), `${user}:${id}`), id, user);
  }
  state(user, id, state) {
    if (
      ![
        "cancelled",
        "failed",
        "pending",
        "unknown",
        "confirmed",
        "reverted",
        "mismatch",
      ].includes(state)
    )
      throw Error("Invalid intent state.");
    this.db
      .prepare("UPDATE intents SET state=? WHERE id=? AND user=?")
      .run(state, id, user);
  }
  sent(user, id, hash) {
    this.db
      .prepare(
        "UPDATE intents SET state='pending',hash=? WHERE id=? AND user=?",
      )
      .run(hash, id, user);
  }
  cancelReviews(user) {
    this.db
      .prepare(
        "UPDATE intents SET state='cancelled' WHERE user=? AND state='review'",
      )
      .run(user);
  }
  active() {
    return this.db
      .prepare(
        "SELECT user,id FROM intents WHERE state IN ('signing','signed','pending','unknown') ORDER BY created LIMIT 10",
      )
      .all();
  }
  notifications() {
    return this.db
      .prepare(
        "SELECT id,user,kind,state,hash FROM intents i WHERE state IN ('confirmed','reverted','mismatch') AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.id=i.id AND n.state=i.state) LIMIT 50",
      )
      .all();
  }
  acknowledge(id, state) {
    this.db
      .prepare("INSERT OR IGNORE INTO notifications VALUES(?,?)")
      .run(id, state);
  }
  history(user) {
    return this.db
      .prepare(
        "SELECT id,kind,state,hash,created FROM intents WHERE user=? ORDER BY created DESC LIMIT 10",
      )
      .all(user);
  }
  close() {
    this.db.close();
    this.master.fill(0);
  }
}
