import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAlerts } from '../src/alerts.mjs';
import { NodeBusy, RpcError } from '../src/errors.mjs';
import { cairoString, hex64, SELECTORS } from '../src/felt.mjs';
import { links, parseDecimal, plainText } from '../src/format.mjs';
import { Ledger } from '../src/ledger.mjs';
import { RateLimit } from '../src/rate.mjs';
import { decodeTokenEvents, Scanner, TOKEN_EVENTS } from '../src/scanner.mjs';
import { Store } from '../src/store.mjs';
import { Subscriptions } from '../src/subscriptions.mjs';
import { Tokens } from '../src/tokens.mjs';
import { parseHtml } from '../.launchpad/checks/round-2/fake-telegram.mjs';

const felt = (v) => `0x${BigInt(v).toString(16)}`;
const short = (s) => `0x${Buffer.from(s).toString('hex')}`;
const address = (n) => hex64(felt(n));
const STRK = address(0x5752), OTHER = address(0x07e4), SEQUENCER = address(0x5e9);
const A = address(0xa), B = address(0xb), C = address(0xc);
const config = { tokens: [{ symbol: 'STRK', address: STRK, decimals: 18 }], maxWatches: 20, explorer: 'https://x.example', maxBlocks: 500 };
const fmt = links(config, String);
const plain = (html) => { const r = parseHtml(html); assert.equal(r.error, undefined, r.error); return r.plain; };
function open() {
  const directory = mkdtempSync(join(tmpdir(), 'cairn-r2-'));
  const store = new Store(directory);
  return { directory, store, subs: new Subscriptions(store, config), ledger: new Ledger(store) };
}
function transfer(token, from, to, value, { tx = 1, index = 0, block = 11, legacy = false, kind = 'Transfer' } = {}) {
  const words = [felt(BigInt(value) & ((1n << 128n) - 1n)), felt(BigInt(value) >> 128n)];
  const sel = SELECTORS[kind];
  return { from_address: token, keys: legacy ? [sel] : [sel, from, to], data: legacy ? [from, to, ...words] : words,
    block_number: block, transaction_hash: felt(tx), event_index: index };
}
/** A node that answers starknet_call from `calls` and everything else from `methods`. */
function fakeRpc(methods = {}, calls = {}) {
  const log = [];
  return {
    log,
    async call(method, params) {
      log.push({ method, params });
      if (method === 'starknet_call') {
        const answer = calls[`${params.request.contract_address} ${params.request.entry_point_selector}`];
        if (!answer) throw new RpcError(21);
        return answer;
      }
      const h = methods[method];
      if (!h) throw new Error(`unexpected ${method}`);
      return h(params);
    },
  };
}
const header = () => ({ timestamp: 1_792_454_422, sequencer_address: SEQUENCER });

test('amounts people type are exact, bounded and never rounded', () => {
  assert.deepEqual(parseDecimal('2.000001', 6), { units: 2_000_001n, text: '2.000001' });
  assert.deepEqual(parseDecimal('1,000,000', 18), { units: 10n ** 24n, text: '1000000' });
  assert.equal(parseDecimal('1.50', 1).units, 15n);
  for (const bad of ['-1', 'NaN', '1e6', '0.0000001', '', '1.', '.5', '1,00', (1n << 256n).toString()]) {
    assert.ok(parseDecimal(bad, 6).error, `${bad} should be refused`);
  }
});

test('symbols decode from short strings and ByteArrays, and outside text is made safe', () => {
  assert.equal(cairoString(['0x55534443']), 'USDC');
  assert.equal(cairoString(['0x0', '0x5354524b', '0x4']), 'STRK');
  const long = 'A'.repeat(31) + 'BC';
  assert.equal(cairoString(['0x1', short('A'.repeat(31)), short('BC'), '0x2']), long);
  assert.equal(cairoString(['0x1', '0x2']), null);
  assert.equal(cairoString(['0x0', short('ABC'), '0x2']), null); // pending word longer than its length
  assert.equal(plainText('US‮DC\u0000\nx', 11), 'US DC x');
  assert.equal(plainText('<x>&USDCmorethan11', 11), '<x>&USDCmor');
});

