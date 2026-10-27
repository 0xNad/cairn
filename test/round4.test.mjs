import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containsSeed, blockedLink, guarded } from '../src/guards.mjs';
import { Operations } from '../src/operations.mjs';
import { Store } from '../src/store.mjs';
import { Subscriptions } from '../src/subscriptions.mjs';
import { Ledger } from '../src/ledger.mjs';
import { Names, encode } from '../src/names.mjs';
import { RpcError, NodeBusy } from '../src/errors.mjs';
import { hex64, SELECTORS } from '../src/felt.mjs';
import { tradeOf } from '../src/trades.mjs';
import { chainOrder } from '../src/bot.mjs';
import { loadConfig } from '../src/config.mjs';
import { redactor } from '../src/format.mjs';

const words = readFileSync(new URL('../resources/bip39-english.txt', import.meta.url), 'utf8').trim().split('\n');
const config = { maxWatches: 20, stallSeconds: 2, reorgDepth: 4, maxGap: 3, operatorChat: 999 };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cairn-r4-'));
  const store = new Store(directory); t.after(() => store.close());
  const subs = new Subscriptions(store, config), ledger = new Ledger(store);
  const sent = [], hashes = new Map([[10, '0xa'], [11, '0xb'], [12, '0xc']]);
  const receipts = new Map();
  const rpc = { errors: 0, async call(method, p) {
    if (method === 'starknet_getBlockWithTxHashes') { const n = p.block_id.block_number; return { block_number: n, block_hash: hashes.get(n) }; }
    if (method === 'starknet_getTransactionReceipt') {
      const value = receipts.get(p.transaction_hash);
      if (value instanceof Error) throw value;
      if (value === undefined) throw new RpcError(29);
      return { block_number: value };
    }
    throw Error(method);
  } };
  const bot = { store, config, subs, ledger, rpc, names: { reset() {} }, prices: { reset() {} },
    head: { block_number: 12, block_hash: '0xc' }, async send(chat, body, extra) { sent.push({ chat, body, extra }); return { message: { message_id: 100 + sent.length } }; } };
  const ops = new Operations(bot);
  subs.protect({ id: 1, type: 'private' }, 'network', true);
  store.cursor = 12;
  return { directory, store, subs, ledger, bot, ops, sent, hashes, receipts };
}
const delivery = (chatId = 1, txHash = hex64('0x123'), eventIndex = 0) => ({ chatId, txHash, eventIndex, kind: 'transfer', block: 11, chainTime: 100, body: 'transfer' });

test('complete vocabulary, all phrase lengths, mixed case and interrupted prose', () => {
  assert.equal(words.length, 2048); assert.equal(new Set(words).size, 2048);
  for (const n of [12, 15, 18, 21, 24]) assert.equal(containsSeed(words.slice(-n).join(' ').toUpperCase()), true);
  assert.equal(containsSeed(words.slice(0, 11).join(' ')), false);
  assert.equal(containsSeed([...words.slice(0, 6), 'not_a_word', ...words.slice(6, 12)].join(' ')), false);
  assert.equal(containsSeed('Please help us check this ordinary project status.'), false);
  assert.equal(guarded({ caption: words.slice(100, 112).join('\n') }, { seed: true }, []), 'seed');
});

test('links parse authority, hidden entities and DNS boundaries without opening URLs', () => {
  const hosts = ['blocked.example'];
  for (const s of ['https://sub.BLOCKED.example/a', 'https://blocked.example./', 'www.blocked.example/a', 'blocked.example/a']) assert.equal(blockedLink(s, [], hosts), true, s);
  for (const s of ['https://blocked.example@safe.example/', 'https://blocked.example.safe.example/', 'https://notblocked.example/', 'https://safe.example/?q=blocked.example']) assert.equal(blockedLink(s, [], hosts), false, s);
  assert.equal(blockedLink('click', [{ type: 'text_link', url: 'https://blocked.example' }], hosts), true);
  assert.equal(guarded({ caption: 'click', caption_entities: [{ type: 'text_link', url: 'https://blocked.example' }] }, { links: true }, hosts), 'links');
});

