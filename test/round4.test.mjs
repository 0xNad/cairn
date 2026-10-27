import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.mjs';
import { CairnError, EndpointLost, NodeBusy, RpcError } from '../src/errors.mjs';
import { hex64 } from '../src/felt.mjs';
import { links } from '../src/format.mjs';
import { Guards, linkHosts, listed, loadBlocklist, loadWordlist, longestRun, warning, WORDLIST } from '../src/guards.mjs';
import { listen, prometheus } from '../src/http.mjs';
import { CORRECTION, Ledger } from '../src/ledger.mjs';
import { duration, Network } from '../src/network.mjs';
import { correction, Forks, standing, verdicts } from '../src/reorg.mjs';
import { Scanner, TOKEN_EVENTS } from '../src/scanner.mjs';
import { Store } from '../src/store.mjs';
import { Subscriptions } from '../src/subscriptions.mjs';
import { FAILBACK_MS, Rpc } from '../src/transport.mjs';
import { parseHtml } from '../.launchpad/checks/round-4/fake-telegram.mjs';

// Seed phrases here are cut from the word list at run time, never written out: the repository holds none.
const WORDS = loadWordlist();
const LIST = [...WORDS];
const run = (n, from = 300) => LIST.slice(from, from + n).join(' ');
const plain = (html) => { const r = parseHtml(html); assert.equal(r.error, undefined, r.error); return r.plain; };
const fmt = links({ explorer: 'https://x.example' }, String);
function open(config = {}) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'cairn-r4-')));
  const full = { maxWatches: 20, stallSeconds: 2, maxGap: 3, reorgDepth: 4, operatorChat: null, ...config };
  const ledger = new Ledger(store), subs = new Subscriptions(store, full);
  return { store, ledger, subs, config: full, network: new Network({ store, ledger, subs, config: full }) };
}
const rowsOf = (store, where = '1 = 1') => store.sql(`SELECT chat_id, tx_hash, event_index, kind, state, body, reply_to FROM deliveries WHERE ${where} ORDER BY seq`).all();

// ---- guards ------------------------------------------------------------------------------------------

test('the word list is BIP-39 English, and a broken copy stops Cairn with exit 2', () => {
  assert.equal(WORDS.size, 2048);
  assert.ok(WORDS.has(LIST[0]) && LIST.every((w) => /^[a-z]{3,8}$/.test(w)));
  const broken = join(mkdtempSync(join(tmpdir(), 'cairn-words-')), 'list.txt');
  writeFileSync(broken, readFileSync(WORDLIST, 'utf8').split('\n').slice(1).join('\n'));
  assert.throws(() => loadWordlist(broken), (e) => e instanceof CairnError && e.exitCode === 2 && /BIP-39/.test(e.message));
});

test('a run of 12 or more list words is a seed phrase: 12, 15, 18, 21 and 24, any case, numbered or comma-separated', () => {
  for (const n of [12, 15, 18, 21, 24]) assert.equal(longestRun(run(n), WORDS), n);
  assert.equal(longestRun(run(12).toUpperCase(), WORDS), 12);
  const words = LIST.slice(900, 912);
  assert.equal(longestRun(words.map((w, i) => `${i + 1}. ${w}`).join('\n'), WORDS), 12);
  assert.equal(longestRun(words.join(','), WORDS), 12);
  assert.equal(longestRun(`Backup: ${words.join(' ')} (thanks!)`, WORDS), 12);
  assert.equal(longestRun(`${words.join(' ')} keep it`, WORDS), 13, 'a list word next to a phrase extends its run: it is still caught');
});

test('eleven words, two runs of six around another word, and ordinary prose are not seed phrases', () => {
  assert.equal(longestRun(run(11), WORDS), 11);
  assert.equal(longestRun(`${run(6)} not_a_bip39_word ${run(6, 306)}`, WORDS) < 12, true);
  assert.equal(longestRun(`${run(6)} zzyzx ${run(6, 306)}`, WORDS), 6);
  for (const file of ['README.md', 'ARCHITECTURE.md', '.launchpad/project.md']) {
    assert.ok(longestRun(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), WORDS) < 12, file);
  }
});

