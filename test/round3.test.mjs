import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeLabel, decodeLabel, Names } from '../src/names.mjs';
import { decodePrice, formatUSD, Prices, priceLine, unavailable } from '../src/prices.mjs';
import { decodeVenue, netTrade, venues } from '../src/venues.mjs';
import { selectTrader, findTrades, sizeDots } from '../src/feed.mjs';
import { hex64, SELECTORS } from '../src/felt.mjs';
import { Store } from '../src/store.mjs';
import { alertLine } from '../src/alerts.mjs';
import { rewatch, Subscriptions } from '../src/subscriptions.mjs';
import { Bot, deliverySummary } from '../src/bot.mjs';
import { Tokens } from '../src/tokens.mjs';
import { links } from '../src/format.mjs';

const address = n => hex64(`0x${n.toString(16)}`);
const [TOKEN, QUOTE, EKUBO, AVNU, TRADER, OTHER, ROUTER, PRAGMA, NAMING] = Array.from({ length: 9 }, (_, i) => address(i + 1));
const vectors = [
  ['a','0x25'], ['b','0x1'], ['aa','0x57e'], ['ab','0x26'], ['ba','0x57f'], ['ben','0x49ed'],
  ['alpha','0x49f69f6'], ['anna','0x1f45fa'], ['nadia','0x49ffb09'], ['banana','0xb05c1d05'],
  ['cairn','0x1ac06ca'], ['starknet','0x1fd32dc5fbc'], ['stark','0x14c695c'], ['zkorp','0x1ebcc55'],
  ['abc-123','0x14dc38343e'], ['a1','0x402'], ['1a','0x599'], ['0','0x1a'], ['-','0x24'],
];
test('Starknet ID architecture vectors encode and decode, including trailing a', () => {
  for (const [label, value] of vectors) {
    assert.equal(encodeLabel(label), value, label);
    assert.equal(decodeLabel(value), label, label);
  }
  for (const bad of ['', 'a.b', 'BAD', 'a_b', 'z'.repeat(60)]) assert.throws(() => encodeLabel(bad), /Invalid/);
});

const swap = (venue, deltas, index = 0) => ({ venue, deltas, index, tx: address(100), block: 11 });
const e = (a, b) => swap('Ekubo', [[TOKEN, a], [QUOTE, b]]);
const a = (x, y) => swap('AVNU', [[TOKEN, x], [QUOTE, y]]);
test('venue netting handles both sides, multihop, and round trips exactly', () => {
  assert.equal(netTrade([e(140n, -280n), e(-40n, 80n)], TOKEN).net, 100n);
  assert.equal(netTrade([e(140n, -280n), e(-40n, 80n)], TOKEN).deltas.get(QUOTE), -200n);
  assert.equal(netTrade([e(100n, -200n), e(-100n, 200n)], TOKEN).net, 0n);
  assert.equal(netTrade([a(100n, -200n), a(-40n, 80n)], TOKEN).net, 60n);
  assert.equal(netTrade([a(100n, -200n), a(-100n, 200n)], TOKEN).net, 0n);
  assert.equal(netTrade([e(-100n, 200n)], TOKEN).net, -100n);
});
test('only AVNU swaps involving the token override Ekubo', () => {
  const result = netTrade([e(100n, -200n), a(75n, -150n)], TOKEN);
  assert.equal(result.venue, 'AVNU'); assert.equal(result.net, 75n);
  const unrelated = swap('AVNU', [[OTHER, 5n], [QUOTE, -2n]]);
  assert.equal(netTrade([e(100n, -200n), unrelated], TOKEN).venue, 'Ekubo');
  assert.equal(netTrade([e(100n, -200n), a(0n, 0n)], TOKEN).net, 0n);
});
test('venue wire decoders invert signed pool deltas and retain AVNU u256 high words', () => {
  const [ekubo, avnu] = venues({ ekubo_core: EKUBO, avnu_exchange: AVNU });
  const raw = { from_address: EKUBO, keys: [SELECTORS.Swapped], block_number: 11, transaction_hash: '0x100', event_index: 2,
    data: [ROUTER, TOKEN, QUOTE, ...Array(9).fill('0x0'), '0x64', '0x1', '0xc8', '0x0', ...Array(5).fill('0x0')] };
  const decoded = decodeVenue([raw], ekubo);
  assert.deepEqual(decoded[0].deltas, [[TOKEN, 100n], [QUOTE, -200n]]);
  const av = { ...raw, from_address: AVNU, keys: [SELECTORS.Swap], data: [ROUTER, TOKEN, '0x7', '0x1', QUOTE, '0xc8', '0x0', ROUTER] };
  assert.equal(netTrade(decodeVenue([av], avnu), TOKEN).net, -(2n ** 128n + 7n));
  assert.equal(decodeVenue([{ ...raw, data: [] }], ekubo).length, 0);
  assert.equal(decodeVenue([{ ...raw, from_address: TRADER }], ekubo).length, 0);
});

