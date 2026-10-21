// Round 2's scanner, alert rules, ledger and chat settings, tested without any network: the node is a stub
// that answers the few calls the code makes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alertsOf } from '../src/alerts.mjs';
import { chatOf, exportOf, forget, migrate } from '../src/chats.mjs';
import { RpcError } from '../src/errors.mjs';
import { cairoString, felt64, parseAmount, plainAmount } from '../src/felt.mjs';
import { linker } from '../src/format.mjs';
import { alertKey, markSent, pending, prune, record } from '../src/ledger.mjs';
import { admit, forgetIdle } from '../src/limits.mjs';
import { expire, offer, take } from '../src/offers.mjs';
import { byTransaction, EVENTS, readRange } from '../src/scanner.mjs';
import { configure, list, press } from '../src/settings.mjs';
import { emptyState } from '../src/store.mjs';
import { Tokens, tokenName } from '../src/tokens.mjs';
import { followTracks } from '../src/tracks.mjs';
import { parseHtml } from '../.launchpad/checks/round-1/fake-telegram.mjs';

const address = (n) => felt64(`0x${n.toString(16)}`);
const [STRK, OTHER, NFT, A, B, C, SEQUENCER, SENDER_TX] = [0x5701, 0x077, 0x0f7, 0xa1, 0xb2, 0xc3, 0x5e9, 0xfee].map(address);
const config = { explorer: 'https://explorer.example', maxWatches: 20, tokens: [{ symbol: 'STRK', address: STRK, decimals: 18 }] };
const link = linker(config, String);
const plain = (html) => {
  const parsed = parseHtml(html);
  assert.equal(parsed.error, undefined, html);
  return parsed.plain;
};
const SYMBOL = '0x216b05c387bab9ac31918a3e61672f4618601f3c598a2f3f2710f37053e1ea4';
const DECIMALS = '0x4c4fb1ab068f6039d5780c68dd0fa2f8742cceb3426d19667778ca7f3518a9';
const ascii = (text) => `0x${Buffer.from(text).toString('hex')}`;

/** A node stub: `contracts` maps an address to { decimals, symbol } (a symbol as result felts). */
function node({ contracts = {}, senders = {}, statuses = {}, receipts = {} } = {}) {
  const calls = [];
  const rpc = {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      switch (method) {
        case 'starknet_getBlockWithTxHashes': return { block_number: params.block_id.block_number, timestamp: 1792454400 + 2 * params.block_id.block_number, sequencer_address: SEQUENCER };
        case 'starknet_getTransactionByHash': return { type: 'INVOKE', sender_address: senders[params.transaction_hash] ?? A };
        case 'starknet_getTransactionStatus': {
          if (!statuses[params.transaction_hash]) throw new RpcError(29);
          return statuses[params.transaction_hash];
        }
        case 'starknet_getTransactionReceipt': return receipts[params.transaction_hash];
        case 'starknet_call': {
          const contract = contracts[params.request.contract_address];
          if (!contract) throw new RpcError(20);
          const selector = BigInt(params.request.entry_point_selector);
          if (selector === BigInt(DECIMALS) && contract.decimals !== undefined) return [`0x${contract.decimals.toString(16)}`];
          if (selector === BigInt(SYMBOL) && contract.symbol) return contract.symbol;
          throw new RpcError(21);
        }
        default: throw new RpcError(-32601);
      }
    },
  };
  return rpc;
}

/** A raw event as starknet_getEvents returns it. */
function raw(token, kind, a, b, amount, { tx = '0x1', index = 0, block = 10, legacy = false } = {}) {
  const words = [`0x${(amount & ((1n << 128n) - 1n)).toString(16)}`, `0x${(amount >> 128n).toString(16)}`];
  return { from_address: token, keys: legacy ? [EVENTS[kind]] : [EVENTS[kind], a, b], data: legacy ? [a, b, ...words] : words,
    block_number: block, transaction_hash: tx, event_index: index };
}

function world({ contracts, senders } = {}) {
  const state = emptyState();
  const rpc = node({ contracts: { [OTHER]: { decimals: 6, symbol: [ascii('USDC')] }, ...contracts }, senders });
  const tokens = new Tokens(config, rpc, state.tokens);
  const head = { block_number: 20, timestamp: 1792454440 };
  return { state, rpc, tokens, head, link, config, clean: String, signal: new AbortController().signal };
}
const watch = (state, chat, address, label = '', since = 5) => chatOf(state, chat).watches.push({ id: state.nextId++, address, label, since_block: since, seen: [] });

