import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { FIELD, hex64, i129, SELECTORS } from '../src/felt.mjs';
import { dollars, links, messages } from '../src/format.mjs';
import { decode, encode, parseName, parseReverse } from '../src/names.mjs';
import { atLeast, centsOf, parseMedian, usdText, valueOf } from '../src/prices.mjs';
import { decodeTokenEvents } from '../src/scanner.mjs';
import { Store } from '../src/store.mjs';
import { Subscriptions } from '../src/subscriptions.mjs';
import { plan, summarise } from '../src/summary.mjs';
import { feeIndexOf, sizeBar, tradeOf, traderOf } from '../src/trades.mjs';
import { decodeSwaps, venuesOf } from '../src/venues.mjs';
import { parseHtml } from '../.launchpad/checks/round-3/fake-telegram.mjs';

const felt = (v) => `0x${BigInt(v).toString(16)}`;
const address = (n) => hex64(felt(n));
const EKUBO = address(0xe0), AVNU = address(0xa0), TOKEN = address(0x70), QUOTE = address(0x71), OTHER = address(0x72);
const ROUTER = address(0x10), TRADER = address(0x20), PEER = address(0x21), SEQUENCER = address(0x5e9);
const config = { contracts: { ekubo_core: EKUBO, avnu_exchange: AVNU }, explorer: 'https://x.example' };
const venues = venuesOf(config);
const plain = (html) => { const r = parseHtml(html); assert.equal(r.error, undefined, r.error); return r.plain; };

let index = 0;
const at = (e, tx = 1) => ({ ...e, block_number: 11, transaction_hash: felt(tx), transaction_index: 0, event_index: index++ });
const signed = (n) => [felt(n < 0n ? -n : n), n < 0n ? '0x1' : '0x0'];
const ekubo = (d0, d1, token0 = TOKEN, token1 = QUOTE) => at({ from_address: EKUBO, keys: [SELECTORS.Swapped],
  data: [ROUTER, token0, token1, '0x0', '0x1', '0x0', '0x1', '0x0', '0x0', '0x0', '0x0', '0x0', ...signed(d0), ...signed(d1), '0x0', '0x0', '0x0', '0x0', '0x1'] });
const words = (v) => [felt(v & ((1n << 128n) - 1n)), felt(v >> 128n)];
const avnu = (sell, sold, buy, bought) => at({ from_address: AVNU, keys: [SELECTORS.Swap], data: [ROUTER, sell, ...words(sold), buy, ...words(bought), ROUTER] });
const transfer = (from, to, value, token = TOKEN) => at({ from_address: token, keys: [SELECTORS.Transfer, from, to], data: [felt(value), '0x0'] });
/** One transaction's swaps and token events, as the scanner hands them to the trade feed. */
function tx(events) {
  const swaps = venues.flatMap((v) => decodeSwaps(v, events.filter((e) => e.from_address === v.address)));
  const transfers = decodeTokenEvents(events.filter((e) => e.keys[0] === SELECTORS.Transfer));
  index = 0;
  return { swaps, transfers };
}
const trade = (events, token = TOKEN) => { const t = tx(events); return tradeOf(token, t.swaps, t.transfers, venues); };

test('every name vector of ARCHITECTURE.md encodes to its felt and decodes back', () => {
  const vectors = [['a', 0x25], ['b', 0x1], ['aa', 0x57e], ['ab', 0x26], ['ba', 0x57f], ['ben', 0x49ed], ['alpha', 0x49f69f6],
    ['anna', 0x1f45fa], ['nadia', 0x49ffb09], ['banana', 0xb05c1d05], ['cairn', 0x1ac06ca], ['starknet', 0x1fd32dc5fbc],
    ['stark', 0x14c695c], ['zkorp', 0x1ebcc55], ['abc-123', 0x14dc38343e], ['a1', 0x402], ['1a', 0x599], ['0', 0x1a], ['-', 0x24]];
  for (const [label, value] of vectors) {
    assert.equal(encode(label), BigInt(value), label);
    assert.equal(decode(BigInt(value)), label, label);
    assert.deepEqual(parseName(`${label}.stark`), { name: `${label}.stark`, labels: [BigInt(value)] });
  }
});

