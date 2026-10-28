import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { EndpointLost } from '../src/errors.mjs';
import { hex64 } from '../src/felt.mjs';
import { holdsListedLink, holdsSeed, linkHosts, parseBlocklist, seedRun, warning } from '../src/guard.mjs';
import { prometheus } from '../src/http.mjs';
import { CORRECTION, Ledger } from '../src/ledger.mjs';
import { duration, NetworkWatch, noticeText } from '../src/network.mjs';
import { Blocks, findFork } from '../src/reorg.mjs';
import { Store } from '../src/store.mjs';
import { Subscriptions } from '../src/subscriptions.mjs';
import { Rpc } from '../src/transport.mjs';

const WORDS = readFileSync(new URL('../wordlists/bip39-english.txt', import.meta.url), 'utf8').trim().split('\n');
const phrase = (n, from = 100) => WORDS.slice(from, from + n).join(' ');
const env = { TELEGRAM_BOT_TOKEN: `123456:${'x'.repeat(36)}`, STARKNET_RPC_URL: 'https://rpc.example/key', CAIRN_DATA: tmpdir() };
function fresh() {
  const directory = mkdtempSync(join(tmpdir(), 'cairn-r4-'));
  const store = new Store(directory);
  return { directory, store, subs: new Subscriptions(store, { maxWatches: 20 }), ledger: new Ledger(store) };
}

test('the word list is BIP-39 English, 2048 words in order', () => {
  assert.equal(WORDS.length, 2048);
  assert.deepEqual([WORDS[0], WORDS[2047]], ['abandon', 'zoo']);
  assert.deepEqual([...WORDS].sort(), WORDS);
});

test('the seed guard catches runs of 12 or more words, numbered or cased, and nothing shorter', () => {
  for (const n of [12, 15, 18, 21, 24]) assert.ok(holdsSeed(phrase(n)), `${n} words`);
  assert.ok(holdsSeed(`My backup: ${phrase(12).toUpperCase()}. Is it safe?`));
  assert.ok(holdsSeed(phrase(12).split(' ').map((w, i) => `${i + 1}. ${w}`).join('\n')), 'a numbered list');
  assert.ok(holdsSeed(phrase(12).split(' ').join(', ')), 'comma separated');
  assert.ok(!holdsSeed(phrase(11)));
  assert.ok(!holdsSeed(`${phrase(6)} notaword ${phrase(6, 300)}`));
  assert.ok(!holdsSeed(`${phrase(6)} 123 ${phrase(6, 300)}`), 'a long number is a word that breaks the run');
  assert.ok(seedRun('The quick brown fox jumps over the lazy dog, and then it sleeps in the sun all day long.') < 12);
  assert.ok(!holdsSeed('Please help us check this ordinary project status before the next release window opens.'));
});

test('the link guard matches a listed host and its subdomains, never lookalikes, paths or userinfo', () => {
  const list = parseBlocklist('# comment\nStarknet-Bot.com\n\nscam.example.org  # trailing comment\n').domains;
  assert.deepEqual(list, ['starknet-bot.com', 'scam.example.org']);
  for (const text of ['https://starknet-bot.com/drop', 'HTTP://STARKNET-BOT.COM', 'claim at claim.starknet-bot.com/now', 'go (https://a.b.scam.example.org/x).', 'starknet-bot.com.']) {
    assert.ok(holdsListedLink(text, [], list), text);
  }
  for (const text of ['https://starknet-bot.com.safe.example/', 'https://safestarknet-bot.com/', 'https://safe.example/starknet-bot.com',
    'https://starknet-bot.com@safe.example/', 'the scam.example.organisation site', 'plain words only']) {
    assert.ok(!holdsListedLink(text, [], list), text);
  }
  assert.ok(holdsListedLink('click here', [{ type: 'text_link', offset: 0, length: 10, url: 'https://claim.starknet-bot.com/' }], list), 'a hidden text link');
  assert.deepEqual(linkHosts('see https://Example.COM/a?b'), ['example.com']);
  assert.ok(parseBlocklist('https://x.example/\n').error.startsWith('line 1'));
  assert.ok(!holdsListedLink('https://starknet-bot.com', [], []));
});

test('warnings repeat nothing, and name the delete right when deleting failed', () => {
  for (const kind of ['seed', 'links']) {
    for (const group of [true, false]) {
      const text = warning(kind, false, group);
      assert.ok(!text.includes('starknet-bot') && !text.includes(phrase(12)));
      assert.ok(/delete/i.test(text));
    }
  }
  assert.match(warning('seed', false, true), /Delete messages/);
  assert.doesNotMatch(warning('seed', true, true), /could not/);
});