test('events are decoded by their shape alone', () => {
  const nft = { ...transfer(OTHER, A, B, 1), keys: [SELECTORS.Transfer, A, B, '0x1', '0x0'], data: [] };
  const other = { ...transfer(OTHER, A, B, 1), keys: ['0x1234', A, B] };
  const events = decodeTokenEvents([transfer(STRK, A, B, 5), transfer(OTHER, A, B, 7, { legacy: true, index: 3 }), nft, other,
    { ...transfer(STRK, A, B, 9, { tx: 2 }), event_index: undefined }]);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => [e.legacy, e.amount, e.index]), [[false, 5n, 0], [true, 7n, 3], [false, 9n, 0]]);
  assert.equal(events[0].a, A);
  assert.equal(events[0].tx, hex64('0x1'));
});

test('the scanner reads a range whole: it follows pages, restarts on error 33 and fails on a lost page', async () => {
  const pages = { undefined: { events: [1, 2], continuation_token: 'p2' }, p2: { events: [3] } };
  let invalid = 1;
  const rpc = { calls: [], async call(method, { filter }) {
    this.calls.push(filter);
    if (filter.continuation_token && invalid-- > 0) throw new RpcError(33);
    return pages[filter.continuation_token];
  } };
  const scanner = new Scanner(rpc, config);
  assert.deepEqual(scanner.next(10, 12), { from: 11, to: 12 });
  assert.equal(scanner.next(12, 12), null);
  assert.deepEqual(await scanner.events({ from: 11, to: 12 }, TOKEN_EVENTS), [1, 2, 3]);
  assert.equal(rpc.calls.filter((f) => f.continuation_token === undefined).length, 2);
  assert.ok(rpc.calls.every((f) => f.chunk_size === 1000 && f.address === undefined && f.keys[0].length === 2));
  const failing = new Scanner({ async call(_, { filter }) { if (filter.continuation_token) throw new RpcError(24); return pages.undefined; } }, config);
  await assert.rejects(failing.events({ from: 11, to: 12 }, TOKEN_EVENTS));
});

test('the ledger saves each key once and forgets the text once Telegram accepted it', () => {
  const { store, ledger, subs } = open();
  try {
    const alert = { chatId: 7, txHash: hex64('0x1'), eventIndex: 2, kind: 'alert', chainTime: 100, body: 'hello' };
    store.transaction(() => { subs.chat({ id: 7, type: 'private' }); assert.equal(ledger.add(alert), true); assert.equal(ledger.add(alert), false); });
    assert.equal(ledger.pending().length, 1);
    store.transaction(() => subs.pause(7));
    assert.equal(ledger.pending().length, 0);
    store.transaction(() => subs.resume(7));
    const [row] = ledger.pending();
    store.transaction(() => ledger.sent(row.seq, 5001));
    assert.equal(ledger.pending().length, 0);
    assert.equal(ledger.messageId(7, alert.txHash, 2), 5001);
    assert.equal(store.sql('SELECT body FROM deliveries').get().body, null);
    store.transaction(() => ledger.prune(100 + 7 * 24 * 3600 + 1));
    assert.equal(store.sql('SELECT count(*) AS n FROM deliveries').get().n, 0);
  } finally { store.close(); }
});

test('forget leaves no trace of a label in CAIRN_DATA, and migration moves everything', () => {
  const { directory, store, subs } = open();
  try {
    const chat = { id: -100, type: 'supergroup' };
    store.transaction(() => {
      subs.watch(chat, A, 'SECRET-LABEL-4711', 10);
      subs.whale(chat, STRK, 'STRK', '1', 10n ** 18n, 10);
      subs.mute(chat, OTHER);
      subs.track(chat, hex64('0x99'), 10, 1000);
    });
    store.transaction(() => subs.migrate(-100, -200));
    assert.equal(subs.export(-100).watches.length, 0);
    assert.equal(subs.export(-200).watches[0].label, 'SECRET-LABEL-4711');
    store.transaction(() => subs.forget(-200));
    assert.deepEqual(subs.export(-200), { chat_id: -200, feed: null, watches: [], whales: [], minimums: {}, tracks: [], muted: [],
      chat: null, buttons: [], deliveries: { pending: 0, sent: 0, dropped: 0 } });
  } finally { store.close(); }
  for (const file of readdirSync(directory)) assert.ok(!readFileSync(join(directory, file)).includes('SECRET-LABEL-4711'), file);
});