const transfer = (from, to, amount, index = 0) => ({ kind: 'Transfer', token: TOKEN, a: from, b: to, amount, index });
test('trader uses net transfers, earliest index ties, and excluded addresses', () => {
  const excluded = [EKUBO, AVNU];
  assert.equal(selectTrader([transfer(EKUBO, OTHER, 80n), transfer(OTHER, TRADER, 60n, 1), transfer(EKUBO, TRADER, 20n, 2)], TOKEN, 100n, excluded), TRADER);
  assert.equal(selectTrader([transfer(EKUBO, OTHER, 50n, 4), transfer(EKUBO, TRADER, 50n, 5)], TOKEN, 100n, excluded), OTHER);
  assert.equal(selectTrader([transfer(EKUBO, TRADER, 50n, 5), transfer(EKUBO, OTHER, 50n, 4)], TOKEN, 100n, excluded), OTHER);
  assert.equal(selectTrader([transfer(TRADER, EKUBO, 50n)], TOKEN, -50n, excluded), TRADER);
  assert.equal(selectTrader([transfer(EKUBO, address(0), 1000n), transfer(EKUBO, AVNU, 2000n), transfer(EKUBO, TRADER, 5n)], TOKEN, 5n, excluded), TRADER);
  assert.equal(selectTrader([transfer(EKUBO, AVNU, 100n)], TOKEN, 100n, excluded), null);
});
test('Pragma scaling, missing price, Option layouts and stale boundary', () => {
  const answer = ['125000000', '8', '1000', '4', '1'];
  assert.equal(decodePrice(answer, 1900).fresh, true);
  assert.equal(decodePrice(answer, 1901).fresh, false);
  assert.equal(decodePrice(answer, 1060).age, 60);
  assert.equal(decodePrice([...answer.slice(0, 4), '0', '1120'], 1060).price, 125000000n);
  assert.deepEqual(decodePrice(['0', '0', '0', '0', '1'], 1060), { status: 'missing', fresh: false });
  assert.throws(() => decodePrice([...answer, '0'], 1060));
  assert.equal(formatUSD(123456789n, 100000n), '$1,234.57');
  assert.equal(formatUSD(1n, 1000n), '<$0.01');
  assert.equal(formatUSD(0n, 1000n), '$0.00');
  assert.equal(formatUSD(1005n, 1000n), '$1.01');
  assert.equal(formatUSD(150n, 100n), '$1.50');
  assert.equal(formatUSD(1n, 1n), '$1.00');
});

test('per-pass price cache is shared by pair, isolated on failure and reset between passes', async () => {
  let calls = 0;
  const rpc = { async call(_, { request }) { calls++; if (request.calldata[1] === '0x4241442f555344') throw new Error(); return ['125000000', '8', '1000', '4', '1']; } };
  const prices = new Prices({ contracts: { pragma: PRAGMA }, priceMaxAge: 900 }, rpc);
  const token = { verified: true, pragma_pair: 'STRK/USD', decimals: 0 };
  assert.equal(await prices.usd(token, 100n, 1060), '$125.00');
  await prices.get(token, 1060); assert.equal(calls, 1);
  assert.deepEqual(await prices.get({ ...token, pragma_pair: 'BAD/USD' }, 1060), unavailable('oracle read failed'));
  assert.equal(await prices.usd({ ...token, verified: false }, 100n, 1060), '');
  prices.reset(); assert.equal(await prices.usd(token, 100n, 1901), '');
});

function state(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cairn-r3-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}
test('reverse names verify all labels even from cache and fail closed on a changed resolution', async t => {
  const store = state(t), calls = []; let owner = TRADER;
  const names = new Names({ contracts: { naming: NAMING } }, store, { async call(_, { request }) {
    calls.push(request);
    return request.entry_point_selector === SELECTORS.address_to_domain ? ['0x2', '0x1', '0x49ed'] : [owner];
  } });
  assert.equal(await names.reverse(TRADER, 1000), 'b.ben.stark');
  assert.deepEqual(calls.at(-1).calldata, ['0x2', '0x1', '0x49ed', '0x0']);
  owner = OTHER; names.reset(); assert.equal(await names.reverse(TRADER, 1001), null);
  await assert.rejects(names.address('a.b.stark'), /Invalid/);
  names.prune(4600);
  assert.equal(store.sql('SELECT count(*) AS n FROM names').get().n, 0);
});