test('names Cairn cannot accept are refused with a reason, before any call', () => {
  assert.match(parseName('a.b.stark').error, /not supported/);
  assert.match(parseName('BAD.stark').error, /Invalid name.*lowercase: try bad\.stark/);
  assert.match(parseName('ben.STARK').error, /lowercase/);
  assert.match(parseName('a_b.stark').error, /Invalid name/);
  assert.match(parseName('.stark').error, /Invalid name/);
  assert.ok(encode('z'.repeat(60)) >= FIELD);
  assert.match(parseName(`${'z'.repeat(60)}.stark`).error, /too long/);
  // address_to_domain answers [n, label…]: [0] is no name, and any other shape is no answer at all.
  assert.deepEqual(parseReverse(['0x0']), []);
  assert.deepEqual(parseReverse(['0x2', '0x1', '0x49ed']), [1n, 0x49edn]);
  assert.equal(parseReverse(['0x2', '0x1']), null);
});

test('venue events decode to legs from the trader side: Ekubo deltas flip sign, AVNU sells and buys', () => {
  assert.equal(i129('0x5', '0x1'), -5n);
  assert.equal(i129('0x5', '0x0'), 5n);
  assert.throws(() => i129('0x5', '0x2'));
  const { swaps } = tx([ekubo(-100n, 200n), avnu(QUOTE, 2n ** 128n + 7n, TOKEN, 100n), { ...ekubo(1n, 1n), data: ['0x1'] }]);
  assert.equal(swaps.length, 2); // a Swapped of another shape is ignored
  assert.deepEqual(swaps.find((s) => s.venue.key === 'ekubo').legs, [{ token: TOKEN, amount: 100n }, { token: QUOTE, amount: -200n }]);
  assert.deepEqual(swaps.find((s) => s.venue.key === 'avnu').legs, [{ token: QUOTE, amount: -(2n ** 128n + 7n) }, { token: TOKEN, amount: 100n }]);
  assert.deepEqual(venues.map((v) => v.name), ['AVNU', 'Ekubo']); // the aggregator comes first
});

test('trades net per transaction as the brief defines: buys, sells, multi-hop, round trips and AVNU precedence', () => {
  const net = (events, token) => { const t = trade(events, token); return t && [t.venue.name, t.net]; };
  assert.deepEqual(net([ekubo(-100n, 200n), transfer(EKUBO, TRADER, 100n)]), ['Ekubo', 100n]);
  assert.deepEqual(net([ekubo(100n, -200n), transfer(TRADER, EKUBO, 100n)]), ['Ekubo', -100n]);
  assert.deepEqual(net([ekubo(200n, -100n, QUOTE, TOKEN)]), ['Ekubo', 100n]); // the token as token1
  assert.deepEqual(net([ekubo(-140n, 280n), ekubo(40n, -80n)]), ['Ekubo', 100n]); // multi-hop nets
  assert.equal(net([ekubo(-100n, 200n), ekubo(100n, -200n)]), null); // a round trip posts nothing
  assert.deepEqual(net([avnu(QUOTE, 200n, TOKEN, 100n), ekubo(-100n, 200n)]), ['AVNU', 100n]); // Ekubo is AVNU's route
  assert.deepEqual(net([avnu(QUOTE, 200n, TOKEN, 100n), avnu(TOKEN, 40n, QUOTE, 80n)]), ['AVNU', 60n]);
  assert.equal(net([avnu(QUOTE, 200n, TOKEN, 100n), avnu(TOKEN, 100n, QUOTE, 200n)]), null);
  assert.deepEqual(net([avnu(QUOTE, 10n, OTHER, 20n), ekubo(-100n, 200n), transfer(EKUBO, TRADER, 100n)]), ['Ekubo', 100n]); // unrelated AVNU
  // What was paid: the other tokens the venue moved the other way.
  assert.deepEqual([...trade([avnu(QUOTE, 200n, TOKEN, 100n), avnu(TOKEN, 40n, QUOTE, 80n)]).nets], [[QUOTE, -120n], [TOKEN, 60n]]);
});

