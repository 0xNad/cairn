import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLogger } from "../src/log.mjs";
import { openStore } from "../src/store.mjs";

const log = createLogger({ level: "error", write: () => {} });

test("the offset survives a reopen, and the directory and files are private", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "cairn-store-")), "data");
  let store = await openStore(dir, log);
  assert.equal(store.offset(), null);
  store.saveUpdate(41, { id: 7, type: "private" });
  store.saveUpdate(42, undefined);
  store.close();
  store = await openStore(dir, log);
  assert.equal(store.offset(), 43);
  assert.equal(store.chatCount(), 1);
  store.close();
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const f of readdirSync(dir)) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
});
