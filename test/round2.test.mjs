import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { normalize, SELECTORS } from '../src/felt.mjs';
import { Migration, NodeBusy, RpcError } from '../src/errors.mjs';
import { decodeSymbol, decimalAmount, Tokens, METADATA_TTL } from '../src/tokens.mjs';
import { chatState, deliver, enqueue, migrate, prune } from '../src/ledger.mjs';
import { scan } from '../src/scanner.mjs';
import { decodeEvent, alertLine } from '../src/alerts.mjs';
import { handleMessage, handleCallback, isAdmin, listReply } from '../src/subscriptions.mjs';
import { trackTransactions } from '../src/tracking.mjs';
import { answer } from '../src/commands.mjs';
import { validState } from '../src/state-schema.mjs';
import { parseHtml } from '../.launchpad/checks/round-2/fake-telegram.mjs';

const addr = n => normalize(`0x${BigInt(n).toString(16)}`);
const A = addr(1), B = addr(2), C = addr(3), H = addr(100), U = addr(11);
const token = { address: addr(10), symbol: 'STRK', decimals: 0, verified: true };
const word = s => `0x${Buffer.from(s).toString('hex') || '0'}`;
const ev = (value = 7n, address = token.address, kind = 'Transfer', a = A, b = B) => ({
  from_address: address, keys: [SELECTORS[kind], a, b],
  data: [`0x${(value & ((1n << 128n) - 1n)).toString(16)}`, `0x${(value >> 128n).toString(16)}`],
});
function fixture(t, events = [ev()]) {
  const directory = mkdtempSync(join(tmpdir(), 'cairn-round2-'));
  let store = new Store(directory);
  const c = {
    store, clean: String, signal: new AbortController().signal, username: 'cairn',
    config: { tokens: [token], chain: 'SN_MAIN', maxBlocks: 500, maxWatches: 20, explorer: 'https://explorer.example' },
    head: { block_number: 2, timestamp: 1000, sequencer_address: C, transactions: [H] },
    events, calls: [], sends: [], receipt: { events, block_number: 2, actual_fee: { amount: '0x9', unit: 'FRI' } },
  };
  c.rpc = { async call(method, params) {
    c.calls.push({ method, params });
    if (c.rpcOverride) {
      const override = await c.rpcOverride(method, params);
      if (override !== undefined) return override;
    }
    switch (method) {
      case 'starknet_getEvents': return { events: c.events.map(e => ({ ...e, block_number: 2, transaction_hash: H })) };
      case 'starknet_getTransactionReceipt': return c.receipt;
      case 'starknet_getTransactionByHash': return { sender_address: A };
      case 'starknet_getBlockWithTxHashes': return c.head;
      case 'starknet_call':
        if (params.request.entry_point_selector === SELECTORS.decimals) return ['0x6'];
        if (params.request.entry_point_selector === SELECTORS.symbol) return [word('OUTSIDE')];
        return ['0x1', '0x0'];
      default: throw new RpcError(29);
    }
  } };
  c.tg = { async call(method, params) {
    if (c.tgOverride) {
      const override = await c.tgOverride(method, params);
      if (override !== undefined) return override;
    }
    if (method === 'sendMessage') { c.sends.push(params); return { message_id: c.sends.length }; }
    return true;
  } };
  c.tokens = new Tokens(c);
  c.store.state.cursor = 1;
  chatState(c.store, 1).watches.push({ address: A, label: '<Vault>&', since_block: 1, seen: [] });
  c.store.save();
  c.reopen = () => {
    c.store.close();
    store = c.store = new Store(directory);
    return c;
  };
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return c;
}
const dm = (id = 1, text = '/list', date = 1000) => ({
  chat: { id, type: 'private' }, from: { id, first_name: 'DO-NOT-STORE', username: 'DO-NOT-STORE-EITHER' }, date, text,
});

test('decimal thresholds are exact at u256 and 36-decimal boundaries', () => {
  assert.equal(decimalAmount(`0.${'0'.repeat(35)}1`, 36), '1');
  assert.equal(decimalAmount(((1n << 256n) - 1n).toString(), 0), ((1n << 256n) - 1n).toString());
  for (const input of ['1e3', '+2', '-1', '.1', '1.', 'NaN', '1.0000001']) assert.throws(() => decimalAmount(input, 6));
  assert.throws(() => decimalAmount((1n << 256n).toString(), 0));
});

