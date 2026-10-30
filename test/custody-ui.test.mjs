import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { Subscriptions } from "../src/subscriptions.mjs";
import { respond, callback, parseCustodyReply } from "../src/commands.mjs";
import { parseHtml } from "../.launchpad/checks/round-2/fake-telegram.mjs";
function make(t) {
  const dir = mkdtempSync(join(tmpdir(), "cairn-cui-")),
    store = new Store(dir),
    config = {
      tradingUrl: "https://cairn.example",
      tokens: [],
      maxWatches: 20,
    };
  let w = null,
    creates = 0,
    confirms = 0;
  const custody = {
    wallet: (u) => (u === 101 ? w : null),
    cancelReviews: () => {},
    create: async (u) => {
      assert.equal(u, 101);
      creates++;
      w = { address: "0x123" };
      return w;
    },
    status: async () =>
      w
        ? { ...w, deployed: false, balances: [{ symbol: "STRK", amount: "0" }] }
        : null,
    history: () => [],
    exportKey: () => "0x4",
    confirm: async () => {
      confirms++;
      return {
        id: "a".repeat(24),
        kind: "swap",
        state: "pending",
        hash: "0x123",
      };
    },
  };
  const ctx = {
    config,
    chat: { id: 101, type: "private" },
    userId: 101,
    username: "cairn_bot",
    clean: String,
    subs: new Subscriptions(store, config),
    signal: new AbortController().signal,
    custody,
  };
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    ctx,
    run: (fn) => store.transaction(fn),
    creates: () => creates,
    confirms: () => confirms,
  };
}
const q = (action, who = 101, chat = { id: 101, type: "private" }) => ({
  id: "q",
  data: "cw:" + action,
  from: { id: who },
  message: { message_id: 1, chat },
});
async function tap(s, action, who = 101, chat = s.ctx.chat) {
  return s.run(await callback(q(action, who, chat), { ...s.ctx, chat }));
}
test("wallet creation starts inside Telegram with custody disclosure; no external URL is required", async (t) => {
  const s = make(t);
  const home = s.run(await respond({ name: "start", argument: "" }, s.ctx));
  assert.equal(home.keyboard[0][0].callback_data, "cw:new");
  const intro = (await tap(s, "new")).edit;
  assert.match(intro.lines.join(" "), /hold its private key/);
  assert.equal(s.creates(), 0);
  const wallet = (await tap(s, "create")).edit;
  assert.equal(s.creates(), 1);
  assert.match(wallet.lines.join(" "), /0x123/);
  assert.ok(!wallet.keyboard.flat().some((b) => b.url));
  assert.equal(parseHtml(wallet.lines.join("\n")).error, undefined);
});
test("another user or group cannot create, confirm or inspect a private trading wallet", async (t) => {
  const s = make(t);
  for (const a of ["create", "confirm:" + "a".repeat(24), "wallet"]) {
    assert.match((await tap(s, a, 102)).answer, /private/);
    assert.match(
      (await tap(s, a, 101, { id: -100, type: "supergroup" })).answer,
      /private/,
    );
  }
  assert.equal(s.creates(), 0);
  assert.equal(s.confirms(), 0);
});
test("trade amount comes from the private chat draft, without asking to connect a browser wallet", async (t) => {
  const s = make(t);
  await tap(s, "create");
  let v = s.run(await respond({ name: "trade", argument: "" }, s.ctx));
  const choose = (label) =>
    v.keyboard
      .flat()
      .find((b) => b.text === label)
      .callback_data.slice(3);
  v = (await tap(s, choose("ETH"))).edit;
  v = (await tap(s, choose("STRK"))).edit;
  assert.match(v.lines.join(" "), /Send the amount/);
  assert.ok(!v.lines.join(" ").includes("connect"));
  const m = { text: "0.001", from: { id: 101 } };
  assert.equal(parseCustodyReply(m, s.ctx).name, "custody-reply");
  assert.equal(parseCustodyReply({ ...m, from: { id: 102 } }, s.ctx), null);
});

test("key reveal is owner-bound and single-use; Hide works without a provider request", async (t) => {
  const s = make(t);
  await tap(s, "create");
  const warning = (await tap(s, "backup")).edit;
  const reveal = warning.keyboard[0][0].callback_data.slice(3);
  assert.match((await tap(s, reveal, 102)).answer, /private/);
  const key = (await tap(s, reveal)).edit;
  assert.ok(key.lines.includes("<code>0x4</code>"));
  assert.match((await tap(s, reveal)).answer, /expired/);
  const hidden = (await tap(s, "hide")).edit;
  assert.ok(!hidden.lines.join(" ").includes("0x4"));
});

test("a failed quote is contained in the conversation and never leaks an SDK/provider error", async (t) => {
  const s = make(t);
  await tap(s, "create");
  let v = s.run(await respond({ name: "trade", argument: "" }, s.ctx));
  for (const name of ["ETH", "STRK"]) {
    const data = v.keyboard
      .flat()
      .find((b) => b.text === name)
      .callback_data.slice(3);
    v = (await tap(s, data)).edit;
  }
  s.ctx.custody.swapReview = async () => {
    throw Error("private RPC token SHOULD_NOT_LEAK");
  };
  const r = s.run(
    await respond({ name: "custody-reply", argument: "0.001" }, s.ctx),
  );
  assert.match(r.lines.join(" "), /No transaction was submitted/);
  assert.ok(!r.lines.join(" ").includes("SHOULD_NOT_LEAK"));
});