test('round 4 settings: failover endpoints, bounds and the blocklist file', () => {
  const c = loadConfig(['tick'], { ...env, STARKNET_RPC_URLS: 'https://b.example/k, https://rpc.example/key,https://c.example' });
  assert.deepEqual(c.rpcUrls, ['https://b.example/k', 'https://rpc.example/key', 'https://c.example/'], 'the list replaces STARKNET_RPC_URL');
  assert.equal(c.rpcUrl, 'https://b.example/k');
  assert.deepEqual([c.stallSeconds, c.reorgDepth, c.confirmations, c.maxGap, c.httpPort, c.httpHost, c.operatorChat], [120, 64, 0, 50_000, null, '127.0.0.1', null]);
  assert.deepEqual(c.blocklist, ['starknet-bot.com', 'app-stark.online', 'starknet.portal-drops.icu']);
  const only = loadConfig(['tick'], { ...env, STARKNET_RPC_URL: undefined, STARKNET_RPC_URLS: 'https://b.example/k' });
  assert.deepEqual(only.rpcUrls, ['https://b.example/k']);
  for (const [key, value] of [['STARKNET_RPC_URLS', ' , '], ['STARKNET_RPC_URLS', 'ftp://x'], ['CAIRN_HTTP_PORT', '70000'], ['CAIRN_HTTP_HOST', 'a b'],
    ['CAIRN_OPERATOR_CHAT', 'me'], ['CAIRN_STALL_SECONDS', '1'], ['CAIRN_CONFIRMATIONS', '101'], ['CAIRN_REORG_DEPTH', '0'], ['CAIRN_BLOCKLIST', '/nonexistent/list']]) {
    assert.throws(() => loadConfig(['tick'], { ...env, [key]: value }), (e) => e.exitCode === 2 && e.message.includes(key.replace('CAIRN_OPERATOR_CHAT', 'CAIRN_OPERATOR_CHAT')), `${key}=${value}`);
  }
  assert.equal(loadConfig(['tick'], { ...env, CAIRN_OPERATOR_CHAT: '-1001234' }).operatorChat, -1001234);
});

test('a stall is one alert on wall time, its recovery one more, and an outage one operator notice', () => {
  const { store } = fresh();
  const watch = new NetworkWatch(store, { stallSeconds: 2 });
  const head = (n, hash = n) => ({ block_number: n, block_hash: `0x${hash.toString(16)}`, timestamp: 1 });
  assert.deepEqual(watch.observe(head(10), 0), []);
  assert.deepEqual(watch.observe(head(10), 1999), []);
  const [stall] = watch.observe(head(10), 2000);
  assert.equal(stall.kind, 'stall');
  assert.deepEqual(watch.observe(head(10), 9000), [], 'once per stall');
  assert.deepEqual(watch.observe(head(9), 9500), [], 'a lagging fallback is not a recovery');
  const lag = new NetworkWatch(fresh().store, { stallSeconds: 2 });
  lag.observe(head(50), 0);
  assert.deepEqual([lag.observe(head(48), 1500), lag.observe(head(49), 3000)], [[], []], 'nor a stall');
  assert.equal(lag.observe(head(50), 5000)[0].kind, 'stall', 'the clock restarts from the lagging read');
  const [resumed] = watch.observe(head(11), 10_000);
  assert.deepEqual([resumed.kind, resumed.key, resumed.ms], ['resumed', stall.key, 10_000]);
  assert.match(noticeText(resumed, {}), /resumed.*after 10 s/);
  assert.equal(watch.observe(head(11, 99), 13_000).length, 0, 'a new tip hash is activity');
  assert.equal(watch.observe(head(11, 99), 15_000)[0].kind, 'stall', 'and the latch was reset');
  assert.equal(watch.failed(20_000).kind, 'rpc-down');
  assert.equal(watch.failed(21_000), null, 'once per outage');
  const back = watch.observe(head(11, 99), 25_000);
  assert.deepEqual(back.map((n) => n.kind), ['rpc-back']);
  assert.match(noticeText(back[0], {}), /recovered.*after 5 s/);
  assert.equal(watch.failed(30_000).kind, 'rpc-down', 'the next outage is told again');
  assert.deepEqual([duration(59_999), duration(125_000), duration(3 * 3600_000 + 60_000)], ['59 s', '2 min 5 s', '3 h 1 min']);
  store.close();
});

