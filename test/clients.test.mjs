import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { NodeUnavailable, RpcError, rpcClient } from "../src/rpc.mjs";
import { TelegramUnreachable, telegramClient } from "../src/telegram.mjs";

// A local HTTP server that answers each request with the next of `answers`: [status, body, headers] or
// "hang" (never answers). It counts the requests it got.
async function server(answers) {
  const got = [];
  const s = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ url: req.url, body: JSON.parse(body || "{}"), at: Date.now() });
      const a = answers[Math.min(got.length - 1, answers.length - 1)];
      if (a === "hang") return;
      const [status, out, headers = {}] = typeof a === "function" ? a(got.at(-1)) : a;
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(typeof out === "string" ? out : JSON.stringify(out));
    });
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  after(() => s.closeAllConnections() || s.close());
  return { url: `http://127.0.0.1:${s.address().port}`, got };
}

const result = (value) => (req) => [200, { jsonrpc: "2.0", id: req.body.id, result: value }];
const rpcOf = (url) => rpcClient({ url, rps: 100, timeoutMs: 300 });

test("the RPC client retries 5xx and 429 (after Retry-After), then answers", async () => {
  const node = await server([[503, "busy"], [429, "slow", { "retry-after": "1" }], result("0x534e5f4d41494e")]);
  assert.equal(await rpcOf(node.url).call("starknet_chainId"), "0x534e5f4d41494e");
  assert.equal(node.got.length, 3);
  assert.ok(node.got[2].at - node.got[1].at >= 1000, "waited Retry-After");
});

test("the RPC client gives up after 3 tries, or after 1 for a probe", async () => {
  const node = await server(["hang"]);
  await assert.rejects(rpcOf(node.url).call("starknet_blockNumber"), NodeUnavailable);
  assert.equal(node.got.length, 3);
  await assert.rejects(rpcOf(node.url).call("starknet_blockNumber", {}, { tries: 1 }), /1 try/);
  assert.equal(node.got.length, 4);
});

test("a JSON-RPC error is the node's answer and a 404 a wrong URL: neither is retried", async () => {
  const node = await server([(req) => [200, { jsonrpc: "2.0", id: req.body.id, error: { code: 29, message: "Transaction hash not found" } }], [404, "not here"]]);
  await assert.rejects(rpcOf(node.url).call("starknet_getTransactionStatus"), (e) => e instanceof RpcError && e.code === 29);
  await assert.rejects(rpcOf(node.url).call("starknet_chainId"), /HTTP 404 \(check STARKNET_RPC_URL\)/);
  assert.equal(node.got.length, 2);
});

const ok = (result) => [200, { ok: true, result }];
const tgOf = (url) => telegramClient({ root: url, token: "1:x", timeoutMs: 300 });

test("a Telegram 429 waits retry_after, then the message is sent once", async () => {
  const tg = await server([[429, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } }], ok({ message_id: 1 })]);
  assert.equal(await tgOf(tg.url).send({ chat_id: 1, text: "hi" }), true);
  assert.equal(tg.got.length, 2);
  assert.ok(tg.got[1].at - tg.got[0].at >= 1000);
  assert.equal(tg.got[1].body.parse_mode, "HTML");
  assert.deepEqual(tg.got[1].body.link_preview_options, { is_disabled: true });
});

test("a message Telegram may have received is never sent again; other calls are retried", async () => {
  const tg = await server(["hang"]);
  await assert.rejects(tgOf(tg.url).send({ chat_id: 1, text: "hi" }), (e) => e instanceof TelegramUnreachable && e.maybeDelivered);
  assert.equal(tg.got.length, 1);
  await assert.rejects(tgOf(tg.url).call("getMe"), TelegramUnreachable);
  assert.equal(tg.got.length, 4);
});

test("refused HTML is sent again as plain text, and a blocked chat is skipped", async () => {
  const tg = await server([[400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities" }], ok({ message_id: 2 }), [403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }]]);
  const client = tgOf(tg.url);
  assert.equal(await client.send({ chat_id: 1, text: "<b>1 &lt; 2</b>" }), true);
  assert.equal(tg.got[1].body.text, "1 < 2");
  assert.equal(tg.got[1].body.parse_mode, undefined);
  assert.equal(await client.send({ chat_id: 2, text: "hi" }), false);
});