test('a token that only passes through AVNU on its route, as on mainnet, nets to zero instead of a false Ekubo trade', () => {
  // Mainnet transaction 0x11cc31…eef (block 16866600): 0.08306787 ETH sold through AVNU for 4,093.416… STRK, routed
  // ETH → USDC.e → USDC on Ekubo, then USDC → STRK on another pool. AVNU's Swap names ETH and STRK only.
  const [eth, usdc, usdce, strk] = ['0x49d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7', '0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb',
    '0x53c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8', '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'].map(hex64);
  const user = hex64('0x5d49ebf89d6367d92db6d7907cc4a47fb16808f4025b8ed46e24bfcc36800ae'), router = hex64('0x199741822c2dc722f6f605204f35e56dbc23bceed54818168c4c49e4fb8737e');
  const pool = hex64('0x20d2431b'), seq = hex64('0x1176a1bd84444c89232ec27754698e5d2e7e1a7f1539f12027f28b23ec9f3d8');
  const real = { contracts: { ekubo_core: hex64('0x5dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b'), avnu_exchange: hex64('0x4270219d365d6b017231b52e92b3fb5d7c8378b05e9abc97724537a80e93b0f') } };
  const vs = venuesOf(real), [A, E] = [real.contracts.avnu_exchange, real.contracts.ekubo_core];
  const ev = (i, from, keys, data) => ({ from_address: from, keys, data, block_number: 16866600, transaction_hash: '0x11cc314149fb86d44567f84a2895cb5895f23e67a04d8b22b9e686a11e90eef', transaction_index: 1, event_index: i });
  const t = (i, token, from, to, v) => ev(i, token, [SELECTORS.Transfer, from, to], [felt(v), '0x0']);
  const events = [
    t(2, eth, user, A, 0x1271dc9a3992c00n), t(4, eth, A, router, 0x126d23ce4b6f880n),
    ev(5, E, [SELECTORS.Swapped], [router, eth, usdce, '0x20c49ba5e353f80000000000000000', '0x3e8', '0x0', '0x126d23ce4b6f880', '0x0', '0x0', '0x32ff228c6474010d17aa5a124c022', '0x0', '0x64', '0x126d23ce4b6f880', '0x0', '0xbb2b8ec', '0x1', '0x3300dc875f6d0e4029b048337b4b9', '0x0', '0x12f1262', '0x1', '0x6cf2d18db547f6']),
    ev(12, E, [SELECTORS.Swapped], [router, usdc, usdce, '0x0', '0x65', '0x0', '0xbb2b8ec', '0x0', '0x1', '0x1e3f9d52cc2bf6d6be37cb3b32567', '0x1', '0x64', '0xbb28d89', '0x1', '0xbb2b8ec', '0x0', '0x1ddcf3d1acdd4b4d8c953efb99b81', '0x1', '0x38', '0x0', '0x1e5a72be988c3']),
    t(13, usdc, E, router, 0xbb28d89n), t(17, usdc, router, A, 0xbb28d89n), t(19, usdc, A, pool, 0xbb28d89n),
    t(20, strk, pool, A, 0xdde79090f6ca5e420fn), t(22, strk, A, user, 0xdde79090f6ca5e420fn),
    ev(23, A, [SELECTORS.Swap], [user, eth, '0x1271dc9a3992c00', '0x0', strk, '0xdde79090f6ca5e420f', '0x0', user]),
    t(24, strk, user, seq, 0x70d1a431d93b28an),
  ];
  const swaps = vs.flatMap((v) => decodeSwaps(v, events.filter((e) => e.from_address === v.address)));
  const transfers = decodeTokenEvents(events.filter((e) => e.keys[0] === SELECTORS.Transfer));
  assert.equal(tradeOf(usdc, swaps, transfers, vs), null); // without the route rule: a 196.251017 USDC "buy" on Ekubo
  const buy = tradeOf(strk, swaps, transfers, vs);
  assert.deepEqual([buy.venue.name, buy.net, buy.nets.get(eth)], ['AVNU', 4_093_416_436_298_850_124_303n, -83_067_870_000_000_000n]);
  const fee = feeIndexOf({ swaps, transfers }, strk, seq);
  assert.equal(fee, 24);
  assert.equal(traderOf(strk, 'buy', transfers, new Set([A, E]), fee), user);
  assert.equal(tradeOf(eth, swaps, transfers, vs).net, -83_067_870_000_000_000n); // the ETH side is a sell
});

