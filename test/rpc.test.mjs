import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createLogger } from "../src/log.mjs";
import { NodeUnavailable, Rpc, RpcError } from "../src/rpc.mjs";

const log = createLogger({ level: "error", write: () => {} });

async function serve(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ at: Date.now(), body: JSON.parse(body), headers: req.headers });
      handler(requests.length, res);
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return { requests, url: `http://user:pw@127.0.0.1:${server.address().port}/key`, close: () => server.close() };
}
const answer = (res, body, status = 200, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

test("retries a 503, then succeeds; credentials in the URL become Basic auth", async () => {
  const s = await serve((n, res) => (n === 1 ? answer(res, "x", 503) : answer(res, { jsonrpc: "2.0", id: 1, result: "0.10.3" })));
  const rpc = new Rpc({ url: s.url, rps: 100, timeoutMs: 1000, log });
  assert.equal(await rpc.specVersion(), "0.10.3");
  assert.equal(s.requests.length, 2);
  assert.match(s.requests[0].headers.authorization, /^Basic /);
  s.close();
});

test("a JSON-RPC error is not retried and carries its code", async () => {
  const s = await serve((n, res) => answer(res, { jsonrpc: "2.0", id: 1, error: { code: 21, message: "no entrypoint" } }));
  const rpc = new Rpc({ url: s.url, rps: 100, timeoutMs: 1000, log });
  await assert.rejects(rpc.chainId(), (e) => e instanceof RpcError && e.code === 21);
  assert.equal(s.requests.length, 1);
  s.close();
});

test("three failures are NodeUnavailable", async () => {
  const s = await serve((n, res) => answer(res, "x", 500));
  const rpc = new Rpc({ url: s.url, rps: 100, timeoutMs: 1000, log });
  await assert.rejects(rpc.chainId(), NodeUnavailable);
  assert.equal(s.requests.length, 3);
  s.close();
});

test("never more than rps calls begin in one second", async () => {
  const s = await serve((n, res) => answer(res, { jsonrpc: "2.0", id: 1, result: "0x1" }));
  const rpc = new Rpc({ url: s.url, rps: 2, timeoutMs: 1000, log });
  await Promise.all([1, 2, 3, 4, 5].map(() => rpc.chainId()));
  const at = s.requests.map((r) => r.at);
  for (let i = 2; i < at.length; i++) assert.ok(at[i] - at[i - 2] >= 950, `${i}: ${at[i] - at[i - 2]}`);
  s.close();
});
