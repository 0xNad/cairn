import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rpc, Telegram } from '../src/transport.mjs';
import { NodeBusy, CairnError } from '../src/errors.mjs';
import { Store } from '../src/store.mjs';
import { normalize, FIELD, u256, decodeChain } from '../src/felt.mjs';
import { amount, messages, redactor, textLines } from '../src/format.mjs';
import { parseHtml } from '../.launchpad/checks/round-1/fake-telegram.mjs';

async function server(t, handler) {
  const http = createServer(handler);
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(() => { http.closeAllConnections(); http.close(); });
  return `http://127.0.0.1:${http.address().port}`;
}
const config = (url) => ({ rpcUrl: url, rpcRps: 100, rpcTimeout: 100, telegramRoot: url, token: `12:${'x'.repeat(30)}` });

test('RPC rejects redirects without contacting the destination', async (t) => {
  let contacted = 0;
  const destination = await server(t, (_, res) => { contacted++; res.end('{}'); });
  const origin = await server(t, (_, res) => { res.writeHead(302, { location: destination }); res.end(); });
  const client = new Rpc(config(origin), new AbortController().signal);
  await assert.rejects(client.call('starknet_blockNumber'), NodeBusy);
  assert.equal(contacted, 0);
});

test('RPC refuses write methods and speculative blocks before HTTP', async (t) => {
  let contacted = 0;
  const url = await server(t, (_, res) => { contacted++; res.end('{}'); });
  const client = new Rpc(config(url), new AbortController().signal);
  await assert.rejects(client.call('starknet_addInvokeTransaction'), CairnError);
  await assert.rejects(client.call('starknet_getBlockWithTxHashes', { block_id: 'pending' }), CairnError);
  await assert.rejects(client.call('starknet_getBlockWithTxHashes', { block_id: 'pre_confirmed' }), CairnError);
  assert.equal(contacted, 0);
});

test('a connection lost during send is never resent', async (t) => {
  let sends = 0;
  const url = await server(t, (req) => { sends++; req.socket.destroy(); });
  const client = new Telegram(config(url), new AbortController().signal);
  await assert.rejects(client.call('sendMessage', { chat_id: 1, text: 'example' }), /Telegram unreachable/);
  assert.equal(sends, 1);
});

test('an ambiguous HTTP 500 during send is never resent', async (t) => {
  let sends = 0;
  const url = await server(t, (_, res) => { sends++; res.writeHead(500); res.end('{}'); });
  const client = new Telegram(config(url), new AbortController().signal);
  await assert.rejects(client.call('sendMessage', { chat_id: 1, text: 'example' }));
  assert.equal(sends, 1);
});

test('shutdown interrupts an RPC Retry-After wait', async (t) => {
  let reached;
  const request = new Promise((resolve) => { reached = resolve; });
  const url = await server(t, (_, res) => { res.writeHead(429, { 'retry-after': '60' }); res.end('{}'); reached(); });
  const abort = new AbortController();
  const client = new Rpc(config(url), abort.signal);
  const result = client.call('starknet_blockNumber');
  await request;
  abort.abort();
  await assert.rejects(result);
});

test('a valid timeout above the native timer range still permits a fast RPC reply', async (t) => {
  const url = await server(t, (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const { id } = JSON.parse(body);
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: 42 }));
    });
  });
  const client = new Rpc({ ...config(url), rpcTimeout: 4294967296 }, new AbortController().signal);
  assert.equal(await client.call('starknet_blockNumber'), 42);
});

test('state excludes concurrent owners and preserves a durable offset', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cairn-store-'));
  const first = new Store(directory);
  try {
    first.state.offset = 123;
    first.save();
    assert.throws(() => new Store(directory), /instance is running/i);
  } finally { first.close(); }
  const reopened = new Store(directory);
  try { assert.equal(reopened.state.offset, 123); } finally { reopened.close(); }
});

test('state rejects corruption instead of replaying old updates', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cairn-corrupt-'));
  writeFileSync(join(directory, 'state.json'), '{broken');
  assert.throws(() => new Store(directory), /state.json is invalid/);
});

test('state refuses a symlink without modifying its target', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cairn-symlink-'));
  const target = join(directory, 'target');
  writeFileSync(target, 'preserve');
  symlinkSync(target, join(directory, 'state.json'));
  assert.throws(() => new Store(directory), /state.json is invalid/);
  assert.equal(readFileSync(target, 'utf8'), 'preserve');
});

test('exact amounts include zero decimals, 36 decimals and the full u256 range', () => {
  const maximum = (1n << 256n) - 1n;
  assert.equal(u256([`0x${((1n << 128n) - 1n).toString(16)}`, `0x${((1n << 128n) - 1n).toString(16)}`]), maximum);
  assert.equal(amount(1234n, 0, 'T'), '1,234 T');
  assert.equal(amount(1n, 36, 'T'), `0.${'0'.repeat(35)}1 T`);
  assert.throws(() => u256(['0x0', `0x${(1n << 128n).toString(16)}`]));
  assert.throws(() => normalize(`0x${FIELD.toString(16)}`, 'hash'));
  assert.throws(() => normalize(`0x${((1n << 251n) - 256n).toString(16)}`));
});

test('chain decoding rejects high-bit bytes instead of aliasing an ASCII chain', () => {
  assert.equal(decodeChain('0x534e5f4d41494e'), 'SN_MAIN');
  assert.equal(decodeChain('0xd34e5f4d41494e'), 'unknown chain');
});

test('long untrusted text splits into valid HTML without cutting entities or emoji', () => {
  const source = '<&>"😀'.repeat(2500);
  const chunks = messages(textLines(source, String));
  assert.ok(chunks.length > 1);
  const decoded = chunks.map((html) => {
    assert.ok(html.length <= 4096);
    const parsed = parseHtml(html);
    assert.equal(parsed.error, undefined);
    return parsed.plain;
  }).join('').replaceAll('\n', '');
  assert.equal(decoded, source);
});

test('reflected credentials are removed before a message is encoded', () => {
  const c = config('https://node.example/private-secret?key=query-secret');
  const clean = redactor(c);
  const outside = `${c.token} ${c.rpcUrl} private-secret query-secret ${encodeURIComponent(c.token)}`;
  const html = messages(textLines(outside, clean)).join('\n');
  for (const secret of [c.token, c.rpcUrl, 'private-secret', 'query-secret', c.token.split(':')[1]]) assert.ok(!html.includes(secret));
});
