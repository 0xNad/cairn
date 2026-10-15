import test from 'node:test';
import assert from 'node:assert/strict';
import { respond } from '../src/commands.mjs';
import { RpcError } from '../src/rpc.mjs';
import { fakeTelegram } from '../.launchpad/checks/round-1/fake-telegram.mjs';
import { telegram } from '../src/telegram.mjs';

const hash = `0x${'1'.padStart(64, '0')}`;
const username = 'cairn_check_bot';
const me = { id: 1234, is_bot: true, first_name: 'Cairn', username };
const block = { block_number: 100 };
const missing = () => { throw new RpcError('Transaction hash not found', 29); };

async function render(node) {
  const tg = await fakeTelegram({ token: `1234:${'x'.repeat(32)}`, me }).listen();
  try {
    const chat = tg.dm(tg.user(42, 'Tester'));
    tg.say(chat, tg.user(42, 'Tester'), `/tx ${hash}`);
    const config = { explorer: 'https://voyager.online', token: `1234:${'x'.repeat(32)}`, telegramRoot: tg.url };
    const html = await respond(`/tx ${hash}`, username, config, node, block, '0.10.3');
    for (const text of html) await telegram(config).send(chat.id, text);
    return tg.to(chat.id);
  } finally { await tg.close(); }
}

test('known transaction without receipt shows known status, not a false absence or fee', async () => {
  const sent = await render({ call: async method => {
    if (method === 'starknet_getTransactionStatus') return { finality_status: 'RECEIVED' };
    return missing();
  } });
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Transaction 0x0000…0001/);
  assert.match(sent[0].text, /Finality: RECEIVED/);
  assert.match(sent[0].text, /Receipt unavailable\. Check again shortly\./);
  assert.doesNotMatch(sent[0].text, /not found|Block:|Fee:/i);
  assert.match(sent[0].html, /href="https:\/\/voyager\.online\/tx\/0x0{63}1"/);
});

test('unknown transaction remains not found when the status lookup fails', async () => {
  const sent = await render({ call: async () => missing() });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'Transaction not found');
});