test('the trader comes from transfers: largest net, earliest event on a tie, never a venue, the zero address or the fee', () => {
  const excluded = new Set([EKUBO, AVNU]);
  const who = (events, side = 'buy', fee = null) => traderOf(TOKEN, side, tx(events).transfers, excluded, fee);
  assert.equal(who([transfer(EKUBO, ROUTER, 100n), transfer(ROUTER, TRADER, 100n)]), TRADER); // a router nets to zero
  assert.equal(who([transfer(EKUBO, PEER, 80n), transfer(PEER, TRADER, 60n), transfer(EKUBO, TRADER, 20n)]), TRADER);
  assert.equal(who([transfer(EKUBO, PEER, 50n), transfer(EKUBO, TRADER, 50n)]), PEER); // the tie goes to the earlier event
  assert.equal(who([transfer(EKUBO, AVNU, 100n), transfer(EKUBO, hex64('0x0'), 5n)]), null); // nobody qualifies
  assert.equal(who([transfer(TRADER, EKUBO, 100n), transfer(PEER, SEQUENCER, 900n)], 'sell', 1), TRADER); // the fee is left out
  assert.equal(who([transfer(TRADER, EKUBO, 100n), transfer(PEER, SEQUENCER, 900n)], 'sell'), PEER);
  const fee = tx([ekubo(-100n, 200n), transfer(EKUBO, TRADER, 100n), transfer(ROUTER, SEQUENCER, 9n)]);
  assert.equal(feeIndexOf(fee, TOKEN, SEQUENCER), 2);
  const notLast = tx([transfer(ROUTER, SEQUENCER, 9n), ekubo(-100n, 200n)]);
  assert.equal(feeIndexOf(notLast, TOKEN, SEQUENCER), null);
});

test('Pragma answers parse in both expiration layouts, and price 0 means no price', () => {
  assert.deepEqual(parseMedian(['0x773594', '0x8', '0x6adca2ca', '0xa', '0x1']), { price: 0x773594n, decimals: 8, timestamp: 0x6adca2ca, sources: 10 });
  assert.deepEqual(parseMedian(['0x493e1c', '0x8', '0x6adca2ca', '0xa', '0x0', '0x0']), { price: 0x493e1cn, decimals: 8, timestamp: 0x6adca2ca, sources: 10 });
  assert.deepEqual(parseMedian(['0x0', '0x0', '0x0', '0x0', '0x1']), { missing: true });
  for (const bad of [['0x1', '0x8', '0x1', '0x1', '0x0'], ['0x1', '0x8', '0x1', '0x1', '0x1', '0x0'], ['0x1'], null]) assert.equal(parseMedian(bad), null);
});

test('USD values are exact, rounded half up to cents, and a dollar floor includes equality', () => {
  const sample = { price: 125_000_000n, decimals: 8 };
  assert.equal(centsOf(valueOf(100n, 0, sample)), 12_500n);
  assert.ok(atLeast(valueOf(100n, 0, sample), 12_500n) && !atLeast(valueOf(100n, 0, sample), 12_501n));
  const strk = { price: 4_774_266n, decimals: 8 }; // live STRK/USD on 24 Oct 2026
  assert.equal(dollars(centsOf(valueOf(17_802_368_766_626_936_800_896n, 18, strk))), '$849.93');
  assert.equal(centsOf({ num: 5n, den: 1000n }), 1n); // half a cent rounds up
  assert.equal(centsOf({ num: 4n, den: 1000n }), 0n);
  // Shown, any value above zero below a cent is <$0.01, as ARCHITECTURE.md says, even when it would round up.
  assert.equal(usdText({ num: 7n, den: 1000n }), '<$0.01');
  assert.equal(usdText({ num: 1n, den: 100n }), '$0.01');
  assert.equal(usdText({ num: 0n, den: 100n }), '$0.00');
  assert.equal(usdText({ num: 1_234_565n, den: 1000n }), '$1,234.57');
  assert.equal(dollars(0n, true), '<$0.01');
  assert.equal(dollars(123_456_789n), '$1,234,567.89');
});