test('a seed warning holds no BIP-39 word at all, so it can never repeat one it protects', () => {
  for (const n of [12, 24]) {
    for (const deleted of [true, false]) {
      const text = plain(warning({ guard: 'seed', words: n }, deleted));
      const hits = text.split(/[^A-Za-z]+/).filter((w) => WORDS.has(w.toLowerCase()));
      assert.deepEqual(hits, [], text);
      assert.match(text, new RegExp(`${n} recovery words`));
      if (!deleted) assert.match(text, /Delete messages permission/);
    }
  }
});

test('link hosts are read like a browser: schemes, case, subdomains, bare hosts, entities and buttons', () => {
  const blocklist = new Set(['starknet-bot.com', 'app-stark.online']);
  const hit = (message) => [...linkHosts(message)].map((h) => listed(h, blocklist)).find(Boolean) ?? null;
  for (const text of ['https://starknet-bot.com/drop', 'http://STARKNET-BOT.COM/', 'see https://claim.starknet-bot.com/.', 'go to starknet-bot.com/claim now',
    '(app-stark.online)', 'ftp://starknet-bot.com:21/x', 'https://starknet-bot.com./']) assert.equal(hit({ text }), text.toLowerCase().includes('app-stark') ? 'app-stark.online' : 'starknet-bot.com', text);
  for (const text of ['https://starknet-bot.com.safe.example/', 'https://safestarknet-bot.com/', 'https://safe.example/starknet-bot.com',
    'https://starknet-bot.com@safe.example/', 'safe.example/starknet-bot.com', 'mail support@starknet-bot.com', 'starknet-bot.company']) assert.equal(hit({ text }), null, text);
  assert.equal(hit({ text: 'Claim here', entities: [{ type: 'text_link', offset: 0, length: 5, url: 'https://x.starknet-bot.com/a' }] }), 'starknet-bot.com');
  assert.equal(hit({ caption: 'airdrop', caption_entities: [{ type: 'url', offset: 0, length: 7 }] }), null);
  assert.equal(hit({ text: 'tap', reply_markup: { inline_keyboard: [[{ text: 'Claim', url: 'https://starknet-bot.com' }]] } }), 'starknet-bot.com');
});

test('the blocklist file: comments, wildcards, hosts-file lines and punycode; a bad line exits 2 naming it', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cairn-block-')), 'list.txt');
  writeFileSync(file, '# phishing\nStarknet-Bot.com\n*.app-stark.online   # kit\n.drops.icu\n0.0.0.0 evil.example\nbücher.example\n\n');
  assert.deepEqual([...loadBlocklist(file)], ['starknet-bot.com', 'app-stark.online', 'drops.icu', 'evil.example', 'xn--bcher-kva.example']);
  writeFileSync(file, 'good.example\nhttps://bad.example/path\n');
  assert.throws(() => loadBlocklist(file), (e) => e instanceof CairnError && e.exitCode === 2 && /line 2/.test(e.message));
  assert.throws(() => loadBlocklist(join(file, 'missing')), (e) => e.exitCode === 2);
});

test('the guards follow the chat switches, seed phrases first, and a link warning is never a link again', () => {
  const guards = new Guards({ wordlist: WORDS, blocklist: new Set(['starknet-bot.com']) });
  const message = { text: `${run(12)} https://starknet-bot.com` };
  assert.deepEqual(guards.inspect(message), { guard: 'seed', words: 12 });
  assert.deepEqual(guards.inspect(message, { seed: false }), { guard: 'links', domain: 'starknet-bot.com' });
  assert.equal(guards.inspect(message, { seed: false, links: false }), null);
  assert.equal(guards.inspect({ text: 'Please help us check this ordinary project status.' }), null);
  const html = warning({ guard: 'links', domain: 'starknet-bot.com' }, true);
  assert.ok(!plain(html).includes('starknet-bot.com') && plain(html).includes('starknet-bot[.]com'));
  assert.match(plain(warning({ guard: 'links', domain: 'starknet-bot.com' }, false)), /could not delete it: Cairn lacks the Delete messages permission/);
});

// ---- failover --------------------------------------------------------------------------------------

