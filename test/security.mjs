import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { Telegram, Rpc } from '../src/transport.mjs';
import { Commands } from '../src/commands.mjs';
import { normalize, messages, textLines } from '../src/format.mjs';

// Synthetic configuration; no real token or RPC credential is needed.
const env = () => ({ TELEGRAM_BOT_TOKEN: '1:' + 'x'.repeat(30), STARKNET_RPC_URL: 'https://rpc.example/provider-secret?key=query-secret' });

test('configuration rejects extra URL authority, fragments and malformed log/explorer settings', () => {
  for (const overrides of [
    { TELEGRAM_API_ROOT: 'https://user:pass@api.example' },
    { STARKNET_RPC_URL: 'https://user:pass@rpc.example' },
    { STARKNET_RPC_URL: 'https://rpc.example/#secret' },
    { TELEGRAM_API_ROOT: 'https://api.example/?key=x' },
    { CAIRN_LOG: 'trace' }, { CAIRN_EXPLORER_URL: 'javascript:alert(1)' }
  ]) assert.throws(() => loadConfig({ ...env(), ...overrides }), { exitCode: 2 });
});

test('Starknet boundaries and long Unicode HTML remain exact', () => {
  assert.equal(normalize('0xA'), '0x' + 'a'.padStart(64, '0'));
  assert.throws(() => normalize('0x' + (2n ** 251n - 256n).toString(16)));
  assert.throws(() => normalize('0x' + (2n ** 251n + 17n * 2n ** 192n + 1n).toString(16), 'hash'));
  const parts = messages(textLines(('💎<&>"'.repeat(3000))));
  assert(parts.length > 1);
  assert(parts.every((p) => p.length <= 4096 && !/[\uD800-\uDBFF]$/.test(p)));
  assert(parts.every((p) => !/&(?:a|am|amp|l|lt|g|gt|q|qu|quo|quot)$/.test(p)));
});

test('durable claims survive reopen; simultaneous instances and symlink escapes fail closed', () => {
  const base = mkdtempSync(join(tmpdir(), 'cairn-security-'));
  let store;
  try {
    const data = join(base, 'data');
    store = new Store(data, 1);
    assert.equal(store.claim(10), true);
    assert.throws(() => new Store(data, 1), /another instance/);
    store.close();
    store = new Store(data, 1);
    assert.equal(store.claim(10), false);
    assert.equal(store.claim(11), true);
    assert.equal(JSON.parse(readFileSync(join(data, 'state.json'))).offset, 12);
    store.close();
    assert.throws(() => new Store(data, 2), /another bot/);
    symlinkSync(data, join(base, 'escape'));
    assert.throws(() => new Store(join(base, 'escape'), 1), /symbolic links/);
    assert.deepEqual(readdirSync(data), ['state.json']);
  } finally { store?.close(); rmSync(base, { recursive: true, force: true }); }
});

test('transport refuses redirects without contacting their destination', async () => {
  let hits = 0;
  const destination = createServer((req, res) => { hits++; res.end('{}'); });
  const redirect = createServer((req, res) => {
    res.writeHead(307, { location: `http://127.0.0.1:${destination.address().port}/stolen` });
    res.end();
  });
  await new Promise((r) => destination.listen(0, '127.0.0.1', r));
  await new Promise((r) => redirect.listen(0, '127.0.0.1', r));
  try {
    const config = loadConfig({ ...env(), TELEGRAM_API_ROOT: `http://127.0.0.1:${redirect.address().port}`, STARKNET_RPC_URL: `http://127.0.0.1:${redirect.address().port}/rpc` });
    const signal = new AbortController().signal;
    await assert.rejects(new Telegram(config, signal).call('getMe'), /Telegram unreachable/);
    await assert.rejects(new Rpc(config, signal).call('starknet_chainId'), /node busy/);
    assert.equal(hits, 0);
  } finally {
    redirect.closeAllConnections(); destination.closeAllConnections();
    await Promise.all([new Promise((r) => redirect.close(r)), new Promise((r) => destination.close(r))]);
  }
});

test('a reflected RPC credential is redacted before a revert message is formatted', async () => {
  const config = loadConfig(env());
  const rpc = { call: async (method) => method.endsWith('Status') ? { finality_status: 'ACCEPTED_ON_L2', execution_status: 'REVERTED' } : {
    block_number: 42, actual_fee: { amount: '0x1', unit: 'FRI' }, revert_reason: config.rpcUrl + ' <outside>'
  } };
  const lines = await new Commands(config, rpc, 'cairn_bot').transaction(normalize('0x1', 'hash'));
  assert(!lines.join('\n').includes('provider-secret'));
  assert(!lines.join('\n').includes('query-secret'));
  assert(lines.join('\n').includes('&lt;outside&gt;'));
});

test('SIGTERM-style cancellation interrupts RPC retries promptly', async () => {
  const server = createServer((req, res) => { res.writeHead(503, { 'retry-after': '60' }); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const controller = new AbortController();
  const config = loadConfig({ ...env(), STARKNET_RPC_URL: `http://127.0.0.1:${server.address().port}/rpc` });
  const pending = new Rpc(config, controller.signal).call('starknet_chainId');
  const timer = setTimeout(() => controller.abort(), 100);
  const start = performance.now();
  try {
    await assert.rejects(pending);
    assert(performance.now() - start < 1000);
  } finally { clearTimeout(timer); server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});