test('a reply line too long for Telegram goes as plain text in pieces instead of stopping the bot', () => {
  const html = `No watch here matches <b>${'&amp;'.repeat(900)}</b>.`;
  const parts = messages([html]);
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 4096));
  assert.equal(parts.map((p) => plain(p)).join('').replaceAll('\n', ''), `No watch here matches ${'&'.repeat(900)}.`);
  // Names a person typed are echoed only in part.
  assert.ok(parseName(`${'&'.repeat(900)}.b.stark`).error.length < 200);
  assert.ok(parseName(`${'A'.repeat(4000)}.stark`).error.length < 200);
});

test('the size bar grows by half-decades of USD, and by multiples of the floor without a price', () => {
  assert.equal(sizeBar('buy', 900n, 1n, null), '🟢'); // $9
  assert.equal(sizeBar('buy', 12_500n, 1n, null), '🟢🟢🟢🟢'); // $125: past $10, $30 and $100
  assert.equal(sizeBar('sell', 100_000_000n, 1n, null), `${'🔴'.repeat(12)} 🐋`); // $1,000,000: every step
  assert.equal(sizeBar('buy', null, 1000n, 100n), '🟢🟢🟢'); // 10 times the floor
  assert.equal(sizeBar('buy', null, 1000n, null), '🟢');
});

test('a group gets two alerts and a summary when more than three are due; a private chat gets them all', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => i);
  for (const n of [0, 1, 2, 3]) assert.deepEqual(plan(rows(n), 'supergroup', 0), { full: rows(n), rest: [] });
  assert.deepEqual(plan(rows(4), 'group', 0), { full: [0, 1], rest: [2, 3] });
  assert.deepEqual(plan(rows(8), 'supergroup', 0), { full: [0, 1], rest: [2, 3, 4, 5, 6, 7] });
  assert.deepEqual(plan(rows(8), 'private', 0), { full: rows(8), rest: [] });
  assert.deepEqual(plan(rows(3), 'supergroup', 2), { full: [], rest: [0, 1, 2] }); // one message left: the summary
  assert.deepEqual(plan(rows(3), 'supergroup', 3), { full: [], rest: [] }); // spent: the alerts wait for the next pass
});

test('in a burst, the alerts sent in full are a track update and then the largest USD values, in chain order', () => {
  const trade = (n, cents) => ({ n, kind: 'trade', digest: JSON.stringify({ k: 'trade', token: TOKEN, amount: '1', cents: cents === null ? null : String(cents) }) });
  const burst = [trade(0, 1_000), trade(1, 50_000), trade(2, null), { n: 3, kind: 'track', digest: null }, trade(4, 100_000), trade(5, 50_000)];
  const { full, rest } = plan(burst, 'supergroup', 0);
  assert.deepEqual(full.map((r) => r.n), [3, 4]);
  assert.deepEqual(rest.map((r) => r.n), [0, 1, 2, 5]);
  const ties = [trade(0, 500), trade(1, 500), trade(2, 500), trade(3, 500)];
  assert.deepEqual(plan(ties, 'supergroup', 0).full.map((r) => r.n), [0, 1]);
  const unpriced = ['5', '900', '70', '900'].map((amount, n) => ({ n, kind: 'trade', digest: JSON.stringify({ k: 'trade', token: TOKEN, amount, cents: null }) }));
  assert.deepEqual(plan(unpriced, 'supergroup', 0).full.map((r) => r.n), [1, 3]); // one token: by amount
  // An approval by a watched wallet outranks any trade: a group should see it, not a count of it.
  const approval = { n: 9, kind: 'alert', digest: JSON.stringify({ k: 'alert', approval: true, cents: null }) };
  assert.deepEqual(plan([trade(0, 1_000), trade(1, 50_000), approval, trade(3, 100_000)], 'supergroup', 0).full.map((r) => r.n), [9, 3]);
});