test('metadata ByteArrays validate word widths and lengths and remove deceptive controls', () => {
  assert.equal(decodeSymbol([word('USDC')]), 'USDC');
  assert.equal(decodeSymbol(['0x0', word('<x>&USDCmorethan11'), '0x12']), '<x>&USDCmor');
  const full = 'a'.repeat(31);
  assert.equal(decodeSymbol(['0x1', word(full), word('xyz'), '0x3']), 'a'.repeat(11));
  assert.equal(decodeSymbol(['0x0', word('A\u202eBC'), '0x6']), 'ABC');
  for (const words of [[], ['0x1', '0x0', '0x0'], ['0x0', '0x100', '0x1'], ['0x0', '0x1', '0x0'],
    ['0x0', '0xff', '0x1'], ['0x0', '0x0', '0x1f']]) assert.throws(() => decodeSymbol(words));
});

test('RPC metadata outages never become a cached not-a-coin result', async t => {
  const c = fixture(t, [ev(7n, U)]);
  c.rpcOverride = async method => { if (method === 'starknet_call') throw new NodeBusy(); };
  await assert.rejects(scan(c), NodeBusy);
  assert.equal(c.store.state.cursor, 1);
  assert.deepEqual(c.store.state.metadata, {});
  assert.deepEqual(c.store.state.chats[1].deliveries, {});
  c.rpcOverride = null;
  await scan(c);
  assert.equal(c.store.state.cursor, 2);
  assert.equal(Object.keys(c.store.state.chats[1].deliveries).length, 1);
});

test('invalid decimals are cached, but transient block errors retry the whole range', async t => {
  const c = fixture(t, [ev(7n, U)]);
  c.rpcOverride = async (method, params) => {
    if (method === 'starknet_call' && params.request.entry_point_selector === SELECTORS.decimals) return ['0x25'];
  };
  assert.equal(await c.tokens.get(U), null);
  assert.equal(c.store.state.metadata[U].token, null);
  delete c.store.state.metadata[U];
  c.rpcOverride = async method => { if (method === 'starknet_call') throw new RpcError(24); };
  await assert.rejects(scan(c), e => e.code === 24);
  assert.equal(c.store.state.cursor, 1);
  assert.equal(c.store.state.metadata[U], undefined);
});

test('metadata is reused after reopening and expires exactly at seven chain days', async t => {
  const c = fixture(t);
  await c.tokens.get(U);
  c.store.save();
  const reads = c.calls.length;
  c.reopen();
  c.head.timestamp += METADATA_TTL - 1;
  await c.tokens.get(U);
  assert.equal(c.calls.length, reads);
  c.head.timestamp++;
  await c.tokens.get(U);
  assert.equal(c.calls.length, reads + 2);
});

test('a failed later page leaves no alerts, seen tokens or cursor change on disk', async t => {
  const c = fixture(t);
  c.rpcOverride = async (method, params) => {
    if (method !== 'starknet_getEvents') return;
    if (params.filter.continuation_token) throw new NodeBusy();
    return { events: [{ ...ev(), block_number: 2, transaction_hash: H }], continuation_token: 'next' };
  };
  await assert.rejects(scan(c), NodeBusy);
  c.reopen();
  assert.equal(c.store.state.cursor, 1);
  assert.deepEqual(c.store.state.chats[1].deliveries, {});
  assert.deepEqual(c.store.state.chats[1].watches[0].seen, []);
  c.rpcOverride = null;
  await scan(c);
  await deliver(c);
  c.reopen();
  await scan(c);
  await deliver(c);
  assert.equal(c.sends.length, 1);
});

test('invalid and looping continuation tokens do not commit partial results', async t => {
  const c = fixture(t);
  let firstPages = 0;
  c.rpcOverride = async (method, params) => {
    if (method !== 'starknet_getEvents') return;
    if (!params.filter.continuation_token) firstPages++;
    else throw new RpcError(33);
    return { events: [], continuation_token: 'bad' };
  };
  await assert.rejects(scan(c), e => e.code === 33);
  assert.equal(firstPages, 2);
  assert.equal(c.store.state.cursor, 1);
  c.rpcOverride = async method => method === 'starknet_getEvents' ? { events: [], continuation_token: 'loop' } : undefined;
  await assert.rejects(scan(c), /Non-progressing/);
});

