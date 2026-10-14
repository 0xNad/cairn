import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { post } from '../src/http.mjs';
import { Telegram } from '../src/telegram.mjs';
import { fakeStarknet, feltOf, hex64, SEL } from '../.launchpad/checks/round-1/fake-starknet.mjs';
import { fakeTelegram } from '../.launchpad/checks/round-1/fake-telegram.mjs';

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}

test('a redirected service cannot forward credentials to another host', async () => {
  let received = 0;
  const other = await listen((req, res) => { received++; res.end('{}'); });
  const original = await listen((req, res) => { res.writeHead(307, { location: other.url }); res.end(); });
  try {
    await assert.rejects(post(original.url, { credential: 'private fixture' }, 1000, new AbortController().signal));
    assert.equal(received, 0);
  } finally { await original.close(); await other.close(); }
});

test('an accepted send with a dropped response is not automatically duplicated', async () => {
  let accepted = 0;
  const service = await listen((req) => { req.resume(); req.on('end', () => { accepted++; req.socket.destroy(); }); });
  const client = new Telegram({ api: service.url, token: 'local fixture' }, new AbortController().signal, () => {});
  try {
    await assert.rejects(client.send({ chat: { id: 1 } }, 'hello'), /Telegram unreachable/);
    assert.equal(accepted, 1);
  } finally { await service.close(); }
});

async function scenario(fn) {
  const directory = mkdtempSync(join(tmpdir(), 'cairn-edge-'));
  const token = '7'.repeat(9) + ':' + 'fixture-secret_'.repeat(3);
  const rpcSecret = 'provider-fixture-private-value';
  const tg = await fakeTelegram({ token, me: { id: 777777777, username: 'cairn_edge_bot', is_bot: true, first_name: 'Cairn' } }).listen();
  const node = await fakeStarknet().listen(`/rpc/${rpcSecret}/`);
  const address = feltOf('account'), contract = feltOf('coin'), hash = feltOf('transaction');
  const networkFile = join(directory, 'network.json');
  writeFileSync(networkFile, JSON.stringify({ chain: 'SN_MAIN', tokens: [{ symbol: 'STRK', address: hex64(contract), decimals: 18 }] }));
  const env = { ...process.env, TELEGRAM_BOT_TOKEN: token, TELEGRAM_API_ROOT: tg.url,
    STARKNET_RPC_URL: node.url, CAIRN_NETWORK_FILE: networkFile, CAIRN_DATA: join(directory, 'data'),
    CAIRN_RPC_RPS: '100', CAIRN_RPC_TIMEOUT_MS: '1000' };
  const user = tg.user(101, 'Fixture');
  const chat = tg.dm(user);
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['cairn.mjs', 'tick'], { env, cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('tick timed out')); }, 10000);
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  try { await fn({ tg, node, address, contract, hash, token, rpcSecret, env, chat, user, run }); }
  finally { await tg.close(); await node.close(); rmSync(directory, { recursive: true, force: true }); }
}

test('huge single-line reverts remain readable HTML and do not expose credentials', () => scenario(async (w) => {
  const reason = '<script>&🙂'.repeat(1800) + ' ' + w.token + ' ' + w.rpcSecret;
  w.node.tx({ hash: w.hash, block: w.node.head.number, finality: 'ACCEPTED_ON_L2', execution: 'REVERTED', fee: 1n, revert: reason });
  w.tg.say(w.chat, w.user, `/tx ${hex64(w.hash)}`);
  const result = await w.run();
  assert.equal(result.code, 0, result.stderr);
  const accepted = w.tg.to(w.chat.id);
  assert.ok(accepted.length > 1);
  assert.ok(accepted.every((m) => m.text.length <= 4096 && m.params.parse_mode === 'HTML'));
  const visible = accepted.map((m) => m.text).join('\n');
  assert.ok(visible.includes('<script>&🙂'));
  assert.ok(visible.includes('[redacted]'));
  assert.ok(!visible.includes(w.token) && !visible.includes(w.rpcSecret));
  assert.ok(!result.stdout.includes(w.token) && !result.stderr.includes(w.rpcSecret));
}));

test('balances use one accepted block even if a new block appears during the lookup', () => scenario(async (w) => {
  const original = w.node.head.number;
  w.node.contract(w.address, { calls: {} });
  w.node.contract(w.contract, { calls: { [SEL.balance_of]: (_data, block) => {
    w.node.addBlock();
    return [BigInt(block.number), 0n];
  } } });
  w.tg.say(w.chat, w.user, `/balance ${hex64(w.address)}`);
  const result = await w.run();
  assert.equal(result.code, 0, result.stderr);
  const lookups = w.node.calls.filter((call) => call.method === 'starknet_call' || call.method === 'starknet_getClassHashAt');
  assert.ok(lookups.length >= 2);
  assert.ok(lookups.every((call) => call.params.block_id.block_number === original));
  assert.ok(w.node.head.number > original);
  // A trailing slash is part of the configured RPC endpoint and must reach the server unchanged.
  assert.ok(w.node.requests.every((request) => request.path.endsWith('/')));
}));

test('a corrupt saved offset fails visibly without replaying an old reply', () => scenario(async (w) => {
  w.tg.say(w.chat, w.user, '/help');
  assert.equal((await w.run()).code, 0);
  const before = w.tg.accepted.length;
  const path = join(w.env.CAIRN_DATA, 'state.json');
  const state = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...state, offset: -1 }));
  const result = await w.run();
  assert.equal(result.code, 1);
  assert.match(result.stderr, /state is unreadable/);
  assert.equal(w.tg.accepted.length, before);
}));