test('a summary counts what it covers: trades per token and side with totals, wallet alerts and tracks', () => {
  const fmt = links({ explorer: 'https://x.example' }, String);
  const t = (side, amount, cents, tx) => ({ kind: 'trade', block: 12, tx_hash: hex64(felt(tx)),
    digest: JSON.stringify({ k: 'trade', side, token: TOKEN, symbol: 'STRK', verified: true, decimals: 0, amount: String(amount), cents: String(cents) }) });
  const html = summarise([t('buy', 100, 12_500, 1), t('buy', 300, 37_500, 2), t('sell', 50, 6_250, 3),
    { kind: 'alert', block: 13, tx_hash: hex64('0x4'), digest: JSON.stringify({ k: 'alert', whale: true, approval: true }) },
    { kind: 'alert', block: 13, tx_hash: hex64('0x6'), digest: null }, { kind: 'track', block: null, tx_hash: hex64('0x5'), digest: null }], fmt);
  assert.equal(plain(html), '➕ 6 more in blocks 12–13, summarised to keep the group readable:\n🟢 2 buys · 400 STRK · ≈$500.00\n' +
    '🔴 1 sell · 50 STRK · ≈$62.50\n👁 2 wallet alerts, 1 with a whale move 🐋, 1 with an approval 🔑: 1 · 2\n⏱ 1 tracked transaction update: 1\nLargest: Buy 300 STRK ≈$375.00');
  for (const tx of ['0x2', '0x4', '0x6', '0x5']) assert.ok(html.includes(`href="https://x.example/tx/${hex64(tx)}"`), tx);
  // Dust adds up exactly: three trades of $0.004 are $0.012, not three rounded zeros.
  const dust = (n) => ({ kind: 'trade', block: 12, tx_hash: hex64(felt(n)), digest: JSON.stringify({ k: 'trade', side: 'buy', token: TOKEN, symbol: 'STRK',
    verified: true, decimals: 0, amount: '1', cents: '0', value: ['4', '1000'] }) });
  assert.match(plain(summarise([dust(1), dust(2), dust(3)], fmt)), /3 buys · 3 STRK · ≈\$0\.01\n/);
  assert.match(plain(summarise([dust(1)], fmt)), /1 buy · 1 STRK · ≈<\$0\.01\n/);
});

