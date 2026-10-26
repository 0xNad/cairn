import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findAlerts } from '../src/alerts.mjs';
import { hex64 } from '../src/felt.mjs';
import { links } from '../src/format.mjs';
import { decodeLabel, encodeLabel, nameOrAddress, parseStarkName } from '../src/names.mjs';
import { atLeastUsd, usdValue } from '../src/prices.mjs';
import { decodeSwaps, findTrader, netTrade, VENUES } from '../src/venues.mjs';

const felt = (v) => `0x${BigInt(v).toString(16)}`;
const A = { token: hex64('0x7'), quote: hex64('0x8'), ekubo: hex64('0xe'), avnu: hex64('0xa'), trader: hex64('0x11'), other: hex64('0x12'), router: hex64('0x13') };
const venue = (name, address) => ({ ...VENUES.find((v) => v.name === name), address });
const ekubo = venue('Ekubo', A.ekubo), avnu = venue('AVNU', A.avnu);
const signed = (n) => [felt(n < 0n ? -n : n), n < 0n ? '0x1' : '0x0'];
const swapped = (d0, d1, t0 = A.token, t1 = A.quote, index = 0) => ({ from_address: A.ekubo, keys: [ekubo.selector], block_number: 5, transaction_hash: '0x99', event_index: index,
  data: [A.router, t0, t1, '0x0', '0x1', '0x0', '0x1', '0x0', '0x0', '0x0', '0x0', '0x0', ...signed(d0), ...signed(d1), '0x0', '0x0', '0x0', '0x0', '0x1'] });
const swap = (sell, sellAmount, buy, buyAmount, index = 0) => ({ from_address: A.avnu, keys: [avnu.selector], block_number: 5, transaction_hash: '0x99', event_index: index,
  data: [A.router, sell, felt(sellAmount & (2n ** 128n - 1n)), felt(sellAmount >> 128n), buy, felt(buyAmount), '0x0', A.router] });
const swaps = (ekuboRaw, avnuRaw = []) => [...decodeSwaps(avnu, avnuRaw), ...decodeSwaps(ekubo, ekuboRaw)];

test('Ekubo deltas are the pool side: the trader gets their opposite, netted over hops', () => {
  const buy = netTrade(swaps([swapped(-140n, 280n), swapped(40n, -80n, A.token, A.quote, 1)]), A.token);
  assert.equal(buy.venue.name, 'Ekubo');
  assert.equal(buy.net, 100n);
  assert.deepEqual(buy.paid, [A.quote, -200n]);
  assert.equal(netTrade(swaps([swapped(200n, -100n, A.quote, A.token)]), A.token).net, 100n);
  assert.equal(netTrade(swaps([swapped(-100n, 200n), swapped(100n, -200n, A.token, A.quote, 1)]), A.token).net, 0n);
});

test('an AVNU swap involving the token takes precedence over Ekubo in the same transaction', () => {
  const route = swaps([swapped(-100n, 200n, A.token, A.quote, 1)], [swap(A.quote, 200n, A.token, 100n)]);
  assert.equal(netTrade(route, A.token).venue.name, 'AVNU');
  const unrelated = swaps([swapped(-100n, 200n, A.token, A.quote, 1)], [swap(A.quote, 10n, A.other, 20n)]);
  assert.equal(netTrade(unrelated, A.token).venue.name, 'Ekubo');
  assert.equal(netTrade(swaps([], [swap(A.token, 2n ** 128n + 7n, A.quote, 200n)]), A.token).net, -(2n ** 128n + 7n));
});