test('overlapping pages without indexes use receipt positions and preserve identical events', async t => {
  const event = ev();
  const c = fixture(t, [event, event]);
  c.events = [event, event, event]; // provider overlap; canonical receipt still has two occurrences
  await scan(c);
  const record = Object.values(c.store.state.chats[1].deliveries)[0];
  assert.deepEqual(record.event_indexes, [0, 1]);
  await deliver(c);
  assert.equal(c.sends.length, 1);
  assert.equal((parseHtml(c.sends[0].text).plain.match(/7 STRK/g) ?? []).length, 2);
});

test('a missing or mismatched receipt rolls back the whole scan', async t => {
  const c = fixture(t);
  c.receipt.block_number = 3;
  await assert.rejects(scan(c), /Invalid receipt/);
  assert.equal(c.store.state.cursor, 1);
  c.reopen();
  assert.deepEqual(c.store.state.chats[1].deliveries, {});
});

test('fee suppression requires the real sender, final receipt position and exact fee', async t => {
  const c = fixture(t, [ev(9n, token.address, 'Transfer', A, C)]);
  await scan(c);
  assert.deepEqual(c.store.state.chats[1].deliveries, {});
  c.store.state.cursor = 1;
  c.rpcOverride = async method => method === 'starknet_getTransactionByHash' ? { sender_address: B } : undefined;
  await scan(c);
  assert.equal(Object.keys(c.store.state.chats[1].deliveries).length, 1);
});

test('durable pending alerts survive reopening; confirmed ones never resend', async t => {
  const c = fixture(t);
  await scan(c);
  c.reopen();
  assert.equal(c.store.state.cursor, 2);
  c.tgOverride = async () => { throw new Error('network unavailable'); };
  assert.equal(await deliver(c), 0);
  c.reopen();
  c.tgOverride = null;
  assert.equal(await deliver(c), 1);
  const record = Object.values(c.store.state.chats[1].deliveries)[0];
  assert.equal(record.parts[0].text, undefined);
  assert.equal(record.parts[0].message_id, 1);
  c.reopen();
  assert.equal(await deliver(c), 0);
  assert.equal(c.sends.length, 1);
});

test('one blocked chat does not stop others and resumes its oldest pending alert first', async t => {
  const c = fixture(t);
  chatState(c.store, 2).watches = structuredClone(c.store.state.chats[1].watches);
  await scan(c);
  c.tgOverride = async (_, p) => p.chat_id === 1 ? null : undefined;
  assert.equal(await deliver(c), 1);
  assert.equal(c.store.state.chats[1].paused, true);
  assert.equal(await deliver(c), 0);
  c.tgOverride = null;
  await handleMessage(dm(), c);
  assert.equal(await deliver(c), 1);
});

test('forget erases pending alerts, capabilities, labels and rates, preserving other chats', async t => {
  const c = fixture(t);
  chatState(c.store, 2).watches.push({ address: B, label: 'KEEP', since_block: 1, seen: [] });
  await scan(c);
  listReply(c.store.state.chats[1], c);
  await handleMessage(dm(1, '/forget'), c);
  c.store.save();
  const data = readdirSync(c.store.directory).map(f => readFileSync(join(c.store.directory, f)).toString()).join('');
  assert.ok(!data.includes('<Vault>'));
  assert.ok(!data.includes('DO-NOT-STORE'));
  c.reopen();
  assert.equal(c.store.state.chats[1], undefined);
  assert.equal(c.store.state.chats[2].watches[0].label, 'KEEP');
  assert.equal(await deliver(c), 1);
  assert.ok(c.sends.every(send => send.chat_id === 2));
});

test('admin checks fail closed and callback messages cannot borrow anonymous admin status', async t => {
  const c = fixture(t);
  const group = { ...dm(1, '/watch 0x3'), chat: { id: 1, type: 'supergroup' } };
  c.tgOverride = async method => method === 'getChatMember' ? { status: 'member' } : undefined;
  const refused = await handleMessage(group, c);
  assert.match(refused.lines.join(''), /Administrator/);
  assert.equal(c.store.state.chats[1].watches.length, 1);
  assert.equal(await isAdmin({ ...group, sender_chat: { id: 1 } }, c.tg), true);
  assert.equal(await isAdmin({ ...group, sender_chat: { id: 2 } }, c.tg), false);
  const button = listReply(c.store.state.chats[1], c).extra.reply_markup.inline_keyboard[0][0];
  await handleCallback({ id: 'q', from: group.from, data: button.callback_data,
    message: { ...group, sender_chat: { id: 1 } } }, c);
  assert.equal(c.store.state.chats[1].watches.length, 1);
  assert.match(c.callbackAnswer.text, /Administrator/);
  c.tgOverride = async () => { throw new Error('admin lookup unavailable'); };
  await handleMessage(group, c);
  assert.equal(c.store.state.chats[1].watches.length, 1);
});