const h = (n) => hex64(`0x${n.toString(16)}`);
test('the fork walk stops at the common ancestor, never reads below the stored window, and trusts a missing hash', async () => {
  const { store } = fresh();
  const blocks = new Blocks(store, 3);
  store.transaction(() => blocks.record([10, 11, 12, 13].map((n) => ({ number: n, hash: h(n) })), 13));
  assert.deepEqual(readKept(store), [11, 12, 13], 'CAIRN_REORG_DEPTH blocks are kept');
  store.transaction(() => blocks.record([{ number: 20, hash: h(20) }], 20));
  assert.deepEqual(readKept(store), [20], 'a catch-up range leaves no hole in the window');
  store.transaction(() => { blocks.dropAfter(-1); blocks.record([10, 11, 12, 13].map((n) => ({ number: n, hash: h(n) })), 13); });
  const chain = new Map([[11, h(11)], [12, h(0x120)], [13, h(0x130)], [14, h(0x140)]]);
  const read = [];
  const header = async (n) => { read.push(n); return { number: n, hash: chain.get(n), parent: chain.get(n - 1) ?? null }; };
  assert.equal(await findFork(blocks, 13, { block_number: 13, block_hash: h(13) }, header), null);
  assert.deepEqual(await findFork(blocks, 13, { block_number: 14 }, header), { ancestor: 11, deep: false });
  assert.deepEqual(read, [14, 12, 11]);
  chain.set(11, h(0x110));
  read.length = 0;
  assert.deepEqual(await findFork(blocks, 13, { block_number: 13, block_hash: h(0x130) }, header), { ancestor: 10, deep: true });
  assert.ok(read.every((n) => n >= 11), 'nothing below the window');
  assert.equal(await findFork(blocks, 13, { block_number: 12 }, header), null, 'a fallback behind the cursor');
  assert.equal(await findFork(blocks, 13, { block_number: 13 }, header), null, 'no hash to compare');
  store.close();
});
const readKept = (store) => store.db.prepare('SELECT number FROM blocks ORDER BY number').all().map((r) => r.number);

test('an orphaned alert gets one correction replying to it, a re-included one keeps its key, and a return is posted again', () => {
  const { store, ledger } = fresh();
  const alert = (tx, block, eventIndex = 0) => ({ chatId: 7, txHash: tx, eventIndex, kind: 'alert', block, chainTime: 100, body: `alert ${tx}` });
  store.transaction(() => { ledger.add(alert('0xa', 20)); ledger.add(alert('0xb', 20, 3)); ledger.add(alert('0xc', 21)); });
  const rows = () => ledger.pending();
  for (const [i, row] of rows().entries()) store.transaction(() => ledger.sent(row.seq, 500 + i));
  const after = ledger.after(19);
  assert.deepEqual(after.map((r) => r.tx_hash), ['0xa', '0xb', '0xc']);
  store.transaction(() => {
    assert.ok(ledger.orphan(after[0], { chainTime: 101, body: 'gone a' }));
    assert.ok(ledger.orphan(after[1], { chainTime: 101, body: 'gone b' }));
    ledger.moved(after[2].seq, 22);
  });
  const corrections = rows();
  assert.deepEqual(corrections.map((r) => [r.kind, r.tx_hash, r.reply_to]), [['correction', '0xa', 500], ['correction', '0xb', 501]]);
  assert.equal(store.db.prepare('SELECT event_index FROM deliveries WHERE tx_hash = ? AND kind = ?').get('0xb', 'correction').event_index, CORRECTION - 3);
  store.transaction(() => corrections.forEach((r, i) => ledger.sent(r.seq, 600 + i)));
  assert.deepEqual(ledger.after(19).map((r) => [r.tx_hash, r.block]), [['0xc', 22]], 'orphans are not re-checked; the re-included one moved');
  assert.equal(ledger.add(alert('0xc', 22)), false, 'the rescan finds the same key: nothing more');
  assert.equal(ledger.add({ chatId: 7, txHash: '0xa', eventIndex: CORRECTION, kind: 'correction', chainTime: 102, body: 'again' }), false, 'never corrected twice');
  assert.equal(ledger.add(alert('0xa', 30)), true, 'back on the chain later: posted again');
  const [again] = rows();
  store.transaction(() => ledger.sent(again.seq, 700));
  const [row] = ledger.after(29);
  store.transaction(() => assert.ok(ledger.orphan(row, { chainTime: 103, body: 'gone again' })));
  assert.equal(rows()[0].reply_to, 700, 'and corrected again if a later fork drops it');
  store.close();
});

test('network and guard settings are exported, forgotten and migrated with the chat', () => {
  const { store, subs } = fresh();
  store.transaction(() => {
    subs.networkOn({ id: -5, type: 'supergroup' }, 9, 100);
    subs.guard({ id: -5, type: 'supergroup' }, 'links', false);
    subs.networkOn({ id: 8, type: 'private' }, null, 100);
  });
  assert.deepEqual([subs.export(-5).network, subs.export(-5).guards], [{ on: true, thread_id: 9 }, { seed: true, links: false }]);
  store.transaction(() => subs.migrate(-5, -1005));
  assert.deepEqual(subs.guards(-1005), { seed: true, links: false });
  assert.deepEqual(subs.affectedChats().map((c) => c.chat_id), [-1005, 8]);
  store.transaction(() => subs.forget(-1005));
  assert.deepEqual([subs.networkOf(-1005), subs.guards(-1005)], [null, { seed: true, links: true }]);
  assert.deepEqual(subs.networkChats().map((c) => c.chat_id), [8], 'another chat keeps its setting');
  store.transaction(() => subs.guard({ id: 8, type: 'private' }, 'seed', false));
  store.transaction(() => subs.guard({ id: 8, type: 'private' }, 'seed', true));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM guards').get().n, 0, 'default guards keep no row');
  store.close();
});