test('events are decoded by their shape, grouped by transaction in chain order, with the last event index', () => {
  const groups = byTransaction([
    raw(STRK, 'Transfer', A, B, 5n, { tx: '0x2', index: 0 }),
    raw(OTHER, 'Transfer', A, B, 7n, { tx: '0x2', index: 1, legacy: true }),
    { from_address: NFT, keys: [EVENTS.Transfer, A, B, '0x1', '0x0'], data: [], block_number: 10, transaction_hash: '0x2', event_index: 2 },
    raw(STRK, 'Approval', A, C, 9n, { tx: '0x1', index: 0, block: 11 }),
  ]);
  assert.deepEqual(groups.map((g) => [g.tx, g.block, g.last, g.events.length]), [[felt64('0x2'), 10, 2, 2], [felt64('0x1'), 11, 0, 1]]);
  assert.deepEqual(groups[0].events.map((e) => [e.kind, e.legacy, e.amount]), [['Transfer', false, 5n], ['Transfer', true, 7n]]);
  assert.equal(groups[1].events[0].kind, 'Approval');
});

test('a range is read page after page, and restarted from scratch on an invalid continuation token', async () => {
  const pages = [{ events: [1, 2], continuation_token: 'a' }, { events: [3] }];
  let failed = false;
  const filters = [];
  const rpc = { async call(method, { filter }) {
    filters.push(filter);
    if (filter.continuation_token === 'a' && !failed) { failed = true; throw new RpcError(33); }
    return filter.continuation_token === 'a' ? pages[1] : pages[0];
  } };
  assert.deepEqual(await readRange(rpc, 5, 9), [1, 2, 3]);
  assert.deepEqual(filters.map((f) => f.continuation_token), [undefined, 'a', undefined, 'a']);
  assert.deepEqual(filters[0], { from_block: { block_number: 5 }, to_block: { block_number: 9 }, keys: [[EVENTS.Transfer, EVENTS.Approval]], chunk_size: 1000 });
});

test('amounts are exact decimals: refused with a reason when signed, exponential, too precise or out of range', () => {
  assert.equal(parseAmount('2.000001', 6), 2000001n);
  assert.equal(parseAmount('1000000', 0), 1000000n);
  for (const bad of ['-1', 'NaN', '1e6', '0.0000001', '0', (1n << 256n).toString(), '1.', '.5']) assert.throws(() => parseAmount(bad, 6), /Invalid amount/);
  assert.equal(plainAmount(2000001n, 6), '2.000001');
  assert.equal(plainAmount(5n, 0), '5');
});

test('symbols decode from a short string or a ByteArray, and anything else is no string', () => {
  assert.equal(cairoString(['0x55534443']), 'USDC');
  assert.equal(cairoString(['0x0', '0x5354524b', '0x4']), 'STRK');
  const long = 'A'.repeat(31) + 'BC';
  assert.equal(cairoString(['0x1', `0x${Buffer.from(long.slice(0, 31)).toString('hex')}`, ascii('BC'), '0x2']), long);
  assert.equal(cairoString(['0x5', '0x1', '0x2']), null);
});

test('an unverified token is in <code>, cut to 11 characters, never a link, and a copy of a verified symbol is flagged', () => {
  const html = tokenName({ address: OTHER, symbol: '<x>&USDCmorethan11', verified: false, lookalike: null }, link);
  assert.equal(plain(html), `<x>&USDCmor (unverified token ${'0x0000…0077'})`);
  assert.match(html, /^<code>&lt;x&gt;&amp;USDCmor<\/code>/);
  assert.match(plain(tokenName({ address: OTHER, symbol: 'usdc', verified: false, lookalike: 'USDC' }, link)), /not the verified USDC/);
  assert.equal(tokenName({ address: STRK, symbol: 'STRK', verified: true }, link), '<b>STRK</b>');
});

test('token metadata is read once, cached for 7 days of chain time, and a contract without decimals is no coin', async () => {
  const w = world({ contracts: { [NFT]: { symbol: [ascii('NFT')] } } });
  assert.equal((await w.tokens.get(OTHER, 1000)).symbol, 'USDC');
  assert.equal((await w.tokens.get(OTHER, 1000 + 604799)).decimals, 6);
  assert.equal(w.rpc.calls.length, 2);
  await w.tokens.get(OTHER, 1000 + 604800);
  assert.equal(w.rpc.calls.length, 4);
  assert.equal(await w.tokens.get(NFT, 1000), null);
  assert.equal(await w.tokens.get(address(0x404), 1000), null); // no contract at all
  assert.deepEqual(w.state.tokens[NFT], { coin: false, at: 1000 });
});

