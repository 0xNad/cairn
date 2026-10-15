import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { rpc } from '../src/rpc.mjs';
import { telegram } from '../src/telegram.mjs';

async function server(handler) {
  const s = createServer(handler);
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  return { s, url: `http://127.0.0.1:${s.address().port}` };
}

for (const client of ['rpc', 'telegram']) {
  test(`${client} refuses redirects to an unconfigured host`, async () => {
    let contacts = 0;
    const target = await server((req, res) => { contacts++; res.end('{}'); });
    const source = await server((req, res) => {
      res.writeHead(307, { location: `${target.url}/unconfigured` });
      res.end('redirect');
    });
    try {
      if (client === 'rpc') {
        const node = rpc({ rpcUrl: `${source.url}/private-provider-path`, rps: 5, rpcTimeoutMs: 1000 });
        await assert.rejects(node.call('starknet_chainId'));
      } else {
        const bot = telegram({ telegramRoot: source.url, token: '1234:abcdefghijklmnopqrstuvwxyzABCDE' });
        await assert.rejects(bot.call('getMe'));
      }
      assert.equal(contacts, 0);
    } finally {
      await Promise.all([new Promise(resolve => source.s.close(resolve)), new Promise(resolve => target.s.close(resolve))]);
    }
  });
}
