import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { linkSync, mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Rpc, Telegram } from '../src/transport.mjs';
import { NodeBusy, CairnError } from '../src/errors.mjs';
import { Store } from '../src/store.mjs';
import { normalize, FIELD, u256, decodeChain } from '../src/felt.mjs';
import { amount, messages, redactor, textLines } from '../src/format.mjs';
import { parseHtml } from '../.launchpad/checks/round-1/fake-telegram.mjs';
import { answer } from '../src/commands.mjs';

async function server(t, handler) {
  const http = createServer(handler);
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  t.after(() => { http.closeAllConnections(); http.close(); });
  return `http://127.0.0.1:${http.address().port}`;
}
const config = (url) => ({ rpcUrl: url, rpcRps: 100, rpcTimeout: 100, telegramRoot: url, token: `12:${'x'.repeat(30)}` });

test('a file configured as CAIRN_DATA is refused before contacting either host', async (t) => {
  let requests = 0;
  const tg = await server(t, (_, res) => { requests++; res.end(JSON.stringify({ ok: true, result: { username: 'edge_bot' } })); });
  const rpc = await server(t, (req, res) => {
    requests++;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const { id, method } = JSON.parse(body);
      const result = method === 'starknet_chainId' ? '0x534e5f4d41494e' : '0.10.3';
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  const directory = mkdtempSync(join(tmpdir(), 'cairn-data-file-'));
  const file = join(directory, 'keep.txt');
  writeFileSync(file, 'preserve');
  let failure;
  try {
    await promisify(execFile)(process.execPath, ['cairn.mjs', 'tick'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { PATH: process.env.PATH, TMPDIR: tmpdir(), TELEGRAM_BOT_TOKEN: config(tg).token,
        TELEGRAM_API_ROOT: tg, STARKNET_RPC_URL: rpc, CAIRN_DATA: file }, timeout: 5000,
    });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, 2);
  assert.equal(failure.stdout, '');
  assert.match(failure.stderr, /CAIRN_DATA/);
  assert.equal(requests, 0);
  assert.equal(readFileSync(file, 'utf8'), 'preserve');
});

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

test('RPC refuses malformed block identifiers before HTTP', async (t) => {
  let contacted = 0;
  const url = await server(t, (_, res) => { contacted++; res.end('{}'); });
  const client = new Rpc(config(url), new AbortController().signal);
  for (const block_id of [{ block_number: -1 }, { block_number: 1, block_hash: '0x1' },
    { block_number: 1, tag: 'pending' }, { block_hash: 'garbage' }, { block_hash: '0x0' }]) {
    await assert.rejects(client.call('starknet_getBlockWithTxHashes', { block_id }), CairnError);
  }
  assert.equal(contacted, 0);
});

test('balance snapshot: advancing head', async (t) => {
  let latest = 42;
  const url = await server(t, (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      const block = params.block_id === 'latest' ? latest++ : params.block_id.block_number;
      const result = method === 'starknet_call' ? [`0x${block.toString(16)}`, '0x0'] : '0x1';
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  const c = { ...config(url), chain: 'SN_MAIN', explorer: 'https://explorer.example',
    tokens: [{ symbol: 'A', address: normalize('0x1'), decimals: 0 },
      { symbol: 'B', address: normalize('0x2'), decimals: 0 }] };
  const signal = new AbortController().signal;
  const lines = await answer({ name: 'balance', argument: '0x123' }, {
    config: c, rpc: new Rpc(c, signal), clean: String, head: { block_number: 42, timestamp: 1791849600 }, signal,
  });
  const plain = lines.map((line) => parseHtml(line).plain).join('\n');
  assert.match(plain, /42 A/);
  assert.match(plain, /42 B/);
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
    first.transaction(() => { first.offset = 123; });
    assert.throws(() => new Store(directory), /instance is running/i);
  } finally { first.close(); }
  const reopened = new Store(directory);
  try { assert.equal(reopened.offset, 123); } finally { reopened.close(); }
});

test('state rejects corruption instead of replaying old updates', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cairn-corrupt-'));
  writeFileSync(join(directory, 'state.json'), '{broken');
  assert.throws(() => new Store(directory), /state.json is invalid/);
  const other = mkdtempSync(join(tmpdir(), 'cairn-corrupt-db-'));
  writeFileSync(join(other, 'state.db'), 'not a database, but not empty either'.repeat(40));
  assert.throws(() => new Store(other), /state.db is invalid/);
});

test("round 1's state.json is carried over once, then removed", () => {
  const directory = mkdtempSync(join(tmpdir(), 'cairn-upgrade-'));
  writeFileSync(join(directory, 'state.json'), JSON.stringify({ version: 1, offset: 4242, commands: '[]' }), { mode: 0o600 });
  const store = new Store(directory);
  try {
    assert.equal(store.offset, 4242);
    assert.equal(store.get('commands'), '[]');
    assert.equal(store.cursor, null);
  } finally { store.close(); }
  assert.throws(() => statSync(join(directory, 'state.json')), { code: 'ENOENT' });
  const again = new Store(directory);
  try { assert.equal(again.offset, 4242); } finally { again.close(); }
});

test('state refuses a symlink without modifying its target', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cairn-symlink-'));
  const target = join(directory, 'target');
  writeFileSync(target, 'preserve');
  symlinkSync(target, join(directory, 'state.json'));
  assert.throws(() => new Store(directory), /state.json is invalid/);
  assert.equal(readFileSync(target, 'utf8'), 'preserve');
});

test('state refuses hard links without changing data or permissions outside CAIRN_DATA', () => {
  for (const file of ['state.json', 'instance.sqlite', 'state.db']) {
    const root = mkdtempSync(join(tmpdir(), 'cairn-hardlink-'));
    const target = join(root, 'outside');
    writeFileSync(target, '{"version":1,"offset":0,"commands":null}', { mode: 0o644 });
    const directory = join(root, 'data');
    // Create the directory through the real store, then insert the hostile directory entry.
    const initial = new Store(directory);
    initial.close();
    if (file === 'instance.sqlite') {
      // The existing lock is intentionally retained; link an outside name to that inode instead.
      const lock = join(directory, file);
      linkSync(lock, join(root, 'outside-lock'));
      assert.throws(() => new Store(directory), /instance lock/);
      continue;
    }
    if (file === 'state.db') unlinkSync(join(directory, file));
    linkSync(target, join(directory, file));
    const original = readFileSync(target, 'utf8'), mode = statSync(target).mode;
    assert.throws(() => new Store(directory), file === 'state.json' ? /state.json is invalid/ : /Unsafe CAIRN_DATA state.db/);
    assert.equal(readFileSync(target, 'utf8'), original);
    assert.equal(statSync(target).mode, mode);
  }
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