test('the trade feed posts what a chat asked for: dollar floors at equality, fresh prices only, names proven, no USD when unverified', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'cairn-feed-')));
  try {
    const NAMING = address(0x4a), PRAGMA = address(0x9a), STRANGE = address(0x73);
    const cfg = { tokens: [{ symbol: 'STRK', address: TOKEN, decimals: 0, pragma_pair: 'STRK/USD' }, { symbol: 'USDC', address: QUOTE, decimals: 0, pragma_pair: 'USDC/USD' }],
      contracts: { ...config.contracts, naming: NAMING, pragma: PRAGMA }, priceMaxAge: 900, maxWatches: 20, explorer: 'https://x.example' };
    let updated = 1_000, quote = '0x7752e0', calls = [];
    const rpc = { async call(method, params) {
      calls.push([method, params]);
      if (method === 'starknet_getBlockWithTxHashes') return { timestamp: 1_100, sequencer_address: SEQUENCER };
      const { contract_address: at, entry_point_selector: sel, calldata } = params.request;
      if (at === PRAGMA) return [quote, '0x8', felt(updated), '0x4', '0x1']; // $0.0782, 4 sources
      if (at === NAMING && sel === SELECTORS.address_to_domain) return calldata[0] === TRADER ? ['0x1', '0x49ed'] : ['0x0'];
      if (at === NAMING) return [calldata[1] === '0x49ed' ? TRADER : '0x0'];
      if (sel === SELECTORS.balance_of) return ['0x0', '0x0'];
      if (sel === SELECTORS.decimals) return ['0x0'];
      if (sel === SELECTORS.symbol) return [felt(Buffer.from('ODD').readUIntBE(0, 3))];
      throw new Error(`unexpected call ${method}`);
    } };
    const subs = new Subscriptions(store, cfg), chat = (id) => ({ id, type: 'private' });
    store.transaction(() => {
      subs.feed(chat(1), { token: TOKEN, symbol: 'STRK', min: '$78.20', minUsd: 7_820n, mode: 'buys' }, 10);
      subs.feed(chat(2), { token: STRANGE, symbol: 'ODD', mode: 'all' }, 10);
    });
    const { Tokens } = await import('../src/tokens.mjs'), { Names } = await import('../src/names.mjs'), { Prices } = await import('../src/prices.mjs');
    const { tradeFeed } = await import('../src/trades.mjs'), { blockHeaders, TOKEN_EVENTS } = await import('../src/scanner.mjs');
    const feed = tradeFeed(venues), run = async (events) => {
      const prices = new Prices(cfg, rpc), names = new Names(cfg, store, rpc);
      const byFilter = new Map([[TOKEN_EVENTS, events.filter((e) => e.keys[0] === SELECTORS.Transfer)], ...venues.map((v) => [v.filter, events.filter((e) => e.from_address === v.address)])]);
      index = 0;
      return (await feed.find(byFilter, { interests: subs.interests(), tokens: new Tokens(cfg, store, rpc), rpc, now: 1_100, fmt: links(cfg, String), header: blockHeaders(rpc), prices, names })).deliveries;
    };
    // 1,000 STRK at $0.0782 is exactly $78.20: the floor includes it. The trader is proven to be ben.stark and held none before.
    const [post, ...others] = await run([ekubo(-1000n, 78n), transfer(EKUBO, TRADER, 1000n)]);
    assert.equal(others.length, 0);
    assert.equal(post.chatId, 1);
    assert.equal(plain(post.body), '🟢🟢🟢 Buy STRK · ≈$78.20\n1,000 STRK for 78 USDC\n👤 ben.stark · 🆕 new holder\nEkubo · 1970-01-01 00:18:20 UTC · View transaction');
    assert.ok(calls.some(([m, p]) => m === 'starknet_call' && p.request.entry_point_selector === SELECTORS.balance_of && p.block_id.block_number === 10)); // block − 1
    // The outside-registry token's sell goes to the chat that follows it, with no dollar sign anywhere.
    const [odd] = await run([ekubo(5n, -9n, STRANGE, QUOTE), transfer(PEER, EKUBO, 5n, STRANGE)]);
    assert.equal(odd.chatId, 2);
    assert.match(plain(odd.body), /^🔴 Sell ODD \(unverified, 0x0000…0073\)\n5 ODD for 9 USDC\n👤 0x0000…0021\n/);
    assert.ok(!odd.body.includes('$'));
    // A trade below a cent shows <$0.01, escaped: Telegram would refuse a bare "<". ($0.001 a token here.)
    store.transaction(() => subs.feed(chat(1), { token: TOKEN, symbol: 'STRK', mode: 'buys' }, 10));
    quote = '0x186a0';
    const [dust] = await run([ekubo(-1n, 0n), transfer(EKUBO, TRADER, 1n)]);
    assert.ok(dust.body.includes('≈&lt;$0.01') && plain(dust.body).startsWith('🟢 Buy STRK · ≈<$0.01'));
    // A stale price proves nothing: a trade far above the dollar floor stays unposted, yet posts without a floor.
    store.transaction(() => subs.feed(chat(1), { token: TOKEN, symbol: 'STRK', min: '$78.20', minUsd: 7_820n, mode: 'buys' }, 10));
    [quote, updated] = ['0x7752e0', 1_100 - 901];
    assert.deepEqual(await run([ekubo(-100000n, 7800n), transfer(EKUBO, TRADER, 100000n)]), []);
    store.transaction(() => subs.feed(chat(1), { token: TOKEN, symbol: 'STRK', mode: 'buys' }, 10));
    const [unpriced] = await run([ekubo(-100000n, 7800n), transfer(EKUBO, TRADER, 100000n)]);
    assert.ok(!unpriced.body.includes('$') && plain(unpriced.body).startsWith('🟢 Buy STRK\n100,000 STRK for 7,800 USDC'));
  } finally { store.close(); }
});

test('a chat keeps one feed: another token replaces it, the same token updates it, and forget removes it', () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'cairn-r3-')));
  try {
    const subs = new Subscriptions(store, { maxWatches: 20 }), chat = { id: -7, type: 'supergroup' };
    const set = (token, extra = {}) => store.transaction(() => subs.feed(chat, { token, symbol: 'T', mode: 'buys', ...extra }, 10, 17));
    assert.equal(set(TOKEN).status, 'added');
    assert.equal(set(TOKEN, { min: '$100.00', minUsd: 10_000n, mode: 'all' }).status, 'updated');
    assert.deepEqual(subs.export(-7).feed, { token: TOKEN, symbol: 'T', min: '$100.00', side: 'all', since_block: 10, thread_id: 17 });
    assert.equal(set(QUOTE).previous.token, TOKEN);
    assert.deepEqual([...subs.interests().feeds.keys()], [QUOTE]);
    assert.equal(store.transaction(() => subs.forget(-7)).feeds, 1);
    assert.equal(subs.export(-7).feed, null);
  } finally { store.close(); }
});

