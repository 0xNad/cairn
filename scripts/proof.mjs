import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeTelegram } from '../.launchpad/checks/round-1/fake-telegram.mjs';
import { fakeStarknet, erc20, hex64 } from '../.launchpad/checks/round-1/fake-starknet.mjs';

// Every invocation preserves its inputs, HTTP exchanges, output and durable state.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const base = resolve(process.argv[2] ?? '../evidence');
assert(!base.startsWith(`${root}/`) && base !== root, 'Evidence must be outside the repository');
mkdirSync(base, { recursive: true, mode: 0o700 });
const dir = mkdtempSync(join(base, 'proof-'));
const save = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const token = ['12345678', 'proof-only-' + 'x'.repeat(30)].join(':');
const tg = await fakeTelegram({ token, me: { id: 12345678, username: 'cairn_proof_bot', is_bot: true } }).listen();
const rpc = await fakeStarknet().listen('/proof-rpc');
const user = tg.user(42, 'Example');
const chat = tg.dm(user);
rpc.contract(1n, erc20({ symbol: 'STRK', decimals: 18, balances: new Map([[2n, 2n ** 128n + 5n]]) }));
rpc.tx({ hash: 3n, block: 4200007, finality: 'ACCEPTED_ON_L2', execution: 'REVERTED', fee: 1n,
  revert: 'assert(a < b) & <contract>' });
save('network.json', { chain: 'SN_MAIN', tokens: [{ symbol: 'STRK', address: '0x1', decimals: 18 }] });
const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', TZ: 'UTC',
  TELEGRAM_BOT_TOKEN: token, TELEGRAM_API_ROOT: tg.url, STARKNET_RPC_URL: rpc.url,
  CAIRN_NETWORK_FILE: join(dir, 'network.json'), CAIRN_DATA: join(dir, 'data'),
  CAIRN_RPC_RPS: '100', CAIRN_POLL_MS: '100', CAIRN_TG_TIMEOUT: '1', CAIRN_RPC_TIMEOUT_MS: '500',
  NODE_OPTIONS: `--import=${join(root, '.launchpad/checks/round-1/trap.mjs')}`, CAIRN_TRAP_LOG: join(dir, 'network.jsonl') };