test('a callback capability is scoped to one chat and revoked after deletion', async t => {
  const c = fixture(t);
  const button = listReply(c.store.state.chats[1], c).extra.reply_markup.inline_keyboard[0][0];
  chatState(c.store, 2);
  await handleCallback({ id: 'q', from: { id: 2 }, data: button.callback_data, message: dm(2) }, c);
  assert.equal(c.store.state.chats[1].watches.length, 1);
  await handleMessage(dm(1, '/forget'), c);
  await handleCallback({ id: 'q2', from: { id: 1 }, data: button.callback_data, message: dm(1) }, c);
  assert.equal(c.store.state.chats[1], undefined);
});

test('export chunks concatenate into valid JSON without changing string contents', async t => {
  const c = fixture(t);
  for (let i = 0; i < 30; i++) enqueue(c.store.state.chats[1], `sample-${i}`, [`&lt;${'x'.repeat(200)}&gt;`], { at: 1000 });
  const reply = await handleMessage(dm(1, '/export'), c);
  assert.equal(reply.separate, true);
  const json = reply.lines.map(line => parseHtml(line).plain).join('');
  const saved = JSON.parse(json);
  assert.deepEqual(saved.deliveries, c.store.state.chats[1].deliveries);
  assert.ok(reply.lines.every(line => line.length <= 4096));
});

test('migration retains both chats, deduplicates settings and invalidates old buttons', t => {
  const c = fixture(t);
  listReply(c.store.state.chats[1], c);
  chatState(c.store, 2).watches.push({ address: B, label: 'Other', since_block: 1, seen: [] });
  enqueue(c.store.state.chats[1], 'old', ['Old alert'], { at: 1000 });
  enqueue(c.store.state.chats[2], 'new', ['New alert'], { at: 1000 });
  migrate(c.store, 1, 2);
  c.reopen();
  assert.equal(c.store.state.chats[1], undefined);
  assert.equal(c.store.state.chats[2].watches.length, 2);
  assert.equal(Object.keys(c.store.state.chats[2].deliveries).length, 2);
  assert.deepEqual(c.store.state.chats[2].callbacks, {});
});

test('retention removes confirmed records and metadata at seven chain days, never pending alerts', t => {
  const c = fixture(t);
  const chat = c.store.state.chats[1];
  enqueue(chat, 'confirmed', ['Alert'], { at: 1000 });
  chat.deliveries.confirmed.parts[0] = { message_id: 1 };
  enqueue(chat, 'pending', ['Still waiting'], { at: 1000 });
  c.store.state.metadata[U] = { at: 1000, token: null };
  prune(c.store, 1000 + METADATA_TTL - 1);
  assert.ok(chat.deliveries.confirmed);
  prune(c.store, 1000 + METADATA_TTL);
  assert.equal(chat.deliveries.confirmed, undefined);
  assert.ok(chat.deliveries.pending);
  assert.equal(c.store.state.metadata[U], undefined);
});

test('L1 first observation queues L2 before L1 and persists stages before delivery', async t => {
  const c = fixture(t, []);
  c.store.state.chats[1].tracks.push({ hash: H, since_time: 1000, l2: false });
  c.receipt.execution_status = 'SUCCEEDED';
  c.rpcOverride = async method => method === 'starknet_getTransactionStatus' ?
    { finality_status: 'ACCEPTED_ON_L1', execution_status: 'SUCCEEDED' } : undefined;
  await trackTransactions(c);
  c.reopen();
  assert.deepEqual(c.store.state.chats[1].tracks, []);
  await deliver(c);
  assert.match(c.sends[0].text, /L2/);
  assert.match(c.sends[1].text, /L1/);
  c.reopen();
  await trackTransactions(c);
  assert.equal(await deliver(c), 0);
});