test('rate limits count commands on message.date and notice once', () => {
  const { store } = open();
  try {
    const rate = new RateLimit(store);
    const verdicts = [];
    for (let i = 0; i < 13; i++) {
      const v = rate.verdict(42, 1000 + i);
      store.transaction(() => rate.note(42, 1000 + i, v));
      verdicts.push(v);
    }
    assert.deepEqual(verdicts, [...Array(10).fill('ok'), 'notice', 'ignore', 'ignore']);
    assert.equal(rate.verdict(43, 1013), 'ok');
    assert.equal(rate.verdict(42, 1061), 'ok');
    store.transaction(() => rate.prune(1012 + 60));
    assert.equal(store.sql('SELECT count(*) AS n FROM rate').get().n, 1);
    store.transaction(() => rate.prune(1012 + 61));
    assert.equal(store.sql('SELECT count(*) AS n FROM rate').get().n, 0);
  } finally { store.close(); }
});

test('export lists what else is stored for a chat, and forget in a private chat leaves no rate entry', () => {
  const { store, subs, ledger } = open();
  try {
    const p = { id: 42, type: 'private' }, rate = new RateLimit(store);
    store.transaction(() => {
      subs.watch(p, A, null, 10);
      subs.offer(p, 'track', hex64('0x99'), 1000);
      ledger.add({ chatId: 42, txHash: hex64('0x1'), eventIndex: 0, kind: 'alert', chainTime: 1000, body: 'x' });
      rate.note(42, 1000, 'ok');
    });
    const e = subs.export(42);
    assert.deepEqual(e.chat, { type: 'private', paused: false });
    assert.deepEqual(e.buttons, [{ kind: 'track', value: hex64('0x99'), chain_time: 1000 }]);
    assert.deepEqual(e.deliveries, { pending: 1, sent: 0, dropped: 0 });
    store.transaction(() => subs.forget(42));
    assert.equal(store.sql('SELECT count(*) AS n FROM rate').get().n, 0);
    assert.deepEqual(subs.export(42), { chat_id: 42, feed: null, watches: [], whales: [], minimums: {}, tracks: [], muted: [],
      chat: null, buttons: [], deliveries: { pending: 0, sent: 0, dropped: 0 } });
  } finally { store.close(); }
});

test('only the contract\'s own answers make a token "not a coin"; other node errors are retried, never cached', async () => {
  const { store } = open();
  try {
    let failure = new RpcError(-32603);
    const rpc = { async call(_, { request }) {
      if (failure) throw failure;
      return request.entry_point_selector === SELECTORS.decimals ? ['0x6'] : [short('OUT')];
    } };
    const tokens = new Tokens(config, store, rpc);
    await assert.rejects(tokens.get(OTHER, 100), NodeBusy);
    assert.equal(store.sql('SELECT count(*) AS n FROM tokens').get().n, 0);
    failure = null;
    assert.deepEqual(await tokens.get(OTHER, 100), { address: OTHER, symbol: 'OUT', decimals: 6, verified: false });
    failure = new RpcError(40);
    assert.equal(await tokens.get(B, 100), null);
    assert.equal(store.sql('SELECT decimals FROM tokens WHERE address = ?').get(B).decimals, null);
  } finally { store.close(); }
});

