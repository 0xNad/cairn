import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { Subscriptions } from "../src/subscriptions.mjs";
import {
  respond,
  callback,
  parseTradeReply,
  commandsFor,
} from "../src/commands.mjs";
import { input, minReceived, EXCHANGE_CLASS } from "../trading/lib/core.mjs";
import { parseHtml } from "../.launchpad/checks/round-2/fake-telegram.mjs";
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "cairn-ui-"));
  let store = new Store(dir);
  const config = {
    tradingUrl: "https://cairn.example/",
    tokens: [],
    maxWatches: 20,
  };
  const ctx = {
    config,
    chat: { id: 101, type: "private" },
    userId: 101,
    username: "cairn_bot",
    clean: String,
    subs: new Subscriptions(store, config),
    signal: new AbortController().signal,
  };
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    ctx,
    reopen() {
      store.close();
      store = new Store(dir);
      ctx.subs = new Subscriptions(store, config);
    },
    run: (fn) => store.transaction(fn),
  };
}
const query = (data, id = 101) => ({
  id: "q",
  data,
  from: { id },
  message: { message_id: 1, chat: { id: 101, type: "private" } },
});
async function click(s, data, id = 101) {
  return s.run(await callback(query(data, id), s.ctx)).edit;
}
function next(view, label) {
  return view.keyboard.flat().find((b) => b.text === label).callback_data;
}
async function draft(s, spend = "ETH", receive = "STRK") {
  let v = s.run(await respond({ name: "trade", argument: "" }, s.ctx));
  v = await click(s, next(v, spend));
  v = await click(s, next(v, receive));
  v = s.run(await respond({ name: "trade-reply", argument: "0.001" }, s.ctx));
  return v;
}
test("compact menu uses five commands, valid HTML and no full manual", async (t) => {
  const s = setup(t);
  const v = s.run(await respond({ name: "start", argument: "" }, s.ctx));
  assert.equal(commandsFor(s.ctx.config).length, 5);
  assert.ok(v.lines.join("\n").length < 250);
  assert.equal(next(v, "⇄ Buy / Sell"), "bt:new");
  for (const page of [
    "home",
    "help",
    "wallets",
    "alerts",
    "tools",
    "privacy",
  ]) {
    const view = await click(s, "ui:" + page);
    assert.equal(parseHtml(view.lines.join("\n")).error, undefined);
    assert.ok(view.keyboard.length);
  }
});
test("private trade steps persist across restart; stale and other-user buttons cannot advance them", async (t) => {
  const s = setup(t);
  const first = s.run(await respond({ name: "trade", argument: "" }, s.ctx));
  const stale = next(first, "ETH");
  let v = await click(s, stale);
  assert.match(v.lines.join(" "), /2 of 4/);
  const other = s.run(await callback(query(next(v, "STRK"), 999), s.ctx));
  assert.match(other.answer, /expired/);
  const old = s.run(await callback(query(stale), s.ctx));
  assert.match(old.answer, /expired/);
  v = await click(s, next(v, "STRK"));
  s.reopen();
  const m = { text: "0.001", from: { id: 101 }, chat: s.ctx.chat };
  assert.equal(parseTradeReply(m, s.ctx).name, "trade-reply");
  v = s.run(await respond(parseTradeReply(m, s.ctx), s.ctx));
  assert.match(v.lines.join(" "), /4 of 4/);
  const group = { ...s.ctx, chat: { id: 9, type: "group" } };
  assert.equal(parseTradeReply(m, group), null);
  await click(s, "bt:cancel");
  assert.equal(s.ctx.subs.tradeOf(101), null);
  assert.equal(parseTradeReply(m, s.ctx), null);
});
test("native quote validates provider response and hands off only the chosen wallet and inputs", async (t) => {
  const s = setup(t);
  await draft(s);
  const q = JSON.parse(
    readFileSync(
      new URL("../trading/test/fixtures/quote.json", import.meta.url),
    ),
  )[0];
  const build = JSON.parse(
    readFileSync(
      new URL("../trading/test/fixtures/build.json", import.meta.url),
    ),
  );
  const req = {
    sell: "ETH",
    buy: "STRK",
    amount: "0.001",
    owner: "0x1",
    slippageBps: 50,
  };
  let calls = 0;
  s.ctx.tradeFetch = async (url, options) => {
    calls++;
    assert.equal(String(url), "https://cairn.example/api/quote");
    assert.deepEqual(JSON.parse(options.body), req);
    return new Response(
      JSON.stringify({
        ...input(req),
        ...build,
        version: 1,
        exchangeClass: EXCHANGE_CLASS,
        buyAmount: BigInt(q.buyAmount).toString(),
        minimumReceived: minReceived(q.buyAmount, 50).toString(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 30000,
      }),
    );
  };
  const v = s.run(
    await respond({ name: "trade-reply", argument: "0x1" }, s.ctx),
  );
  assert.equal(calls, 1);
  assert.match(v.lines.join(" "), /Quote preview/);
  const u = new URL(v.keyboard[0][0].url);
  assert.equal(u.searchParams.get("owner"), "0x1");
  assert.equal(u.searchParams.get("sell"), "ETH");
  assert.equal(u.searchParams.get("amount"), "0.001");
  assert.equal(s.ctx.subs.tradeOf(101), null);
  assert.equal(parseHtml(v.lines.join("\n")).error, undefined);
});
test("invalid amounts and provider failures never produce approval links; failure can retry and expire safely", async (t) => {
  const s = setup(t);
  await draft(s);
  s.ctx.tradeFetch = async () => new Response("{}", { status: 503 });
  let v = s.run(await respond({ name: "trade-reply", argument: "0x1" }, s.ctx));
  assert.match(v.lines[0], /unavailable/);
  assert.ok(!v.keyboard.flat().some((b) => b.url));
  v = await click(s, next(v, "Try quote again"));
  assert.match(v.lines[0], /unavailable/);
  const row = s.ctx.subs.tradeOf(101),
    d = JSON.parse(row.value);
  s.run(() => s.ctx.subs.saveTrade(s.ctx.chat, { ...d, expires: 1 }, 0));
  const r = s.run(await callback(query(`bt:${row.id}:retry`), s.ctx));
  assert.match(r.answer, /expired/);
});
test("returning Home discards the setup draft without touching subscriptions", async (t) => {
  const s = setup(t);
  await draft(s);
  await click(s, "ui:home");
  assert.equal(s.ctx.subs.tradeOf(101), null);
});