test('a chat sees transfers in, out and between its watches, never before the watch began, with labels and links', async () => {
  const w = world();
  watch(w.state, 1, A, 'Vault');
  watch(w.state, 1, B, '<b>Spare</b>', 10);
  const groups = byTransaction([
    raw(STRK, 'Transfer', A, B, 125n * 10n ** 16n, { tx: '0x3', index: 0, block: 11 }),
    raw(STRK, 'Transfer', C, A, 10n ** 18n, { tx: '0x3', index: 1, block: 11 }),
    raw(STRK, 'Transfer', B, C, 10n ** 18n, { tx: '0x4', index: 0, block: 10 }), // B's watch began at block 10
  ]);
  const [alert, ...rest] = await alertsOf(groups, w);
  assert.equal(rest.length, 0);
  assert.deepEqual([alert.chat, alert.tx, alert.indexes], ['1', felt64('0x3'), [0, 1]]);
  const text = plain(alert.text);
  assert.match(text, /Between · 1\.25 STRK from Vault 0x0000…00a1 to <b>Spare<\/b> 0x0000…00b2/);
  assert.match(text, /In · Vault 0x0000…00a1 · 1 STRK from 0x0000…00c3/);
  assert.match(text, /Block 11 · 2026-10-20 00:00:22 UTC · tx 0x0000…0003/);
});

test('zero transfers and the fee payment are never alerted; floors and mutes are per chat; whales see mints and burns', async () => {
  const w = world({ senders: { [felt64('0x6')]: B } });
  watch(w.state, 1, A);
  watch(w.state, 2, A);
  chatOf(w.state, 2).minimums.push({ id: 90, token: STRK, symbol: 'STRK', decimals: 18, verified: true, min: String(2n * 10n ** 18n) });
  chatOf(w.state, 2).muted.push({ id: 91, token: OTHER });
  chatOf(w.state, 3).whales.push({ id: 92, token: OTHER, symbol: 'USDC', decimals: 6, verified: false, min: '2000000', since_block: 5 });
  const groups = byTransaction([
    raw(STRK, 'Transfer', A, C, 0n, { tx: '0x5', index: 0 }), // address poisoning
    raw(STRK, 'Transfer', A, SEQUENCER, 9n, { tx: '0x5', index: 1 }), // the fee: A sent 0x5
    raw(STRK, 'Transfer', A, SEQUENCER, 9n, { tx: '0x6', index: 0 }), // B sent 0x6: not a fee
    raw(STRK, 'Transfer', A, C, 10n ** 18n, { tx: '0x7', index: 0 }), // under chat 2's floor
    raw(OTHER, 'Transfer', felt64('0x0'), A, 2000000n, { tx: '0x8', index: 0 }), // a mint, muted in chat 2
  ]);
  const alerts = await alertsOf(groups, w);
  const of = (chat) => alerts.filter((a) => a.chat === chat).map((a) => [a.tx, plain(a.text).split('\n')[0]]);
  assert.deepEqual(of('1'), [
    [felt64('0x6'), '⬆️ Out · 0x0000…00a1 · 0.000000000000000009 STRK to sequencer 0x0000…05e9'],
    [felt64('0x7'), '⬆️ Out · 0x0000…00a1 · 1 STRK to 0x0000…00c3'],
    [felt64('0x8'), '⬇️ In · 0x0000…00a1 · 2 USDC (unverified token 0x0000…0077) minted'],
  ]);
  assert.deepEqual(of('2'), []); // under its floor, or muted
  assert.deepEqual(of('3'), [[felt64('0x8'), '🐋 Whale mint · 2 USDC (unverified token 0x0000…0077) to 0x0000…00a1']]);
  // The sender was read for the two candidate fee payments only.
  assert.equal(w.rpc.calls.filter((c) => c.method === 'starknet_getTransactionByHash').length, 2);
});

test('approvals by a watched owner show the spender and "unlimited"; a watched spender alone is not alerted', async () => {
  const w = world();
  watch(w.state, 1, A, 'Vault');
  const groups = byTransaction([
    raw(OTHER, 'Approval', A, C, 1234567n, { tx: '0x9', index: 0 }),
    raw(STRK, 'Approval', A, B, (1n << 128n) - 1n, { tx: '0x9', index: 1, legacy: true }),
    raw(OTHER, 'Approval', C, A, 9n, { tx: '0x9', index: 2 }),
  ]);
  const [alert] = await alertsOf(groups, w);
  const text = plain(alert.text);
  assert.equal(text.match(/Approval/g).length, 2);
  assert.match(text, /Vault 0x0000…00a1 lets spender 0x0000…00c3 spend 1\.234567 USDC/);
  assert.match(text, /spend unlimited STRK/);
});

