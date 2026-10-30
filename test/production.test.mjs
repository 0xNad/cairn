import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { Ledger } from '../src/ledger.mjs';
import { Subscriptions } from '../src/subscriptions.mjs';
import { Network } from '../src/network.mjs';
import { Forks } from '../src/reorg.mjs';
import { hex64 } from '../src/felt.mjs';
import { fakeTelegram } from '../.launchpad/checks/round-4/fake-telegram.mjs';
import { fakeStarknet } from '../.launchpad/checks/round-4/fake-starknet.mjs';

const tip = (n, hash = `0x${(n + 100).toString(16)}`) => ({ block_number: n, block_hash: hash, timestamp: 1000 + n });
function state(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cairn-production-'));
  const store = new Store(directory), ledger = new Ledger(store), config = { maxWatches: 20, stallSeconds: 2, operatorChat: null };
  const subs = new Subscriptions(store, config), network = new Network({ store, ledger, subs, config });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.transaction(() => subs.network({ id: 1, type: 'private' }, true));
  return { store, ledger, network };
}

test('same-height replacement resets the stall clock, survives restart and can itself stall', (t) => {
  const { store, ledger, network } = state(t);
  network.observe(tip(10, '0x1'), { now: 1000 });
  assert.equal(network.stalling(tip(10, '0x2'), 4000), false);
  network.observe(tip(10, '0x2'), { now: 4000 });
  assert.equal(network.stall, null);
  assert.equal(network.seen.at, 4000);
  assert.equal(network.seen.hash, hex64('0x2'));
  const restored = new Network({ store, ledger, subs: network.subs, config: network.config });
  restored.observe(tip(10, '0X02'), { now: 5999 });
  assert.equal(restored.stall, null, 'alternate hex spelling is the same hash');
  restored.observe(tip(10, '0x2'), { now: 6000 });
  assert.equal(restored.stall.at, 4000);
  assert.equal(ledger.pending().length, 1);
});

test('replacement ends a sent stall once, while a lagging endpoint never resets the clock', (t) => {
  const { store, ledger, network } = state(t);
  network.observe(tip(10, '0x1'), { now: 0 });
  network.observe(tip(9), { now: 1500 });
  assert.equal(network.seen.at, 0);
  network.observe(tip(10, '0x1'), { now: 2000 });
  const first = ledger.pending()[0];
  store.transaction(() => ledger.sent(first.seq, 100));
  network.observe(tip(10, '0x2'), { now: 3000 });
  network.observe(tip(10, '0x2'), { now: 3500 });
  assert.equal(network.stall, null);
  assert.equal(ledger.pending().length, 1, 'one recovery only');
  assert.match(ledger.pending()[0].body, /producing blocks again/);
});

test('legacy head state learns its hash without declaring an immediate stale stall', (t) => {
  const { store, network } = state(t);
  store.transaction(() => store.setJson('head_seen', { n: 10, at: 0, t: 1010 }));
  network.observe(tip(10), { now: 5000 });
  assert.equal(network.seen.at, 5000);
  assert.equal(network.stall, null);
});

test('wide scans retain the whole bounded window and find an actual in-window ancestor', async (t) => {
  const { store } = state(t), calls = [], hashes = new Map();
  const rpc = { async call(_, { block_id: { block_number: n } }) {
    calls.push(n); return { block_hash: hashes.get(n) ?? tip(n).block_hash, timestamp: 1000 + n };
  } };
  const forks = new Forks(store, rpc, { reorgDepth: 8 });
  const history = await forks.history(1, 500, tip(500));
  assert.deepEqual(calls, [493, 494, 495, 496, 497, 498, 499]);
  store.transaction(() => { for (const b of history) forks.remember(b); store.cursor = 500; });
  assert.deepEqual(store.sql('SELECT number FROM blocks ORDER BY number').all().map(b => b.number), [493, 494, 495, 496, 497, 498, 499, 500]);
  for (let n = 497; n <= 500; n++) hashes.set(n, '0xff');
  assert.deepEqual(await forks.check(500, tip(501)), { from: 500, hash: hex64('0xff'), ancestor: 496, deep: false });
  const next = await forks.history(501, 501, tip(503));
  assert.deepEqual(next.map(b => b.number), [501], 'confirmation-safe history stops at the scan end');
});

test('real tick retains a catch-up window and never commits a range with a failed retained header', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'cairn-catchup-'));
  const token = ['123456', 'fixture-only-not-a-real-credential-0000'].join(':');
  const tg = await fakeTelegram({ token, me: { id: 123456, is_bot: true, username: 'fixture_bot' } }).listen();
  const node = await fakeStarknet({ first: 0, head: 10 }).listen();
  t.after(async () => { await Promise.all([tg.close(), node.close()]); rmSync(scratch, { recursive: true, force: true }); });
  const networkFile = join(scratch, 'network.json'), data = join(scratch, 'data');
  writeFileSync(networkFile, JSON.stringify({ chain: 'SN_MAIN', tokens: [{ symbol: 'TEST', address: '0x1', decimals: 0 }] }));
  const env = { PATH: process.env.PATH, TELEGRAM_BOT_TOKEN: token, TELEGRAM_API_ROOT: tg.url, STARKNET_RPC_URL: node.url,
    CAIRN_NETWORK_FILE: networkFile, CAIRN_DATA: data, CAIRN_RPC_RPS: '100', CAIRN_REORG_DEPTH: '8', CAIRN_LOG: 'error' };
  const tick = async () => JSON.parse((await promisify(execFile)(process.execPath, ['cairn.mjs', 'tick'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env, timeout: 15000,
  })).stdout);
  await tick();
  for (let n = 0; n < 100; n++) node.addBlock();
  assert.equal((await tick()).cursor, 110);
  let store = new Store(data);
  assert.deepEqual(store.sql('SELECT number FROM blocks ORDER BY number').all().map(b => b.number), [103, 104, 105, 106, 107, 108, 109, 110]);
  store.close();
  for (let n = 0; n < 10; n++) node.addBlock();
  node.fail({ when: ({ method, params }) => method === 'starknet_getBlockWithTxHashes' && params.block_id?.block_number === 115,
    rpcError: { code: 24, message: 'Block not found' }, times: 1 });
  assert.equal((await tick()).cursor, 110, 'failed window read cannot advance the cursor');
  store = new Store(data);
  assert.equal(store.sql('SELECT MAX(number) AS n FROM blocks').get().n, 110);
  store.close();
  assert.equal((await tick()).cursor, 120, 'the next pass retries the complete range');
});
