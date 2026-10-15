import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { post } from '../src/http.mjs';
import { Telegram } from '../src/telegram.mjs';
import { fakeStarknet, erc20, feltOf, hex64, SEL } from '../.launchpad/checks/round-1/fake-starknet.mjs';
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

async function scenario(fn, { holdMs = 1000, chainId } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'cairn-edge-'));
  const token = '7'.repeat(9) + ':' + 'fixture-secret_'.repeat(3);
  const rpcSecret = 'provider-fixture-private-value';
  const tg = await fakeTelegram({ token, holdMs, me: { id: 777777777, username: 'cairn_edge_bot', is_bot: true, first_name: 'Cairn' } }).listen();
  const node = await fakeStarknet({ ...(chainId ? { chainId } : {}) }).listen(`/rpc/${rpcSecret}/`);
  const address = feltOf('account'), contract = feltOf('coin'), hash = feltOf('transaction');
  const networkFile = join(directory, 'network.json');
  writeFileSync(networkFile, JSON.stringify({ chain: 'SN_MAIN', tokens: [{ symbol: 'STRK', address: hex64(contract), decimals: 18 }] }));
  const env = { PATH: process.env.PATH, HOME: directory, TMPDIR: directory, TELEGRAM_BOT_TOKEN: token, TELEGRAM_API_ROOT: tg.url,
    STARKNET_RPC_URL: node.url, CAIRN_NETWORK_FILE: networkFile, CAIRN_DATA: join(directory, 'data'),
    CAIRN_RPC_RPS: '100', CAIRN_RPC_TIMEOUT_MS: '1000' };
  const user = tg.user(101, 'Fixture');
  const chat = tg.dm(user);
  const run = (command = 'tick') => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['cairn.mjs', command], { env, cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('tick timed out')); }, 10000);
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  const bots = [];
  const start = (extra = {}) => {
    const child = spawn(process.execPath, ['cairn.mjs', 'run'], { env: { ...env, ...extra }, cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exit = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stderr })));
    const bot = { child, exit, stderr: () => stderr };
    bots.push(bot);
    return bot;
  };
  try { await fn({ tg, node, address, contract, hash, token, rpcSecret, env, chat, user, run, start }); }
  finally {
    for (const bot of bots) {
      bot.child.kill('SIGKILL');
      await bot.exit;
    }
    await tg.close(); await node.close(); rmSync(directory, { recursive: true, force: true });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, timeout = 3000) {
  const deadline = performance.now() + timeout;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('Expected event did not arrive in time.');
    await sleep(10);
  }
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

test('a command arriving after an empty long poll is answered within three seconds at the default poll interval', () => scenario(async (w) => {
  w.start();
  await until(() => w.tg.holding);
  await sleep(250);
  w.tg.say(w.chat, w.user, '/help');
  await until(() => w.tg.to(w.chat.id).length > 0);
  assert.match(w.tg.to(w.chat.id)[0].text, /On-chain facts/);
}, { holdMs: 200 }));

test('help and invalid input are answered without waiting for a slow node at startup', () => scenario(async (w) => {
  w.node.fail({ when: () => true, delayMs: 5000, times: 100 });
  w.tg.say(w.chat, w.user, '/help');
  w.tg.say(w.chat, w.user, '/balance not-an-address');
  const bot = w.start({ CAIRN_RPC_TIMEOUT_MS: '10000' });
  await until(() => w.tg.to(w.chat.id).length === 2);
  assert.match(w.tg.to(w.chat.id)[0].text, /On-chain facts/);
  assert.match(w.tg.to(w.chat.id)[1].text, /Invalid address/);
  assert.equal(w.node.callsOf('starknet_getClassHashAt').length, 0);
  bot.child.kill('SIGTERM');
  const result = await Promise.race([bot.exit, sleep(3000).then(() => null)]);
  assert.equal(result?.code, 0, result?.stderr);
}));

test('a chain lookup gets a busy reply while the node is slow and succeeds after it recovers', () => scenario(async (w) => {
  w.node.fail({ when: (call) => call.method === 'starknet_getBlockWithTxHashes', delayMs: 4000, times: 1 });
  w.tg.say(w.chat, w.user, '/status');
  const bot = w.start({ CAIRN_RPC_TIMEOUT_MS: '10000' });
  await until(() => w.tg.to(w.chat.id).length === 1);
  assert.match(w.tg.to(w.chat.id)[0].text, /Node busy/);
  await sleep(4200);
  w.tg.say(w.chat, w.user, '/status');
  await until(() => w.tg.to(w.chat.id).length === 2);
  assert.match(w.tg.to(w.chat.id)[1].text, /SN_MAIN/);
  bot.child.kill('SIGTERM');
  assert.equal((await bot.exit).code, 0);
}));

test('short polling remains responsive with a large chain-poll interval', () => scenario(async (w) => {
  w.start({ CAIRN_TG_TIMEOUT: '0', CAIRN_POLL_MS: '10000' });
  await until(() => w.tg.callsOf('getUpdates').length > 0);
  await sleep(50);
  w.tg.say(w.chat, w.user, '/help');
  await until(() => w.tg.to(w.chat.id).length === 1);
  assert.match(w.tg.to(w.chat.id)[0].text, /On-chain facts/);
}));

test('run promptly refuses an incompatible chain even while waiting for Telegram updates', () => scenario(async (w) => {
  const bot = w.start();
  const result = await Promise.race([bot.exit, sleep(3000).then(() => null)]);
  assert.equal(result?.code, 2, result?.stderr);
  assert.match(result.stderr, /SN_SEPOLIA/);
}, { chainId: '0x534e5f5345504f4c4941' }));

test('overlapping ticks cannot both answer an update while the first is waiting for a token lookup', () => scenario(async (w) => {
  w.node.contract(w.address, { calls: {} });
  w.node.contract(w.contract, erc20({symbol:'STRK',decimals:18,balances:new Map([[w.address,10n**18n]])}));
  w.node.fail({ when: (call) => call.method === 'starknet_call', delayMs: 1800, times: 1 });
  w.tg.say(w.chat,w.user,`/balance ${hex64(w.address)}`);
  const first=w.run();
  await until(()=>w.node.requests.some((request)=>JSON.parse(request.body).method==='starknet_call'));
  const second=await w.run();
  assert.equal(second.code,1,second.stderr);
  assert.match(second.stderr,/another.*instance/i);
  assert.equal((await first).code,0);
  assert.equal(w.tg.to(w.chat.id).length,1);
}));

test('a SIGKILL releases the local instance lock so the next tick can answer new commands', () => scenario(async (w) => {
  const bot=w.start();
  await until(()=>w.tg.holding);
  // A read-only doctor remains available while the polling instance owns the data directory.
  assert.equal((await w.run('doctor')).code,0);
  bot.child.kill('SIGKILL');
  await bot.exit;
  w.tg.say(w.chat,w.user,'/help');
  const tick=await w.run();
  assert.equal(tick.code,0,tick.stderr);
  assert.equal(w.tg.to(w.chat.id).length,1);
}));

test('a dangling instance-lock symlink is refused without creating a file outside CAIRN_DATA', () => scenario(async (w) => {
  assert.equal((await w.run()).code,0);
  const outside=join(w.env.HOME,'outside-lock.db');
  const lock=join(w.env.CAIRN_DATA,'instance.db');
  unlinkSync(lock);
  symlinkSync(outside,lock);
  const result=await w.run();
  assert.equal(result.code,1,result.stderr);
  assert.equal(existsSync(outside),false);
}));