const runs = [], actions = [], children = new Set(), endpoints = [];
async function endpoint(handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    requests.push({ path: req.url, body });
    handler(req, res, body);
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const item = { server, requests, url: `http://127.0.0.1:${server.address().port}` };
  endpoints.push(item);
  return item;
}
function start(command, extra = {}) {
  const rec = { command, out: '', err: '' };
  runs.push(rec);
  const child = spawn(process.execPath, ['cairn.mjs', command], { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.stdout.on('data', b => { rec.out += b; });
  child.stderr.on('data', b => { rec.err += b; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20000);
  const exited = new Promise((ok, fail) => {
    child.once('error', fail);
    child.once('close', (code, signal) => {
      clearTimeout(timeout); children.delete(child); Object.assign(rec, { code, signal }); ok(rec);
    });
  });
  return { child, exited };
}
async function run(command, extra = {}) {
  const rec = await start(command, extra).exited;
  assert.equal(rec.code, 0, `${command}: ${rec.err}`);
  return JSON.parse(rec.out);
}
const say = text => { actions.push(tg.say(chat, user, text)); };
const pause = ms => new Promise(ok => setTimeout(ok, ms));
async function until(fn) {
  const end = Date.now() + 5000;
  while (!fn()) { assert(Date.now() < end, 'Timed out waiting for real command result'); await pause(20); }
}
let result;
try {
  assert.deepEqual(await run('doctor'), { bot: 'cairn_proof_bot', chain: 'SN_MAIN', block: 4200010, spec: '0.10.3' });
  for (const text of ['/start', '/status', '/balance 0x2', '/tx 0x3', '/tx 0x0']) say(text);
  assert.deepEqual(await run('tick'), { updates: 5, sent: 5, head: 4200010 });
  const replies = tg.to(chat.id).map(m => m.text);
  assert.match(replies[0], /On-chain facts, not financial advice\./);
  assert.match(replies[1], /2026-10-20 00:00:20 UTC/);
  assert.match(replies[2], /340282366920938463463\.374607431768211461 STRK/);
  assert.match(replies[2], /not deployed/);
  assert.match(replies[3], /assert\(a < b\) & <contract>/);
  assert.match(replies[3], /0\.000000000000000001 STRK/);
  assert.match(replies[4], /hash/i);
  assert.deepEqual(await run('tick'), { updates: 0, sent: 0, head: 4200010 });
  say('/status');
  const killed = start('tick');
  let hit = false;
  tg.onSent(() => { if (!hit) { hit = true; killed.child.kill('SIGKILL'); } });
  await killed.exited;
  assert(hit, 'Kill must happen after Telegram accepts the reply');
  assert.deepEqual(await run('tick'), { updates: 0, sent: 0, head: 4200010 });
  const live = start('run');
  await until(() => tg.holding);
  say('/status');
  await until(() => tg.accepted.length === 7);
  await until(() => tg.holding);
  live.child.kill('SIGTERM');
  assert.equal((await live.exited).code, 0);

  // Exercise long unbroken UTF-16 text and secret reflection through a real node response.
  const longReason = '🙂<&>'.repeat(2000);
  rpc.tx({ hash: 4n, block: 4200007, finality: 'ACCEPTED_ON_L2', execution: 'REVERTED', fee: 1n,
    revert: `${longReason}\n${token}\n${rpc.url}` });
  const beforeLong = tg.accepted.length;
  say('/tx 0x4');
  const long = await run('tick');
  assert.equal(long.updates, 1);
  assert(long.sent > 1);
  const pieces = tg.accepted.slice(beforeLong);
  assert(pieces.every(m => m.text.length > 0 && m.text.length <= 4096));
  const joined = pieces.map(m => m.text).join('\n');
  assert(joined.replaceAll('\n', '').includes(longReason));
  assert(!joined.includes(token) && !joined.includes(rpc.url));

  // A redirect target must receive no requests, even when an upstream asks for a 307 replay.
  const sink = await endpoint((_req, res) => { res.end('{}'); });
  const redirect = await endpoint((_req, res) => { res.writeHead(307, { location: sink.url }); res.end(); });
  for (const extra of [{ TELEGRAM_API_ROOT: redirect.url }, { STARKNET_RPC_URL: redirect.url }]) {
    const rec = await start('doctor', extra).exited;
    assert.equal(rec.code, 1);
    assert.equal(rec.out, '');
  }
  assert.equal(sink.requests.length, 0);
  assert.equal(redirect.requests.length, 2);

  // Reconnect after an unavailable startup, before any unchecked chain calls can be made.
  rpc.down(1000);
  const outage = start('run');
  await pause(1200);
  const beforeRecovery = tg.accepted.length;
  say('/status');
  await until(() => tg.accepted.length > beforeRecovery);
  if (/busy/i.test(tg.accepted.at(-1).text)) {
    await pause(100);
    say('/status');
    await until(() => tg.accepted.length > beforeRecovery + 1);
  }
  assert.match(tg.accepted.at(-1).text, /SN_MAIN.*4200010/);
  await until(() => tg.holding);
  outage.child.kill('SIGINT');
  assert.equal((await outage.exited).code, 0);
  assert.equal(tg.callsOf('setMyCommands').length, 1);
  const outputs = runs.map(r => r.out + r.err).join('') + tg.accepted.map(m => m.html).join('');
  assert(!outputs.includes(token) && !outputs.includes(rpc.url));
  for (const name of readdirSync(join(dir, 'data'))) {
    const contents = readFileSync(join(dir, 'data', name), 'utf8');
    assert(!contents.includes(token) && !contents.includes(rpc.url));
    assert(!contents.includes(longReason) && !contents.includes('Example'));
  }
  assert.deepEqual(tg.violations, []);
  assert.deepEqual(rpc.violations, []);
  result = { passed: true, checks: ['doctor', 'lookups', 'input refusal', 'restart', 'SIGKILL', 'long poll', 'SIGTERM',
    'UTF-16 splitting', 'secret reflection', 'redirect refusal', 'startup recovery', 'SIGINT', 'private state'] };
} catch (error) {
  result = { passed: false, error: error.message };
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill('SIGKILL');
  save('actions.json', actions);
  save('commands.json', runs);
  save('telegram.json', { calls: tg.calls, accepted: tg.accepted, acked: tg.acked });
  save('rpc.json', { requests: rpc.requests, calls: rpc.calls });
  save('endpoints.json', endpoints.map(({ url, requests }) => ({ url, requests })));
  save('result.json', result);
  await Promise.all([tg.close(), rpc.close(), ...endpoints.map(({ server }) => new Promise(ok => {
    server.close(ok); server.closeAllConnections();
  }))]);
}
console.log(JSON.stringify({ ...result, evidence: dir }));