test("a round 2 state.db gains round 3's columns and tables in place, keeping its data", () => {
  const directory = mkdtempSync(join(tmpdir(), 'cairn-r2-db-'));
  const old = new DatabaseSync(join(directory, 'state.db'));
  old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE watches (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, address TEXT NOT NULL, label TEXT, since_block INTEGER NOT NULL, UNIQUE (chat_id, address)) STRICT;
    CREATE TABLE whales (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, token TEXT NOT NULL, symbol TEXT NOT NULL, min TEXT NOT NULL, units TEXT NOT NULL, since_block INTEGER NOT NULL, UNIQUE (chat_id, token)) STRICT;
    CREATE TABLE tracks (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, hash TEXT NOT NULL, since_block INTEGER NOT NULL, since_time INTEGER NOT NULL, stage INTEGER NOT NULL DEFAULT 0, UNIQUE (chat_id, hash)) STRICT;
    CREATE TABLE deliveries (seq INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, tx_hash TEXT NOT NULL, event_index INTEGER NOT NULL, kind TEXT NOT NULL, events TEXT NOT NULL, block INTEGER, chain_time INTEGER NOT NULL, state TEXT NOT NULL, message_id INTEGER, body TEXT, UNIQUE (chat_id, tx_hash, event_index)) STRICT;
    INSERT INTO meta VALUES ('schema', '2'), ('offset', '41');
    INSERT INTO watches (chat_id, address, label, since_block) VALUES (5, '${TRADER}', 'Kept', 9);`);
  old.close();
  const store = new Store(directory);
  try {
    assert.equal(store.get('schema'), '3');
    assert.equal(store.offset, 41);
    const columns = (table) => store.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const table of ['watches', 'whales', 'tracks', 'deliveries']) assert.ok(columns(table).includes('thread_id'), table);
    assert.ok(columns('deliveries').includes('digest') && columns('feeds').includes('min_usd') && columns('names').includes('labels'));
    assert.deepEqual(new Subscriptions(store, { maxWatches: 20 }).watches(5).map((w) => [w.label, w.thread_id]), [['Kept', null]]);
  } finally { store.close(); }
});

test('round 3 network keys are validated before any call: contracts and pragma pairs, each one optional', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cairn-net-')), 'net.json');
  const env = (network) => {
    writeFileSync(file, JSON.stringify(network));
    return { TELEGRAM_BOT_TOKEN: `12:${'x'.repeat(30)}`, STARKNET_RPC_URL: 'https://rpc.example', CAIRN_NETWORK_FILE: file, CAIRN_DATA: join(tmpdir(), 'cairn-unused') };
  };
  const token = { symbol: 'STRK', address: TOKEN, decimals: 18 };
  const ok = loadConfig(['tick'], env({ chain: 'SN_MAIN', tokens: [token], contracts: { pragma: '0x1', future_contract: 'anything' } }));
  assert.deepEqual(ok.contracts, { pragma: hex64('0x1') });
  assert.equal(ok.tokens[0].pragma_pair, null);
  assert.equal(ok.priceMaxAge, 900);
  for (const [network, path] of [[{ contracts: { ekubo_core: '0x0' } }, 'contracts.ekubo_core'], [{ contracts: { naming: '0xzz' } }, 'contracts.naming'],
    [{ contracts: 'pragma' }, 'contracts'], [{ tokens: [{ ...token, pragma_pair: 'strk/usd' }] }, 'tokens[0].pragma_pair']]) {
    assert.throws(() => loadConfig(['tick'], env({ chain: 'SN_MAIN', tokens: [token], ...network })), (e) => e.exitCode === 2 && e.message.includes(`: ${path}: `));
  }
  assert.throws(() => loadConfig(['tick'], { ...env({ chain: 'SN_MAIN', tokens: [token] }), CAIRN_PRICE_MAX_AGE: '0' }), /CAIRN_PRICE_MAX_AGE/);
});