test('trade-to-post integration excludes the fee, verifies names and uses historical balances', async t => {
  const store = state(t), config = { tokens: [{ address: TOKEN, symbol: 'STRK', decimals: 0, pragma_pair: 'STRK/USD' },
    { address: QUOTE, symbol: 'USDC', decimals: 0 }], maxWatches: 20, explorer: 'https://scan.example',
    contracts: { ekubo_core: EKUBO, avnu_exchange: AVNU, pragma: PRAGMA, naming: NAMING }, priceMaxAge: 900 };
  const subs = new Subscriptions(store, config), calls = [];
  subs.feed({ id: -10, type: 'supergroup' }, TOKEN, 0n, false, 'all', 10, 17);
  subs.feed({ id: -11, type: 'supergroup' }, TOKEN, 50n, false, 'all', 10, 21);
  const rpc = { async call(method, params) {
    calls.push({ method, params });
    if (method === 'starknet_getBlockWithTxHashes') return { timestamp: 1060, sequencer_address: OTHER };
    if (method === 'starknet_getTransactionReceipt') return { actual_fee: { unit: 'FRI', amount: '9000' }, events: [{}, {}, {}] };
    if (method === 'starknet_getTransactionByHash') return { sender_address: ROUTER };
    const r = params.request;
    if (r.entry_point_selector === SELECTORS.get_data_median) return ['125000000', '8', '1000', '4', '1'];
    if (r.entry_point_selector === SELECTORS.balance_of) { assert.equal(params.block_id.block_number, 10); return ['0x0', '0x0']; }
    if (r.entry_point_selector === SELECTORS.address_to_domain) return ['0x1', '0x49ed'];
    if (r.entry_point_selector === SELECTORS.domain_to_address) return [TRADER];
    throw new Error('unexpected call');
  } };
  const tokens = new Tokens(config, store, rpc), prices = new Prices(config, rpc), names = new Names(config, store, rpc);
  const metadata = [], get = tokens.get.bind(tokens);
  tokens.get = (...args) => { metadata.push(args[0]); return get(...args); };
  const events = [transfer(EKUBO, TRADER, 100n, 1), transfer(ROUTER, OTHER, 9000n, 2)].map(ev => ({ ...ev, tx: address(100), block: 11 }));
  const posts = await findTrades([e(100n, -200n)], events, { subs, config, tokens, rpc, prices, names, now: 1060, fmt: links(config, String) });
  assert.equal(posts.length, 2); assert.deepEqual(posts.map(p => p.topic), [21, 17]);
  assert.match(posts[0].body, /Buy.*100 STRK/); assert.match(posts[0].body, /\$125/);
  assert.match(posts[0].body, /Paid: 200 USDC/); assert.match(posts[0].body, /ben.stark.*new holder/);
  assert.equal(calls.filter(c => c.method === 'starknet_getTransactionReceipt').length, 1);
  for (const selector of [SELECTORS.balance_of, SELECTORS.address_to_domain, SELECTORS.domain_to_address]) {
    assert.equal(calls.filter(c => c.params.request?.entry_point_selector === selector).length, 1);
  }
  assert.deepEqual(metadata, [TOKEN, QUOTE]);
});

test('one scanner pages three shared filters and the group budget marks feed and wallet summaries durably', async t => {
  const store = state(t), sent = [], filters = [];
  const config = { tokens: [{ address: TOKEN, symbol: 'STRK', decimals: 0 }, { address: QUOTE, symbol: 'USDC', decimals: 0 }],
    contracts: { ekubo_core: EKUBO, avnu_exchange: AVNU }, explorer: 'https://scan.example', maxWatches: 20, maxBlocks: 500 };
  const events = Array.from({ length: 7 }, (_, i) => {
    const common = { block_number: 11, transaction_hash: address(100 + i) };
    return [
      { ...common, from_address: EKUBO, keys: [SELECTORS.Swapped], event_index: 0,
        data: [ROUTER, TOKEN, QUOTE, ...Array(9).fill('0x0'), '0x64', '0x1', '0xc8', '0x0', ...Array(5).fill('0x0')] },
      { ...common, from_address: AVNU, keys: [SELECTORS.Swap], event_index: 1,
        data: [ROUTER, QUOTE, '0xc8', '0x0', TOKEN, '0x64', '0x0', ROUTER] },
      { ...common, from_address: TOKEN, keys: [SELECTORS.Transfer, AVNU, TRADER], data: ['0x64', '0x0'], event_index: 2 },
    ];
  });
  const rpc = { async call(method, params) {
    if (method === 'starknet_getEvents') {
      const f = params.filter; filters.push(f);
      const kind = f.address === EKUBO ? 0 : f.address === AVNU ? 1 : 2;
      const offset = Number(f.continuation_token ?? 0), all = events.map(e => e[kind]);
      return { events: all.slice(offset, offset + 5), ...(offset + 5 < all.length ? { continuation_token: String(offset + 5) } : {}) };
    }
    if (method === 'starknet_getBlockWithTxHashes') return { timestamp: 1060, sequencer_address: OTHER };
    if (method === 'starknet_call') return ['0x0', '0x0'];
    throw new Error(`Unexpected ${method}`);
  } };
  const tg = { async call(method, params) { assert.equal(method, 'sendMessage'); sent.push(params); return { message_id: sent.length }; } };
  const bot = new Bot({ store, config, rpc, tg, clean: String, signal: new AbortController().signal });
  bot.head = { block_number: 11, timestamp: 1060 }; store.cursor = 10;
  const chat = { id: -10, type: 'supergroup' };
  bot.subs.feed(chat, TOKEN, 0n, false, 'all', 10, 17);
  bot.subs.watch(chat, TRADER, null, 10, 21);
  await bot.scan();
  assert.equal(filters.length, 6);
  assert.ok(filters.every(f => f.chunk_size === 1000 && f.from_block.block_number === 11 && f.to_block.block_number === 11));
  assert.equal(store.cursor, 11); assert.equal(bot.ledger.pending().length, 14);
  await bot.deliver();
  assert.equal(sent.length, 3); assert.match(sent[0].text, /AVNU/);
  assert.equal(sent[0].message_thread_id, 17); assert.equal(sent[1].message_thread_id, 21);
  assert.equal(sent[2].text, '…and 12 more: 6 trades, 6 alerts.');
  assert.equal(bot.ledger.pending().length, 0);
  await bot.deliver(); assert.equal(sent.length, 3);
});