test('wall-clock boundary, recovery duration and outage latches survive independent passes', async t => {
  const { ops, bot, store, sent } = fixture(t);
  ops.observe(bot.head, 10000); ops.observe(bot.head, 11999); await ops.deliver(); assert.equal(sent.length, 0);
  ops.observe(bot.head, 12000); ops.observe(bot.head, 15000); await ops.deliver(); assert.equal(sent.length, 1);
  const restarted = new Operations(bot); restarted.observe(bot.head, 16000); await restarted.deliver(); assert.equal(sent.length, 1);
  restarted.observe({ block_number: 13, block_hash: '0xd' }, 17000); await restarted.deliver(); assert.match(sent[1].body, /7.0 seconds/);
  restarted.observe(null, 18000); restarted.observe(null, 19000); await restarted.deliver(); assert.equal(sent.filter(s => s.chat === 999).length, 1);
  restarted.observe(bot.head, 20000); restarted.observe(null, 20001); await restarted.deliver(); assert.equal(sent.filter(s => s.chat === 999).length, 2);
  assert.equal(store.get('rpc_outage'), '1');
});

test('orphan correction is durable, threaded and replies to the delivered alert only once', async t => {
  const { ops, store, bot, ledger, sent, hashes } = fixture(t);
  store.sql('INSERT INTO headers VALUES (?, ?)').run(10, hex64('0xa'));
  store.sql('INSERT INTO headers VALUES (?, ?)').run(11, hex64('0x999'));
  ledger.add({ ...delivery(), thread: 55 }); ledger.sent(1, 77);
  await ops.reconcile(bot.head);
  assert.equal(store.cursor, 10); await ops.deliver();
  assert.equal(sent[0].extra.reply_parameters.message_id, 77); assert.equal(sent[0].extra.message_thread_id, 55);
  await new Operations(bot).deliver(); assert.equal(sent.length, 1);
  hashes.set(11, '0x888'); await ops.reconcile(bot.head); await ops.deliver(); assert.equal(sent.length, 1);
});

test('re-inclusion updates ledger block, keeps original identity across different event indexes', async t => {
  const { ops, store, bot, ledger, receipts, sent } = fixture(t);
  store.sql('INSERT INTO headers VALUES (?, ?)').run(10, hex64('0xa'));
  store.sql('INSERT INTO headers VALUES (?, ?)').run(11, hex64('0x999'));
  ledger.add(delivery()); ledger.sent(1, 77); receipts.set(hex64('0x123'), 12);
  await ops.reconcile(bot.head); await ops.deliver();
  assert.equal(sent.length, 0); assert.equal(store.sql('SELECT block FROM deliveries').get().block, 12);
  assert.equal(ledger.add(delivery(1, hex64('0x123'), 4)), false);
});

test('a failed orphan lookup leaves cursor and ledger untouched for a retry', async t => {
  const { ops, store, bot, ledger, receipts } = fixture(t);
  store.sql('INSERT INTO headers VALUES (?, ?)').run(10, hex64('0xa'));
  store.sql('INSERT INTO headers VALUES (?, ?)').run(11, hex64('0x999'));
  ledger.add(delivery()); ledger.sent(1, 77); receipts.set(hex64('0x123'), new NodeBusy());
  await assert.rejects(ops.reconcile(bot.head), NodeBusy);
  assert.equal(store.cursor, 12); assert.equal(store.sql('SELECT state FROM deliveries').get().state, 'sent');
  assert.equal(store.sql('SELECT count(*) AS n FROM corrections').get().n, 0);
});

test('gap equality scans, a longer gap skips once, and forgetting removes queued notices', async t => {
  const { ops, store, subs, sent } = fixture(t);
  ops.skipGap(15); assert.equal(store.cursor, 12);
  ops.skipGap(16); assert.equal(store.cursor, 16); ops.skipGap(16);
  await ops.deliver(); assert.equal(sent.length, 1);
  ops.skipGap(20); subs.forget(1); await ops.deliver(); assert.equal(sent.length, 1);
  assert.deepEqual(subs.protection(1), { network: false, seed: true, links: true, thread_id: null });
});