test('contracts that are not coins, and NFTs, are dropped without hiding the valid events', async () => {
  const w = world({ contracts: { [NFT]: { symbol: [ascii('NFT')] } } });
  watch(w.state, 1, A);
  const groups = byTransaction([
    raw(NFT, 'Transfer', A, C, 5n, { tx: '0xa', index: 0, legacy: true }),
    raw(address(0x404), 'Transfer', A, C, 5n, { tx: '0xa', index: 1 }),
    raw(STRK, 'Transfer', A, C, 9n * 10n ** 18n, { tx: '0xa', index: 2 }),
  ]);
  const [alert] = await alertsOf(groups, w);
  assert.deepEqual(alert.indexes, [2]);
});

test('an event already in the ledger is not alerted again, and a watch remembers the unverified tokens it saw', async () => {
  const w = world();
  watch(w.state, 1, A);
  const groups = byTransaction([raw(OTHER, 'Transfer', C, A, 5n, { tx: '0xb', index: 0 }), raw(OTHER, 'Transfer', C, A, 5n, { tx: '0xb', index: 1 })]);
  const first = await alertsOf(groups, w);
  assert.equal(record(w.state, first[0]), true);
  assert.deepEqual(w.state.chats[1].watches[0].seen, [OTHER]);
  assert.deepEqual(await alertsOf(groups, w), []);
  assert.equal(record(w.state, first[0]), false);
});

test('the ledger delivers whole messages in order, keyed by chat, transaction and event index, and follows a migration', () => {
  const state = emptyState();
  record(state, { chat: -5, tx: '0xt1', indexes: [0, 3], at: 100, text: 'first' });
  record(state, { chat: -5, tx: '0xt2', indexes: ['l2'], at: 100, text: 'second' });
  assert.deepEqual(Object.keys(state.ledger), ['-5|0xt1|0', '-5|0xt1|3', '-5|0xt2|l2']);
  let [next] = pending(state);
  assert.deepEqual([next.text, next.keys], ['first', ['-5|0xt1|0', '-5|0xt1|3']]);
  markSent(state, next, 77);
  assert.deepEqual(state.ledger[alertKey(-5, '0xt1', 3)], { chat: '-5', tx: '0xt1', seq: 1, at: 100, status: 'sent', message_id: 77 });
  chatOf(state, -5).watches.push({ id: 1, address: A, label: '', since_block: 1, seen: [] });
  migrate(state, -5, -100);
  [next] = pending(state);
  assert.deepEqual([next.chat, next.text], ['-100', 'second']);
  assert.deepEqual(Object.keys(state.chats), ['-100']);
  prune(state, 100 + 7 * 24 * 3600 + 1);
  assert.deepEqual(state.ledger, {});
});

test('a user gets 10 commands in 60 s of message.date, then one notice, then silence until the window passes', () => {
  const state = emptyState();
  const verdicts = Array.from({ length: 13 }, (_, i) => admit(state, 7, 1000 + i));
  assert.deepEqual(verdicts, [...Array(10).fill('answer'), 'notice', 'ignore', 'ignore']);
  assert.equal(admit(state, 8, 1013), 'answer');
  assert.equal(admit(state, 7, 1069), 'answer');
  forgetIdle(state, 1069 + 60);
  assert.deepEqual(state.users, {});
});

test('a pasted input is offered by a server id, for its chat only, and expires after a day of chain time', () => {
  const state = emptyState();
  const data = offer(state, 1, 'watch', A, 100);
  assert.match(data, /^w:\d+$/);
  const id = data.slice(2);
  assert.equal(take(state, 2, 'watch', id), null);
  assert.equal(take(state, 1, 'track', id), null);
  assert.equal(take(state, 1, 'watch', id), A);
  assert.equal(take(state, 1, 'watch', id), null);
  offer(state, 1, 'track', B, 100);
  expire(state, 100 + 86401);
  assert.deepEqual(state.offers, {});
});