/** A JSON-RPC endpoint whose answers `reply(body, n)` decides: [status, json, headers]. */
async function endpoint(t, reply) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push({ body, at: Date.now() });
      const [status, json, headers = {}] = reply(body, seen.length);
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(json === undefined ? { jsonrpc: '2.0', id: body.id, result: 7 } : { jsonrpc: '2.0', id: body.id, ...json }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}/rpc/secret`, seen };
}
const rpcOf = (...urls) => new Rpc({ rpcUrls: urls, rpcRps: 100, rpcTimeout: 500 }, new AbortController().signal);

test('a failing endpoint hands the call to the next one at once, and is retried first again only after a minute', async (t) => {
  const a = await endpoint(t, () => [503, {}]), b = await endpoint(t, () => [200]);
  const rpc = rpcOf(a.url, b.url);
  assert.deepEqual(await rpc.request('starknet_blockNumber'), { result: 7, endpoint: 1 });
  assert.equal(rpc.current, 1);
  assert.deepEqual([rpc.endpoints[0].errors, rpc.endpoints[1].errors], [1, 0]);
  await rpc.call('starknet_blockNumber');
  assert.equal(a.seen.length, 1, 'the endpoint that failed is not asked again within a minute');
  rpc.endpoints[0].failedAt -= FAILBACK_MS;
  await rpc.call('starknet_blockNumber');
  assert.equal(a.seen.length, 2, 'after a minute the first endpoint comes first again');
  rpc.demote(1);
  assert.ok(rpc.endpoints[1].failedAt > performance.now(), 'an endpoint left behind is set aside for longer');
});

test("one endpoint's Retry-After never delays the others, and every endpoint failing is node busy", async (t) => {
  const a = await endpoint(t, () => [429, {}, { 'retry-after': '60' }]), b = await endpoint(t, () => [200]);
  const started = Date.now();
  assert.equal(await rpcOf(a.url, b.url).call('starknet_blockNumber'), 7);
  assert.ok(Date.now() - started < 1000);
  const c = await endpoint(t, () => [503, {}]), d = await endpoint(t, () => [502, {}]);
  await assert.rejects(rpcOf(c.url, d.url).call('starknet_blockNumber'), NodeBusy);
  assert.deepEqual([c.seen.length, d.seen.length], [3, 3], 'each endpoint got its 3 tries');
});

test("an endpoint's own JSON-RPC error moves on when there is another endpoint; the spec's errors are answers", async (t) => {
  const broken = await endpoint(t, () => [200, { error: { code: -32603, message: 'Internal error' } }]), good = await endpoint(t, () => [200]);
  assert.equal(await rpcOf(broken.url, good.url).call('starknet_blockNumber'), 7);
  await assert.rejects(rpcOf(broken.url).call('starknet_blockNumber'), (e) => e instanceof RpcError && e.code === -32603);
  const answer = await endpoint(t, () => [200, { error: { code: 29, message: 'Transaction hash not found' } }]);
  await assert.rejects(rpcOf(answer.url, good.url).call('starknet_getTransactionStatus', { transaction_hash: '0x1' }), (e) => e.code === 29);
  assert.equal(good.seen.length, 1, 'a not-found answer is not asked again elsewhere');
});

test('every endpoint answers the chain handshake once before its first use; another chain stops Cairn', async (t) => {
  const main = await endpoint(t, ({ method }) => [200, { result: method === 'starknet_chainId' ? '0x534e5f4d41494e' : 9 }]);
  const sepolia = await endpoint(t, ({ method }) => [200, { result: method === 'starknet_chainId' ? '0x534e5f5345504f4c4941' : 9 }]);
  const rpc = rpcOf(main.url, sepolia.url);
  const checked = [];
  rpc.identifyWith(async (i) => {
    checked.push(i);
    const chain = await rpc.call('starknet_chainId', {}, { endpoint: i });
    if (chain !== '0x534e5f4d41494e') throw new CairnError(`RPC endpoint ${i + 1} reports another chain`, 2);
    return { chain };
  });
  assert.equal(await rpc.call('starknet_blockNumber'), 9);
  await rpc.call('starknet_blockNumber');
  assert.deepEqual(checked, [0]);
  await assert.rejects(rpc.identify(1), (e) => e.exitCode === 2 && /chain/.test(e.message));
});

test('a request pinned to an endpoint never moves: it fails as EndpointLost', async (t) => {
  const a = await endpoint(t, () => [503, {}]), b = await endpoint(t, () => [200]);
  await assert.rejects(rpcOf(a.url, b.url).request('starknet_blockNumber', {}, { endpoint: 0 }), EndpointLost);
  assert.equal(b.seen.length, 0);
});

test('a range whose endpoint fails mid-page restarts from its first page on the next endpoint, never reusing its tokens', async () => {
  const calls = [];
  const rpc = {
    endpoints: [{ index: 0 }, { index: 1 }],
    down: false,
    async request(method, { filter }, { endpoint } = {}) {
      const at = endpoint ?? (this.down ? 1 : 0);
      calls.push({ at, token: filter.continuation_token });
      if (at === 0 && filter.continuation_token) { this.down = true; throw new EndpointLost(); }
      if (filter.continuation_token && !filter.continuation_token.startsWith(`ct-${at}-`)) throw new RpcError(33);
      return { result: filter.continuation_token ? { events: [3] } : { events: [1, 2], continuation_token: `ct-${at}-2` }, endpoint: at };
    },
  };
  const events = await new Scanner(rpc, { maxBlocks: 500 }).events({ from: 1, to: 2 }, TOKEN_EVENTS);
  assert.deepEqual(events, [1, 2, 3]);
  assert.deepEqual(calls, [{ at: 0, token: undefined }, { at: 0, token: 'ct-0-2' }, { at: 1, token: undefined }, { at: 1, token: 'ct-1-2' }]);
});

// ---- network alerts --------------------------------------------------------------------------------

const block = (n, timestamp = 1_000 + n) => ({ block_number: n, block_hash: hex64(`0x${(0xb000 + n).toString(16)}`), timestamp });

test('a stall alert per subscribed chat after CAIRN_STALL_SECONDS of wall clock, never from block times; one recovery with its length', () => {
  const { store, ledger, subs, network } = open();
  try {
    store.transaction(() => { subs.network({ id: 1, type: 'private' }, true); subs.network({ id: -2, type: 'supergroup' }, true, 77); });
    network.observe(block(10, 0), { now: 0 });
    network.observe(block(10, 0), { now: 1999 });
    assert.equal(rowsOf(store).length, 0, 'early: and an old block time means nothing');
    network.observe(block(10, 0), { now: 2000 });
    network.observe(block(10, 0), { now: 9000 });
    assert.deepEqual(rowsOf(store).map((r) => [r.chat_id, r.tx_hash, r.event_index]), [[-2, 'stall:10:0', 0], [1, 'stall:10:0', 0]]);
    assert.equal(store.sql('SELECT thread_id FROM deliveries WHERE chat_id = -2').get().thread_id, 77, 'in the topic /network on came from');
    assert.match(plain(rowsOf(store)[0].body), /^⚠️ Starknet stalled: no new block for 2 s\. The head is still block 10\./);
    store.transaction(() => subs.network({ id: 3, type: 'private' }, true));
    network.observe(block(10, 0), { now: 9500 });
    assert.equal(rowsOf(store, "tx_hash = 'stall:10:0'").length, 3, 'a chat that subscribes during a stall gets it too');
    for (const row of ledger.pending()) if (row.chat_id !== 3) store.transaction(() => ledger.sent(row.seq, 100 + row.seq));
    network.observe(block(11), { now: 12_345 });
    const resumed = rowsOf(store, 'event_index = 1');
    assert.deepEqual(resumed.map((r) => r.chat_id), [-2, 1], 'the unsent alert is dropped, and that chat needs no recovery');
    assert.match(plain(resumed[0].body), /producing blocks again: block 11 arrived after a 12 s stall at block 10/);
    assert.equal(rowsOf(store, 'chat_id = 3')[0].state, 'dropped');
    network.observe(block(11), { now: 14_345 });
    assert.equal(rowsOf(store, "tx_hash LIKE 'stall:11:%'").length, 3, 'the next stall is a new one');
  } finally { store.close(); }
});

test('an outage is told to the operator only, once, then once when an endpoint answers again', () => {
  const { store, ledger, subs, network } = open({ operatorChat: 42 });
  try {
    store.transaction(() => subs.network({ id: 1, type: 'private' }, true));
    network.observe(block(10), { now: 0 });
    network.observe(null, { now: 5000, endpoints: 2 });
    network.observe(null, { now: 9000, endpoints: 2 });
    assert.deepEqual(rowsOf(store).map((r) => [r.chat_id, r.event_index]), [[42, 0]]);
    assert.match(plain(rowsOf(store)[0].body), /^🚨 RPC outage: all 2 endpoints of STARKNET_RPC_URLS fail/);
    store.transaction(() => ledger.sent(ledger.pending()[0].seq, 500));
    network.observe(block(11), { now: 65_000, endpoint: 'endpoint 2 of 2' });
    const back = rowsOf(store, 'event_index = 1');
    assert.equal(back.length, 1);
    assert.match(plain(back[0].body), /^✅ RPC back online: endpoint 2 of 2 answers again after 1 min of outage/);
    network.observe(null, { now: 70_000, endpoints: 2 });
    assert.equal(rowsOf(store, "tx_hash LIKE 'outage:%' AND event_index = 0").length, 2, 'a new outage, a new notice');
  } finally { store.close(); }
});

test('a skipped gap tells every chat it concerns, once; durations read in words', () => {
  const { store, subs, network } = open();
  try {
    store.transaction(() => {
      subs.network({ id: 1, type: 'private' }, true, 5);
      subs.watch({ id: 1, type: 'private' }, hex64('0xa'), null, 1);
      subs.watch({ id: 2, type: 'private' }, hex64('0xa'), null, 1);
      network.skipped(14, 17, block(17));
      network.skipped(14, 17, block(17));
    });
    assert.deepEqual(rowsOf(store).map((r) => [r.chat_id, r.tx_hash]), [[1, 'gap:14:17'], [2, 'gap:14:17']]);
    assert.match(plain(rowsOf(store)[0].body), /^⏭ Skipped blocks 14–17 \(4 blocks\): Cairn was further behind than CAIRN_MAX_GAP \(3 blocks\)/);
    assert.deepEqual([0, 2400, 59_600, 61_000, 3_725_000, 90_000_000, 200_000_000].map(duration), ['0 s', '2 s', '1 min', '1 min 1 s', '1 h 2 min', '25 h', '2 d 7 h']);
  } finally { store.close(); }
});

// ---- reorgs ----------------------------------------------------------------------------------------

/** A node whose blocks are { number: hash }: header reads are recorded. */
function chain(hashes) {
  const asked = [];
  return { asked, hashes, rpc: { async call(method, { block_id }) {
    asked.push(block_id.block_number);
    const hash = hashes[block_id.block_number];
    if (hash === undefined) throw new RpcError(24);
    return { block_hash: hash, timestamp: 1000 + block_id.block_number };
  } } };
}

test('the cursor block is checked each pass; a fork walks back to the newest kept block the node still has', async () => {
  const { store } = open();
  try {
    const node = chain({ 10: '0xa', 11: '0xb', 12: '0xc', 13: '0xd' });
    const forks = new Forks(store, node.rpc, { reorgDepth: 64 });
    assert.equal(await forks.check(12, block(13)), null, 'nothing kept yet: the cursor block becomes the reference');
    store.transaction(() => { for (const n of [10, 11, 13]) forks.remember({ number: n, hash: hex64(node.hashes[n]), timestamp: 1000 + n }); });
    assert.equal(await forks.check(13, { ...block(13), block_hash: '0xd' }), null);
    node.hashes[11] = '0xbb'; node.hashes[12] = '0xcc'; node.hashes[13] = '0xdd';
    node.asked.length = 0;
    assert.deepEqual(await forks.check(13, { ...block(14), block_hash: '0xee' }), { from: 13, hash: hex64('0xdd'), ancestor: 10, deep: false });
    assert.deepEqual(node.asked, [13, 12, 11, 10], 'kept blocks are compared, newest first, down to the first match');
  } finally { store.close(); }
});

test('the walk-back never looks deeper than CAIRN_REORG_DEPTH; a deeper fork rescans from that depth', async () => {
  const { store } = open();
  try {
    const node = chain({});
    const forks = new Forks(store, node.rpc, { reorgDepth: 2 });
    store.transaction(() => { for (let n = 10; n <= 15; n++) forks.remember({ number: n, hash: hex64(`0x${n}`), timestamp: n }); });
    assert.deepEqual(store.sql('SELECT number FROM blocks ORDER BY number').all().map((r) => r.number), [14, 15], 'only the last 2 are kept');
    for (let n = 10; n <= 15; n++) node.hashes[n] = `0xf${n}`;
    const fork = await forks.check(15, { ...block(15), block_hash: '0xf15' });
    assert.deepEqual(fork, { from: 15, hash: hex64('0xf15'), ancestor: 13, deep: true });
    assert.ok(node.asked.every((n) => n >= 13), `looked up ${node.asked}`);
  } finally { store.close(); }
});

test('after a reorg: one correction per message whose transaction is gone, none for one re-included, unsent alerts dropped', () => {
  const rows = [
    { seq: 1, chat_id: 1, tx_hash: 'T1', event_index: 0, block: 11, state: 'sent', message_id: 501, thread_id: null, doubt_since: null },
    { seq: 2, chat_id: 1, tx_hash: 'T2', event_index: 3, block: 11, state: 'sent', message_id: 502, thread_id: null, doubt_since: null },
    { seq: 3, chat_id: -5, tx_hash: 'T1', event_index: 0, block: 11, state: 'summarized', message_id: 600, thread_id: 9, doubt_since: null },
    { seq: 4, chat_id: -5, tx_hash: 'T3', event_index: 1, block: 12, state: 'summarized', message_id: 600, thread_id: 9, doubt_since: null },
    { seq: 5, chat_id: 2, tx_hash: 'T3', event_index: 1, block: 12, state: 'pending', message_id: null, thread_id: null, doubt_since: null },
    { seq: 6, chat_id: 2, tx_hash: 'T4', event_index: 0, block: 12, state: 'sent', message_id: 700, thread_id: null, doubt_since: null },
    { seq: 7, chat_id: 2, tx_hash: 'T5', event_index: 0, block: 12, state: 'sent', message_id: 701, thread_id: null, doubt_since: 100 },
  ];
  const standings = new Map([['T1', 'gone'], ['T2', 'included'], ['T3', 'gone'], ['T4', 'waiting'], ['T5', 'waiting']]);
  const v = verdicts(rows, standings, 800);
  assert.deepEqual(v.drop.map((r) => r.seq), [5]);
  assert.deepEqual(v.doubt.map((r) => r.seq), [6], 'back in the mempool: checked again later');
  assert.deepEqual(v.corrections.map((list) => list.map((r) => r.seq)), [[1], [3, 4], [7]], 'a summary gets one correction; 10 minutes out of a block is gone');
  const one = correction(v.corrections[0], 'Starknet reorganised the blocks after 10', fmt, 900);
  assert.deepEqual([one.chatId, one.replyTo, one.eventIndex, one.kind, one.txHash], [1, 501, CORRECTION, 'correction', 'T1']);
  assert.match(plain(one.body), /^↩️ Correction: Starknet reorganised the blocks after 10, and transaction T1…T1 is no longer on chain\. What this alert reported did not happen/);
  const summary = correction(v.corrections[1], 'x', fmt, 900);
  assert.deepEqual([summary.replyTo, summary.thread], [600, 9]);
  assert.match(plain(summary.body), /2 of the transactions this message counted are no longer on chain/);
});

test('with several endpoints, a transaction is gone only when none of them has it', async () => {
  const of = (...answers) => ({ endpoints: answers.map((_, index) => ({ index })), async call(_, __, { endpoint }) {
    const a = answers[endpoint];
    if (a === 'busy') throw new EndpointLost();
    if (a === 'unknown') throw new RpcError(29);
    return { finality_status: a };
  } });
  assert.equal(await standing(of('unknown', 'ACCEPTED_ON_L2'), '0x1'), 'included', 'an endpoint still on the old fork, or behind, is not believed alone');
  assert.equal(await standing(of('unknown', 'RECEIVED'), '0x1'), 'waiting');
  assert.equal(await standing(of('busy', 'unknown'), '0x1'), 'gone');
  assert.equal(await standing(of('REJECTED', 'unknown'), '0x1'), 'gone');
  await assert.rejects(standing(of('busy', 'busy'), '0x1'), NodeBusy);
  assert.equal(await standing({ async call() { return { finality_status: 'ACCEPTED_ON_L1' }; } }, '0x1'), 'included');
});

test('in the ledger, a correction is keyed by its alert, so no later fork or restart sends a second one', () => {
  const { store, ledger, subs } = open();
  try {
    const alert = { chatId: 1, txHash: hex64('0x1'), eventIndex: 0, kind: 'alert', block: 11, chainTime: 1, body: 'x' };
    store.transaction(() => { subs.chat({ id: 1, type: 'private' }); ledger.add(alert); });
    store.transaction(() => ledger.sent(ledger.pending()[0].seq, 501));
    const [row] = ledger.after(10);
    store.transaction(() => {
      assert.equal(ledger.add(correction([row], 'why', fmt, 2)), true);
      ledger.corrected(row.seq);
      assert.equal(ledger.add(correction([row], 'why', fmt, 3)), false);
    });
    assert.deepEqual(ledger.after(10), [], 'a corrected alert is never checked again');
    assert.deepEqual(ledger.pending().map((r) => [r.kind, r.reply_to]), [['correction', 501]]);
    store.transaction(() => { ledger.add({ ...alert, txHash: hex64('0x2'), block: 12 }); ledger.relocate({ ...alert, txHash: hex64('0x2'), block: 14 }); });
    assert.equal(store.sql('SELECT block FROM deliveries WHERE tx_hash = ?').get(hex64('0x2')).block, 14);
    store.transaction(() => ledger.doubt(ledger.pending().at(-1).seq, 5));
    assert.equal(ledger.pending().length, 1, 'an alert whose transaction is out of every block waits');
  } finally { store.close(); }
});

// ---- operations --------------------------------------------------------------------------------------

test('round 4 settings are checked before any call: failover lists, the operator chat, the bind host and the blocklist', () => {
  const env = { TELEGRAM_BOT_TOKEN: `12:${'x'.repeat(30)}`, STARKNET_RPC_URL: 'https://a.example/k1', CAIRN_DATA: join(tmpdir(), 'cairn-unused') };
  const config = loadConfig(['tick'], { ...env, STARKNET_RPC_URLS: ' https://a.example/k1 , https://b.example/k2 ', CAIRN_OPERATOR_CHAT: '-1001234567890' });
  assert.deepEqual(config.rpcUrls, ['https://a.example/k1', 'https://b.example/k2']);
  assert.deepEqual([config.operatorChat, config.httpPort, config.httpHost, config.confirmations, config.stallSeconds, config.reorgDepth, config.maxGap],
    [-1001234567890, null, '127.0.0.1', 0, 120, 64, 50_000]);
  assert.ok(config.blocklist.has('starknet-bot.com') && config.blocklist.has('starknet.portal-drops.icu'));
  const { STARKNET_RPC_URL: _unused, ...withoutUrl } = env;
  assert.equal(loadConfig(['tick'], { ...withoutUrl, STARKNET_RPC_URLS: 'https://b.example' }).rpcUrl, 'https://b.example/');
  for (const [key, value] of [['STARKNET_RPC_URLS', 'https://a.example,,https://b.example'], ['STARKNET_RPC_URLS', 'https://a.example,https://a.example'],
    ['STARKNET_RPC_URLS', 'https://a.example,ftp://b.example'], ['CAIRN_OPERATOR_CHAT', '@me'], ['CAIRN_OPERATOR_CHAT', '0'], ['CAIRN_HTTP_PORT', '65536'],
    ['CAIRN_HTTP_HOST', 'local host'], ['CAIRN_STALL_SECONDS', '1'], ['CAIRN_REORG_DEPTH', '1001'], ['CAIRN_CONFIRMATIONS', '101'], ['CAIRN_BLOCKLIST', '/nonexistent/list.txt']]) {
    assert.throws(() => loadConfig(['tick'], { ...env, [key]: value }), (e) => e.exitCode === 2 && e.message.includes(key === 'CAIRN_BLOCKLIST' ? 'blocklist' : key.split('_').slice(0, 2).join('_')), `${key}=${value}`);
  }
  assert.throws(() => loadConfig(['tick'], { ...env, STARKNET_RPC_URLS: 'https://a.example/SECRET,ftp://x' }),
    (e) => e.exitCode === 2 && /entry 2/.test(e.message) && !e.message.includes('SECRET'), 'a bad entry is named by its place, never its URL');
});

test('HTTP: GET /healthz (200 or 503) and GET /metrics, nothing else', async (t) => {
  const abort = new AbortController();
  t.after(() => abort.abort());
  let healthy = true;
  const server = await listen({ httpPort: 0, httpHost: '127.0.0.1' }, {
    health: () => (healthy ? { ok: true, head: 5, lag_s: 0 } : { ok: false, reason: 'stalled' }),
    metrics: () => prometheus([{ name: 'cairn_head_block', type: 'gauge', help: 'Head.', samples: [[{}, 5]] },
      { name: 'cairn_rpc_errors_total', type: 'counter', help: 'Errors.', samples: [[{ endpoint: 1 }, 2], [{ endpoint: 2 }, 0]] }]),
  }, abort.signal);
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = async (path, method = 'GET') => { const r = await fetch(url + path, { method }); return { status: r.status, body: await r.text() }; };
  assert.deepEqual(await get('/healthz'), { status: 200, body: '{"ok":true,"head":5,"lag_s":0}' });
  healthy = false;
  assert.deepEqual(await get('/healthz'), { status: 503, body: '{"ok":false,"reason":"stalled"}' });
  const metrics = await get('/metrics');
  assert.equal(metrics.status, 200);
  assert.match(metrics.body, /^# HELP cairn_head_block Head\.\n# TYPE cairn_head_block gauge\ncairn_head_block 5\n/);
  assert.match(metrics.body, /cairn_rpc_errors_total\{endpoint="1"\} 2\ncairn_rpc_errors_total\{endpoint="2"\} 0\n$/);
  for (const [path, method, status] of [['/', 'GET', 404], ['/healthz/x', 'GET', 404], ['/healthz', 'POST', 405], ['/metrics', 'DELETE', 405], ['/__proto__', 'GET', 404]]) {
    assert.equal((await get(path, method)).status, status, `${method} ${path}`);
  }
});

test("a round 3 state.db gains round 4's tables and columns in place", () => {
  const directory = mkdtempSync(join(tmpdir(), 'cairn-r3-db-'));
  const first = new Store(directory);
  first.close();
  const db = new DatabaseSync(join(directory, 'state.db'));
  db.exec("DROP TABLE network; DROP TABLE guards; DROP TABLE blocks; ALTER TABLE deliveries DROP COLUMN reply_to; ALTER TABLE deliveries DROP COLUMN doubt_since; UPDATE meta SET value = '3' WHERE key = 'schema';");
  db.close();
  const store = new Store(directory);
  try {
    assert.equal(store.get('schema'), '4');
    const columns = store.db.prepare('PRAGMA table_info(deliveries)').all().map((c) => c.name);
    assert.ok(columns.includes('reply_to') && columns.includes('doubt_since'));
    const subs = new Subscriptions(store, { maxWatches: 20 });
    store.transaction(() => { subs.network({ id: 7, type: 'private' }, true); subs.guard({ id: 7, type: 'private' }, 'links', false); });
    assert.deepEqual([subs.export(7).network, subs.export(7).guards], [{ on: true }, { seed: true, links: false }]);
    store.transaction(() => subs.forget(7));
    assert.deepEqual([subs.export(7).network, subs.export(7).guards], [{ on: false }, { seed: true, links: true }]);
  } finally { store.close(); }
});