test('a status outage does not expire a track, but confirmed not-found does at 600 chain seconds', async t => {
  const c = fixture(t, []);
  c.store.state.chats[1].tracks.push({ hash: H, since_time: 400, l2: false });
  c.rpcOverride = async method => { if (method === 'starknet_getTransactionStatus') throw new NodeBusy(); };
  await trackTransactions(c);
  assert.equal(c.store.state.chats[1].tracks.length, 1);
  c.rpcOverride = null;
  await trackTransactions(c);
  assert.equal(c.store.state.chats[1].tracks.length, 0);
  assert.match(Object.values(c.store.state.chats[1].deliveries)[0].parts[0].text, /not found/);
});

test('muted and below-floor transfers still discover balance tokens; approvals do not discover holdings', t => {
  const c = fixture(t);
  const chat = c.store.state.chats[1], unknown = { ...token, address: U, verified: false };
  chat.muted.push(U);
  assert.equal(alertLine(chat, decodeEvent(ev(1n, U), 0), unknown, 2, c), null);
  assert.deepEqual(chat.watches[0].seen, [U]);
  chat.watches[0].seen = [];
  alertLine(chat, decodeEvent(ev(1n, U, 'Approval'), 0), unknown, 2, c);
  assert.deepEqual(chat.watches[0].seen, []);
});

test('metadata failure for a discovered balance does not suppress registry balances', async t => {
  const c = fixture(t);
  c.chat = c.store.state.chats[1];
  c.chat.watches[0].seen.push(U);
  c.rpcOverride = async (method, params) => {
    if (method === 'starknet_getClassHashAt') return '0x1';
    if (method === 'starknet_call' && params.request.contract_address === U) throw new NodeBusy();
  };
  const reply = await answer({ name: 'balance', argument: A }, c);
  const plain = reply.map(line => parseHtml(line).plain).join('\n');
  assert.match(plain, /1 STRK/);
  assert.match(plain, /node busy/);
});

test('nested ledger corruption is refused instead of replayed or discarded', t => {
  const c = fixture(t);
  assert.equal(validState(c.store.state), true);
  for (const damage of [
    state => { state.chats[1].watches[0].seen = null; },
    state => { state.chats[1].deliveries = { bad: { parts: [{ message_id: null }] } }; },
    state => { state.chats[1].minimums[U] = '-1'; },
    state => { state.metadata[U] = { at: 1, token: { address: U, decimals: 37, symbol: 'X', verified: false } }; },
  ]) {
    const broken = structuredClone(c.store.state);
    damage(broken);
    assert.equal(validState(broken), false);
  }
});

test('migration does not resend a destination transaction that is already confirmed', async t => {
  const c = fixture(t);
  const original = chatState(c.store, 1), destination = chatState(c.store, 2);
  enqueue(original, 'same', ['Alert'], { at: 1000 });
  enqueue(destination, 'same', ['Alert'], { at: 1000 });
  destination.deliveries.same.parts[0] = { message_id: 10 };
  c.tgOverride = async (_, p) => { if (p.chat_id === 1) throw new Migration(2); };
  assert.equal(await deliver(c), 0);
  assert.equal(c.sends.length, 0);
  assert.equal(c.store.state.chats[2].deliveries.same.parts[0].message_id, 10);
});

test('ambiguous remote acceptance stays pending: retry can duplicate, never falsely confirms', async t => {
  const c = fixture(t);
  await scan(c);
  c.tgOverride = async (_, p) => {
    c.sends.push(p); // Remote service accepted it, but no acknowledgement reached the caller.
    throw new Error('acknowledgement lost');
  };
  assert.equal(await deliver(c), 0);
  c.reopen();
  assert.equal(Object.values(c.store.state.chats[1].deliveries)[0].parts[0].message_id, null);
  c.tgOverride = null;
  assert.equal(await deliver(c), 1);
  assert.equal(c.sends.length, 2);
});

test('large transaction parts preserve every event and repeat the transaction context', async t => {
  const c = fixture(t, Array.from({ length: 45 }, (_, i) => ev(BigInt(i + 1))));
  await scan(c);
  await deliver(c);
  assert.ok(c.sends.length > 1);
  const text = c.sends.map(s => {
    assert.ok(s.text.length <= 4096);
    const parsed = parseHtml(s.text);
    assert.equal(parsed.error, undefined);
    assert.match(parsed.plain, /Block 2/);
    assert.ok(s.text.includes(`/tx/${H}`));
    return parsed.plain;
  }).join('\n');
  for (let i = 1; i <= 45; i++) assert.equal((text.match(new RegExp(`(?:^|[^0-9])${i} STRK`, 'g')) ?? []).length, 1);
  c.reopen();
  assert.equal(await deliver(c), 0);
});