test('settings validate their input, cap entries, and /list buttons are short and work only in their chat', async () => {
  const w = world();
  const ctx = (chat) => ({ ...w, chatId: String(chat) });
  const say = async (chat, name, argument) => (await configure({ name, argument }, ctx(chat))).lines?.map(plain).join('\n');
  assert.match(await say(1, 'watch', `${A} Vault`), /Watching Vault/);
  assert.match(await say(1, 'watch', `${B} ${'x'.repeat(33)}`), /at most 32 characters/);
  assert.match(await say(1, 'whale', 'STRK -1'), /Invalid amount/);
  assert.match(await say(1, 'whale', `${OTHER} 2.5`), /Whale alerts from block 21: every transfer of 2\.5 USDC \(unverified token/);
  assert.match(await say(1, 'min', 'STRK 0.5'), /under 0\.5 STRK are hidden/);
  assert.match(await say(1, 'mute', '0x0'), /Invalid address/);
  assert.match(await say(1, 'track', `0x${'f'.repeat(64)}`), /Invalid hash/);
  const [page] = list(ctx(1));
  const buttons = page.keyboard.flat();
  assert.deepEqual(buttons.map((b) => b.text), ['Remove Vault', 'Remove whale USDC (unverified)', 'Remove floor STRK']);
  assert.ok(buttons.every((b) => Buffer.byteLength(b.callback_data) <= 64 && /^rm:\d+$/.test(b.callback_data)));
  assert.equal((await press(buttons[0].callback_data, ctx(2))).answer, 'Already removed, or not from this chat.');
  const removed = await press(buttons[0].callback_data, ctx(1));
  assert.equal(removed.answer, 'Removed.');
  assert.doesNotMatch(removed.edit.lines.map(plain).join('\n'), /Vault/);
});

test('/export is the chat\'s data as JSON, split into <pre> messages, and /forget leaves nothing of the chat', async () => {
  const w = world();
  for (let i = 1; i <= 20; i++) watch(w.state, 1, address(0x1000 + i), `<label ${i}> & more`);
  watch(w.state, 2, A, 'other chat');
  record(w.state, { chat: 1, tx: '0xt', indexes: [0], at: 1, text: 'pending <label 1>' });
  offer(w.state, 1, 'watch', B, 1);
  const pages = await configure({ name: 'export', argument: '' }, { ...w, chatId: '1' });
  assert.ok(pages.length > 1);
  const json = JSON.parse(pages.map((p) => plain(p.lines.join('\n'))).join(''));
  assert.equal(json.chat_id, 1);
  assert.equal(json.watches.length, 20);
  assert.equal(json.watches[0].label, '<label 1> & more');
  assert.deepEqual([json.minimums, json.whales, json.tracks, json.muted], [{}, [], [], []]);
  forget(w.state, 1);
  assert.doesNotMatch(JSON.stringify(w.state), /label \d+|"chat":"1"/);
  assert.deepEqual(exportOf(w.state, 2).watches.map((x) => x.label), ['other chat']);
});

test('a track posts on L2, then on L1, once each; a revert once with its escaped reason; an unknown hash after 600 s', async () => {
  const state = emptyState();
  const statuses = { '0x1': { finality_status: 'ACCEPTED_ON_L2', execution_status: 'SUCCEEDED' },
    '0x2': { finality_status: 'ACCEPTED_ON_L2', execution_status: 'REVERTED', failure_reason: 'Bad <x>' } };
  const receipt = { actual_fee: { amount: '0x9', unit: 'FRI' }, block_number: 10 };
  const rpc = node({ statuses, receipts: { '0x1': receipt, '0x2': receipt } });
  for (const hash of ['0x1', '0x2', '0x3']) chatOf(state, 1).tracks.push({ id: state.nextId++, hash, since_block: 10, at: 1000, stage: 'new' });
  const follow = (timestamp) => followTracks(state, { rpc, head: { block_number: 10, timestamp }, link, clean: String });
  const posts = () => pending(state).map((m) => plain(m.text).split('\n')[0]);
  await follow(1000);
  assert.deepEqual(posts(), ['✅ Accepted on L2 · SUCCEEDED · fee 0.000000000000000009 STRK · block 10', '❌ Reverted · accepted on L2 · fee 0.000000000000000009 STRK · block 10']);
  assert.match(plain(pending(state)[1].text), /Revert reason: Bad <x>/);
  await follow(1599);
  assert.equal(posts().length, 2);
  statuses['0x1'] = { finality_status: 'ACCEPTED_ON_L1', execution_status: 'SUCCEEDED' };
  await follow(1600);
  assert.deepEqual(posts().slice(2), ['🏁 Accepted on L1: final.', '❔ Transaction not found within 10 minutes of chain time: tracking stopped.']);
  assert.equal(state.chats[1], undefined); // every track finished
  await follow(1700);
  assert.equal(posts().length, 4);
});