test('chat migration and forget cover guards, notices and corrections independently', t => {
  const { store, subs } = fixture(t);
  subs.protect({ id: 1, type: 'group' }, 'seed', false);
  subs.protect({ id: 2, type: 'private' }, 'links', false);
  store.sql('INSERT INTO corrections (seq,chat_id,tx_hash,message_id) VALUES (1,1,?,88)').run(hex64('0x123'));
  store.sql('INSERT INTO notices (chat_id,body) VALUES (1,?)').run('notice');
  subs.migrate(1, -100);
  assert.equal(subs.protection(-100).seed, false);
  assert.equal(store.sql('SELECT chat_id FROM corrections').get().chat_id, -100);
  subs.forget(-100);
  assert.equal(store.sql('SELECT count(*) AS n FROM corrections').get().n, 0);
  assert.equal(subs.protection(2).links, false);
});

test('an ambiguous correction is claimed, and a definite permission failure can retry', async t => {
  const { store, ops, bot } = fixture(t);
  store.sql('INSERT INTO corrections (seq,chat_id,tx_hash,message_id) VALUES (1,1,?,88)').run(hex64('0x123'));
  let attempts = 0;
  bot.send = async () => { attempts++; throw Error('connection dropped after acceptance'); };
  await assert.rejects(ops.deliver()); await ops.deliver(); assert.equal(attempts, 1);
  store.sql("UPDATE corrections SET state = 'pending'").run();
  bot.send = async () => ({ blocked: true }); await ops.deliver();
  assert.equal(store.sql('SELECT state FROM corrections').get().state, 'pending');
});

test('unrelated AVNU swaps do not pollute the quote paid for a tracked token', () => {
  const venue = { key: 'avnu', aggregator: true, address: 'router' };
  const swaps = [
    { venue, legs: [{ token: 'ETH', amount: -2n }, { token: 'USDC', amount: 50n }] },
    { venue, legs: [{ token: 'USDC', amount: -125n }, { token: 'STRK', amount: 1000n }] },
  ];
  const trade = tradeOf('STRK', swaps, [], [venue]);
  assert.deepEqual([...trade.nets], [['USDC', -125n], ['STRK', 1000n]]);
});

test('a failed forward name check refreshes reverse mapping next pass', async t => {
  const { store } = fixture(t); const address = hex64('0x42'); let forward = '0x0';
  const rpc = { async call(_, p) { return p.request.entry_point_selector === SELECTORS.address_to_domain
    ? ['0x1', `0x${encode('alice').toString(16)}`] : [forward]; } };
  const names = new Names({ contracts: { naming: hex64('0x1') } }, store, rpc);
  assert.equal(await names.display(address, 100), null);
  names.reset(); forward = address; assert.equal(await names.display(address, 101), 'alice.stark');
});

test('optional delivery position has a deterministic fallback', () => {
  const rows = [{ block: 5, eventIndex: 2 }, { block: 4, eventIndex: 1 }, { position: [5, 0, 1] }];
  rows.sort(chainOrder); assert.equal(rows[0].block, 4); assert.deepEqual(rows[1].position, [5, 0, 1]);
});

test('endpoint-list-only config and secondary URL secret redaction', () => {
  const c = loadConfig(['tick'], { TELEGRAM_BOT_TOKEN: `123:${'x'.repeat(32)}`, STARKNET_RPC_URLS: 'https://a.example/keyone,https://b.example/keytwo?q=othersecret', CAIRN_DATA: tmpdir() });
  assert.equal(c.rpcUrls.length, 2); assert.equal(c.httpPort, null);
  const clean = redactor(c); assert.equal(clean('keyone keytwo othersecret'), '[redacted] [redacted] [redacted]');
  assert.throws(() => loadConfig(['tick'], { TELEGRAM_BOT_TOKEN: c.token, STARKNET_RPC_URLS: ',https://a.example', CAIRN_DATA: tmpdir() }));
});