test('re-watches preserve topics without a destination and move only to a supplied topic', () => {
  const watch = Object.freeze({ address: TRADER, label: 'Treasury', topic: 17 });
  assert.deepEqual(rewatch(watch, null, null), watch);
  assert.equal(rewatch(watch, null, undefined).topic, 17);
  assert.deepEqual(rewatch(watch, 'Operations', 21), { ...watch, label: 'Operations', topic: 21 });
  assert.equal(rewatch({ ...watch, topic: null }, null, 24).topic, 24);
});

test('approval and revoke lines never show USD, while transfers retain it', () => {
  const token = { symbol: 'STRK', decimals: 0, verified: true }, fmt = links({ explorer: 'https://scan.example' }, String);
  for (const amount of [0n, (1n << 256n) - 1n]) {
    const ev = { ...transfer(TRADER, OTHER, amount), kind: 'Approval' };
    const html = alertLine({ ev, token, role: {}, usd: '$999.00' }, String, fmt);
    assert.match(html, /Approval/); assert.doesNotMatch(html, /\$|≈/);
  }
  assert.match(alertLine({ ev: transfer(TRADER, OTHER, 100n), token, role: {}, usd: '$125.00' }, String, fmt), /≈ \$125.00/);
});

test('price output distinguishes absent oracle data, failures and valid samples', () => {
  const token = { symbol: 'STRK' };
  assert.equal(priceLine(token, decodePrice(['0', '0', '0', '0', '1'], 1060)), 'STRK: no price');
  for (const reason of ['oracle read failed', 'unknown symbol', 'no Pragma pair configured']) {
    assert.equal(priceLine(token, unavailable(reason)), `STRK: unavailable (${reason})`);
  }
  assert.equal(priceLine(token, decodePrice(['125000000', '8', '1000', '4', '1'], 1901)),
    'STRK: $1.25 · 901 seconds old · 4 sources · stale');
});

test('size dots spread USD decades and token-minimum doublings without Number conversion', () => {
  for (const [dollars, expected] of [[10n, 1], [100n, 3], [1000n, 5], [10000n, 7], [100000n, 9], [1000000n, 10]]) {
    assert.equal(sizeDots(1n, 0n, { numerator: dollars * 10n ** 36n, denominator: 10n ** 36n }), expected);
  }
  const minimum = 2n ** 200n;
  assert.equal(sizeDots(minimum, minimum), 1);
  assert.equal(sizeDots(2n * minimum - 1n, minimum), 1);
  assert.equal(sizeDots(2n * minimum, minimum), 2);
  assert.equal(sizeDots(8n * minimum, minimum), 4);
  assert.equal(sizeDots(2n ** 255n, minimum), 10);
  assert.equal(sizeDots(2n ** 255n), 1);
  assert.equal(sizeDots(1n, 0n, { numerator: 1n, denominator: 1000n }), 1);
});

test('budget summaries count trades and alerts and retain the total for other deliveries', () => {
  assert.equal(deliverySummary([{ kind: 'feed' }, { kind: 'feed' }, { kind: 'alert' }]), '…and 3 more: 2 trades, 1 alert.');
  assert.equal(deliverySummary([{ kind: 'track' }, { kind: 'alert' }]), '…and 2 more: 1 alert, 1 update.');
});
