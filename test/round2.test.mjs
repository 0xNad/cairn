import assert from "node:assert/strict";
import { test } from "node:test";
import { RoundTwo } from "../src/round2.mjs";
import {
  units,
  decodeSymbol,
  eventShape,
  TRANSFER,
} from "../src/alert-values.mjs";
import { normalize } from "../src/felt.mjs";
import { NodeBusy } from "../src/errors.mjs";
import { parseHtml } from "../.launchpad/checks/round-1/fake-telegram.mjs";

const A = normalize("0x123"),
  B = normalize("0x456"),
  TOKEN = normalize("0x789"),
  UNKNOWN = normalize("0xabc"),
  HASH = normalize("0x999");
const head = { block_number: 11, timestamp: 1000 };
const ev = (contract = TOKEN) => ({
  from_address: contract,
  keys: [TRANSFER, A, B],
  data: ["0x1", "0x0"],
  block_number: 11,
  transaction_hash: HASH,
});
function context({ events = [ev()], unknown = false, failure = false } = {}) {
  const calls = [];
  const rpc = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === "starknet_getEvents") return { events };
      if (method === "starknet_getBlockWithTxHashes")
        return {
          block_number: 11,
          timestamp: 1000,
          sequencer_address: normalize("0x666"),
        };
      if (method === "starknet_getTransactionReceipt")
        return {
          events,
          actual_fee: { amount: "0x7" },
          execution_status: "SUCCEEDED",
          finality_status: "ACCEPTED_ON_L2",
        };
      if (method === "starknet_call" && failure) throw new NodeBusy();
      throw new Error(`Unexpected RPC ${method}`);
    },
  };
  const store = { state: {}, save() {} };
  const config = {
    tokens: [{ address: TOKEN, symbol: "STRK", decimals: 18 }],
    maxBlocks: 500,
    maxWatches: 20,
    explorer: "https://explorer.example",
    chain: "SN_MAIN",
  };
  const tg = {
    async call() {
      return true;
    },
  };
  const r = new RoundTwo(
    { config, rpc, clean: String, username: "fixture_bot" },
    store,
    tg,
  );
  r.state.cursor = 10;
  r.chat(1).watches.push({ address: A, label: "Vault", since_block: 10 });
  return { r, calls };
}
test("decimal parsing validates precision, signs and full u256 overflow", () => {
  assert.equal(units("12.3400", 6), "12340000");
  assert.equal(units("0", 0), "0");
  for (const bad of ["-1", "1e3", "1.0000001", "NaN"])
    assert.throws(() => units(bad, 6));
  assert.throws(() => units((1n << 256n).toString(), 0));
  assert.equal(
    units(((1n << 256n) - 1n).toString(), 0),
    ((1n << 256n) - 1n).toString(),
  );
});
test("symbols reject invalid ByteArrays and remove bidi and control impersonation", () => {
  const short = (s) => "0x" + Buffer.from(s).toString("hex");
  assert.equal(decodeSymbol([short("USDC")]), "USDC");
  assert.equal(decodeSymbol(["0x0", short("<x>&TOKEN"), "0x9"]), "<x>&TOKEN");
  assert.equal(decodeSymbol(["0x0", short("A\u202eB"), "0x5"]), "AB");
  assert.throws(() => decodeSymbol(["0x0", "0x100", 1]));
  assert.throws(() => decodeSymbol(["0x0", "0x1", 0]));
  assert.throws(() => decodeSymbol(["0x0", "0x1", 31]));
  assert.throws(() => decodeSymbol(["0x0", "0xff", 1]));
});
test("event shapes allow mint zero addresses but reject malformed u256 limbs and NFT keys", () => {
  const mint = { ...ev(), keys: [TRANSFER, "0x0", B] };
  assert.equal(eventShape(mint).a, `0x${"0".repeat(64)}`);
  assert.equal(
    eventShape({ ...ev(), data: ["0x0", `0x${(1n << 128n).toString(16)}`] }),
    null,
  );
  assert.equal(
    eventShape({ ...ev(), keys: [TRANSFER, A, B, "0x1", "0x0"], data: [] }),
    null,
  );
});
test("a temporary metadata outage does not advance the cursor or cache a non-coin", async () => {
  const { r } = context({ events: [ev(UNKNOWN)], failure: true });
  await assert.rejects(r.scan(head), NodeBusy);
  assert.equal(r.state.cursor, 10);
  assert.equal(r.state.tokens[UNKNOWN], undefined);
  assert.equal(Object.keys(r.state.ledger).length, 0);
});
test("transactions unrelated to subscriptions need neither headers nor receipts", async () => {
  const { r, calls } = context({
    events: [{ ...ev(), keys: [TRANSFER, B, normalize("0x888")] }],
  });
  await r.scan(head);
  assert.equal(r.state.cursor, 11);
  assert.deepEqual(
    calls.map((x) => x.method),
    ["starknet_getEvents"],
  );
});
test("matching identical events without indexes preserves each receipt position", async () => {
  const events = [ev(), ev()];
  const { r } = context({ events });
  await r.scan(head);
  assert.deepEqual(r.state.ledger[`1:${HASH}`].indices, [0, 1]);
});
test("a floor suppresses alerts without suppressing seen-token discovery", async () => {
  const { r } = context();
  r.chat(1).minimums.push({ token: TOKEN, amount: "2" });
  await r.scan(head);
  assert.deepEqual(r.chat(1).seen[A], [TOKEN]);
  assert.equal(Object.keys(r.state.ledger).length, 0);
});
test("rate limit follows a user across chats and expires in message time", () => {
  const { r } = context();
  const m = (chat, date) => ({ chat: { id: chat }, from: { id: 4 }, date });
  for (let i = 0; i < 10; i++)
    assert.equal(r.limited(m((i % 2) + 1, 100 + i)), null);
  assert.match(r.limited(m(3, 111)).lines[0], /Slow down/);
  assert.deepEqual(r.limited(m(1, 112)).lines, []);
  assert.equal(r.limited(m(2, 180)), null);
});
test("migration rekeys pending deliveries and preserves existing subscriptions", () => {
  const { r } = context();
  r.chat(2).watches.push({ address: B, label: "New group", since_block: 1 });
  r.pending(1, HASH, ["one alert"], [0]);
  r.migrate(1, 2);
  assert.equal(r.state.ledger[`1:${HASH}`], undefined);
  assert.equal(r.state.ledger[`2:${HASH}`].chat, 2);
  assert.equal(r.chat(2).watches.length, 2);
  r.pending(2, HASH, ["duplicate"], [0]);
  assert.equal(Object.keys(r.state.ledger).length, 1);
});
test("large export chunks preserve JSON strings, Unicode and HTML literally", async () => {
  const { r } = context();
  const c = r.chat(1);
  c.watches = Array.from({ length: 20 }, (_, i) => ({
    address: normalize("0x" + (i + 1).toString(16)),
    label: "<&😀".repeat(8),
    since_block: 10,
  }));
  const out = await r.handle(
    {
      message: {
        message_id: 1,
        chat: { id: 1, type: "private" },
        from: { id: 1 },
        date: 100,
        text: "/export",
      },
    },
    head,
  );
  assert.ok(out.chunks.length > 1);
  const plain = out.chunks
    .map((x) => {
      assert.ok(x.length <= 4096);
      const p = parseHtml(x);
      assert.equal(p.error, undefined);
      return p.plain;
    })
    .join("");
  assert.deepEqual(JSON.parse(plain).watches, c.watches);
});
test("callback messages cannot inherit anonymous administrator authority", async () => {
  const { r } = context();
  const c = r.chat(-1);
  c.watches.push({ address: A, label: "Group", since_block: 1 });
  const button = r.button(-1, "unwatch", A, "Remove");
  const calls = [];
  r.tg = {
    async call(method) {
      calls.push(method);
      return method === "getChatMember" ? { status: "member" } : true;
    },
  };
  const response = await r.handle(
    {
      callback_query: {
        id: "q1",
        data: button.callback_data,
        from: { id: 7 },
        message: {
          chat: { id: -1, type: "supergroup" },
          sender_chat: { id: -1 },
          message_id: 5,
          date: 100,
        },
      },
    },
    head,
  );
  assert.match(response.lines[0], /administrator/);
  assert.equal(c.watches.length, 1);
  assert.ok(calls.includes("answerCallbackQuery"));
  assert.ok(!calls.includes("editMessageText"));
});

test("outbox saves before sending and resumes only unfinished chunks", async () => {
  const { r } = context();
  const snapshots = [];
  r.store.save = () => snapshots.push(JSON.parse(JSON.stringify(r.state)));
  r.pending(1, HASH, ["first"]);
  r.state.ledger[`1:${HASH}`].chunks = ["first", "second"];
  let sends = 0;
  r.tg = {
    async call(method) {
      assert.equal(method, "sendMessage");
      sends++;
      assert.ok(snapshots.length);
      if (sends === 2) throw new Error("temporary failure");
      return { message_id: sends };
    },
  };
  await assert.rejects(r.deliver(), /temporary failure/);
  const item = r.state.ledger[`1:${HASH}`];
  assert.equal(item.progress, 1);
  assert.equal(item.sent, false);
  r.tg = {
    async call() {
      sends++;
      return { message_id: sends };
    },
  };
  assert.equal(await r.deliver(), 1);
  assert.equal(item.sent, true);
  assert.equal(sends, 3);
  assert.equal(await r.deliver(), 0);
});