test('a failed fee lookup fails the range instead of alerting the fee', async () => {
  const { store, subs } = open();
  try {
    store.transaction(() => subs.watch({ id: 1, type: 'private' }, A, null, 10));
    const rpc = fakeRpc({ starknet_getBlockWithTxHashes: header, starknet_getTransactionReceipt: () => { throw new RpcError(29); } });
    const events = decodeTokenEvents([transfer(STRK, A, SEQUENCER, 9n)]);
    await assert.rejects(findAlerts(events, { interests: subs.interests(), tokens: new Tokens(config, store, rpc), rpc, now: 1_792_454_422, fmt }), RpcError);
  } finally { store.close(); }
});

test('alerts: one message per chat per transaction, fee and noise suppressed, floors, mutes and whales', async () => {
  const { store, subs } = open();
  try {
    const p = { id: 1, type: 'private' }, q = { id: 2, type: 'private' };
    store.transaction(() => {
      subs.watch(p, A, 'Vault', 10);
      subs.watch(q, A, null, 10);
      subs.minimum(q, STRK, '5', 5n * 10n ** 18n);
      subs.mute(p, OTHER);
      subs.whale(q, OTHER, 'OUT', '2', 2n, 10);
    });
    const rpc = fakeRpc({
      starknet_getBlockWithTxHashes: header,
      starknet_getTransactionReceipt: ({ transaction_hash: h }) => ({ events: h === hex64('0x1') ? [{}, {}, {}] : [{}], actual_fee: { amount: '0x9', unit: 'FRI' } }),
      starknet_getTransactionByHash: () => ({ sender_address: A }),
    }, { [`${OTHER} ${SELECTORS.decimals}`]: ['0x0'], [`${OTHER} ${SELECTORS.symbol}`]: [short('OUT')] });
    const events = decodeTokenEvents([
      transfer(STRK, A, C, 0n, { index: 0 }), // zero: never
      transfer(STRK, C, A, 10n ** 18n, { index: 1 }), // p only: under q's floor
      transfer(STRK, A, SEQUENCER, 9n, { index: 2 }), // the fee
      transfer(OTHER, B, C, 2n, { tx: 2 }), // q's whale, at the threshold; p muted it anyway
      transfer(OTHER, A, B, 1n, { tx: 3 }), // p muted it; under q's whale, but q watches A
      transfer(STRK, A, B, (1n << 128n) - 1n, { tx: 4, kind: 'Approval' }), // both chats: approvals ignore floors
      transfer(OTHER, B, C, 3n, { tx: 5, index: 0 }), transfer(OTHER, C, address(0xd), 3n, { tx: 5, index: 1 }), // one route
    ]);
    const tokens = new Tokens(config, store, rpc);
    const { deliveries, seen } = await findAlerts(events, { interests: subs.interests(), tokens, rpc, now: 1_792_454_422, fmt });
    const view = deliveries.map((d) => [d.chatId, d.txHash.slice(-1), d.events.join(','), plain(d.body)]);
    assert.deepEqual(view.map((v) => v.slice(0, 3)), [[1, '1', '1'], [2, '2', '0'], [2, '3', '0'], [1, '4', '0'], [2, '4', '0'], [2, '5', '0,1']]);
    assert.match(view[5][3], /^🐋 Whale 3 OUT \(unverified, 0x0000…07e4\) from 0x0000…000b to 0x0000…000d \(2 hops\)\n/);
    assert.match(view[0][3], /^↓ In \+1 STRK to Vault from 0x0000…000c\nBlock 11 · 2026-10-20 00:00:22 UTC · View transaction$/);
    assert.match(view[1][3], /Whale 2 OUT \(unverified, 0x0000…07e4\) from 0x0000…000b to 0x0000…000c/);
    assert.match(view[2][3], /^↑ Out −1 OUT \(unverified, 0x0000…07e4\) from 0x0000…000a to 0x0000…000b\n/);
    assert.match(view[3][3], /Approval: Vault lets spender 0x0000…000b spend unlimited STRK/);
    assert.deepEqual(seen, [[1, A, OTHER], [2, A, OTHER]]);
    assert.equal(rpc.log.filter((c) => c.method === 'starknet_getTransactionByHash').length, 0);
  } finally { store.close(); }
});