test('a round 3 state.db gains round 4 in place', () => {
  const { directory, store } = fresh();
  store.db.exec("ALTER TABLE deliveries DROP COLUMN reply_to; DROP TABLE network; DROP TABLE guards; DROP TABLE blocks; UPDATE meta SET value = '3' WHERE key = 'schema';");
  store.close();
  const reopened = new Store(directory);
  try {
    assert.equal(reopened.get('schema'), '4');
    assert.ok(reopened.db.prepare('PRAGMA table_info(deliveries)').all().some((c) => c.name === 'reply_to'));
    for (const table of ['network', 'guards', 'blocks']) assert.ok(reopened.db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table), table);
  } finally { reopened.close(); }
  assert.ok(readdirSync(directory).includes('state.db'));
});

test('Prometheus text has HELP and TYPE once, labels, and leaves unknown values out', () => {
  const text = prometheus([
    { name: 'cairn_a_total', type: 'counter', help: 'A.', value: 3 },
    { name: 'cairn_b', type: 'gauge', help: 'B.', value: null },
    { name: 'cairn_c_total', type: 'counter', help: 'C.', value: [{ labels: { guard: 'seed' }, value: 1 }, { labels: { guard: 'links' }, value: 0 }] },
  ]);
  assert.equal(text, '# HELP cairn_a_total A.\n# TYPE cairn_a_total counter\ncairn_a_total 3\n# HELP cairn_c_total C.\n# TYPE cairn_c_total counter\n' +
    'cairn_c_total{guard="seed"} 1\ncairn_c_total{guard="links"} 0\n');
});

/** A JSON-RPC endpoint for the failover tests: `answer(method, params)` returns a result, or throws for a 503. */
async function endpoint(t, answer) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      calls.push({ method, params });
      try { res.end(JSON.stringify({ jsonrpc: '2.0', id, result: answer(method, params) })); }
      catch { res.writeHead(503).end('down'); }
    });
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise((ok) => server.close(ok)));
  return { url: `http://127.0.0.1:${server.address().port}/`, calls };
}
const MAIN = '0x534e5f4d41494e';
const rpcConfig = (urls) => ({ rpcUrls: urls, chain: 'SN_MAIN', rpcRps: 100, rpcTimeout: 1000 });

test('a failing endpoint hands the call to the next, which is checked for the chain first', async (t) => {
  const dead = await endpoint(t, () => { throw new Error('down'); });
  const live = await endpoint(t, (m) => (m === 'starknet_chainId' ? MAIN : 7));
  const rpc = new Rpc(rpcConfig([dead.url, live.url]), new AbortController().signal);
  assert.equal(await rpc.call('starknet_blockNumber'), 7);
  assert.deepEqual(live.calls.map((c) => c.method), ['starknet_chainId', 'starknet_blockNumber']);
  assert.equal(await rpc.call('starknet_blockNumber'), 7);
  assert.equal(dead.calls.length, 1, 'the answering endpoint is kept');
  assert.deepEqual([rpc.answered, rpc.stats.failovers], [1, 1]);
});

test('a pinned page fails over by throwing, and an endpoint on another chain exits 2', async (t) => {
  let up = true;
  const first = await endpoint(t, (m) => { if (!up) throw new Error('down'); return m === 'starknet_chainId' ? MAIN : 1; });
  const second = await endpoint(t, (m) => (m === 'starknet_chainId' ? MAIN : 2));
  const rpc = new Rpc(rpcConfig([first.url, second.url]), new AbortController().signal);
  assert.equal(await rpc.call('starknet_blockNumber'), 1);
  up = false;
  await assert.rejects(rpc.call('starknet_blockNumber', {}, { endpoint: 0 }), EndpointLost);
  assert.equal(await rpc.call('starknet_blockNumber'), 2, 'the next call starts on the next endpoint');
  const sepolia = await endpoint(t, (m) => (m === 'starknet_chainId' ? '0x534e5f5345504f4c4941' : 3));
  const mixed = new Rpc(rpcConfig([second.url, sepolia.url]), new AbortController().signal);
  await assert.rejects(mixed.verifyAll(), (e) => e.exitCode === 2 && /endpoint 2 is on chain SN_SEPOLIA/.test(e.message));
});