test('the trader is the largest net mover, ties to the earliest event, excluded addresses never', () => {
  const t = (a, b, amount, index) => ({ a, b, amount, index });
  const excluded = new Set([hex64('0x0'), A.ekubo, A.avnu]);
  assert.equal(findTrader([t(A.ekubo, A.other, 50n, 1), t(A.ekubo, A.trader, 50n, 2)], 'buy', excluded), A.other);
  assert.equal(findTrader([t(A.ekubo, A.other, 80n, 1), t(A.other, A.trader, 60n, 2), t(A.ekubo, A.trader, 20n, 3)], 'buy', excluded), A.trader);
  assert.equal(findTrader([t(A.ekubo, A.router, 140n, 1), t(A.router, A.ekubo, 40n, 2), t(A.router, A.trader, 100n, 3)], 'buy', excluded), A.trader);
  assert.equal(findTrader([t(A.trader, A.avnu, 9n, 1)], 'sell', excluded), A.trader);
  assert.equal(findTrader([t(A.ekubo, A.avnu, 100n, 1)], 'buy', excluded), null);
});

test('Starknet ID labels match the architecture vectors and bad names are refused', () => {
  for (const [label, value] of [['a', 0x25n], ['ben', 0x49edn], ['banana', 0xb05c1d05n], ['abc-123', 0x14dc38343en], ['0', 0x1an], ['-', 0x24n]]) {
    assert.equal(encodeLabel(label), value, label);
    assert.equal(decodeLabel(value), label, label);
  }
  for (const name of ['a.b.stark', 'BAD.stark', 'a_b.stark', `${'z'.repeat(60)}.stark`]) assert.ok(parseStarkName(name).error, name);
});

test('USD values and dollar floors are exact, equality included', () => {
  const quote = { price: 125000000n, decimals: 8 };
  assert.equal(usdValue(100n, 0, quote), '125.00');
  assert.ok(atLeastUsd(100n, 0, quote, 12500n));
  assert.ok(!atLeastUsd(100n, 0, quote, 12600n));
});

test('a name.stark stands for its address wherever an address is typed, and 0x0 is refused', async () => {
  const calls = [];
  const rpc = { call: async (method, { request }) => { calls.push(request.calldata); return [request.calldata[1] === '0x49ed' ? A.trader : '0x0']; } };
  const ctx = { config: { contracts: { naming: hex64('0x77') } }, rpc };
  assert.deepEqual(await nameOrAddress('0x123', ctx), { value: '0x123' });
  assert.deepEqual(await nameOrAddress('ben.stark', ctx), { value: A.trader, name: 'ben.stark' });
  assert.deepEqual(calls, [['0x1', '0x49ed', '0x0']]);
  assert.match((await nameOrAddress('nobody.stark', ctx)).error, /Unknown name/);
  assert.match((await nameOrAddress('a.b.stark', ctx)).error, /not supported/);
  assert.match((await nameOrAddress('ben.stark', { ...ctx, config: { contracts: { naming: null } } })).error, /unavailable/);
});

test('watch and whale alerts show a verified reverse name, a chat label first, else the short address', async () => {
  const ev = (a, b, index) => ({ kind: 'Transfer', token: A.token, a, b, amount: 5n, legacy: false, block: 9, tx: hex64('0x99'), index });
  const interests = { watchers: new Map([[A.trader, [{ chatId: 1, since: 0, thread: null }]]]), whales: new Map(), muted: new Set(),
    floors: new Map(), labels: new Map(), feeds: new Map() };
  const context = {
    interests, now: 1000, fmt: links({ explorer: 'https://scan.example' }, (v) => v),
    tokens: { get: async () => ({ address: A.token, symbol: 'STRK', decimals: 0, verified: true }), strk: hex64('0x4718') },
    rpc: { call: async () => ({ timestamp: 1000, sequencer_address: '0x5' }) },
    names: { reverse: async (address) => (address === A.trader ? 'ben.stark' : null) },
  };
  const [named] = (await findAlerts([ev(A.other, A.trader, 1)], context)).deliveries;
  assert.match(named.body, />ben\.stark</);
  assert.ok(named.body.includes(`https://scan.example/contract/${A.other}`));
  interests.labels.set(1, new Map([[A.trader, 'Treasury']]));
  const [labelled] = (await findAlerts([ev(A.other, A.trader, 2)], context)).deliveries;
  assert.match(labelled.body, />Treasury</);
  assert.doesNotMatch(labelled.body, /ben\.stark/);
});
