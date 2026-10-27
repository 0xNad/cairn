#!/usr/bin/env node
// Round 4's scenarios as a chat transcript: Cairn runs as a child process (`node cairn.mjs tick`, then `run` for
// /healthz) against the fake Telegram and the fake Starknet node of .launchpad/checks/round-4, and every message it
// sends is printed as a member would read it. No network: everything runs on 127.0.0.1. `npm run transcript`.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { fakeTelegram } from '../.launchpad/checks/round-4/fake-telegram.mjs';
import { erc20, fakeStarknet, felt, feltOf } from '../.launchpad/checks/round-4/fake-starknet.mjs';
import { ADDR, T0, transfer } from '../.launchpad/checks/round-4/fixtures.mjs';
import { loadWordlist } from '../src/guards.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// A placeholder in the token's shape, put together at run time so that no file of the repository holds one.
const TOKEN = ['7700445566', 'transcript-placeholder-not-a-real-token'].join(':');
const EXPLORER = 'https://voyager.online';
const scratch = mkdtempSync(join(tmpdir(), 'cairn-transcript-'));
let serial = 0;

const say = (who, text) => console.log(`${who} ${text.split('\n').join(`\n${' '.repeat(3)}`)}`);
const note = (text) => console.log(`   … ${text}`);

async function world(extra = {}) {
  const id = ++serial;
  const tg = await fakeTelegram({ token: TOKEN, me: { id: 7700445566, is_bot: true, first_name: 'Cairn', username: 'cairn_demo_bot' }, t0: T0 }).listen();
  const nodes = [await fakeStarknet({ t0: T0 }).listen('/rpc/key')];
  nodes[0].contract(ADDR.token, erc20({ symbol: 'STRK', decimals: 0 }));
  const network = join(scratch, `network-${id}.json`);
  writeFileSync(network, JSON.stringify({ chain: 'SN_MAIN', tokens: [{ symbol: 'STRK', address: felt(ADDR.token), decimals: 0 }] }));
  const w = {
    tg, nodes, node: nodes[0], seen: new Map(),
    env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API_ROOT: tg.url, STARKNET_RPC_URL: nodes[0].url, CAIRN_CHAIN: 'SN_MAIN', CAIRN_DATA: join(scratch, `data-${id}`),
      CAIRN_NETWORK_FILE: network, CAIRN_EXPLORER_URL: EXPLORER, CAIRN_POLL_MS: '100', CAIRN_TG_TIMEOUT: '1', CAIRN_RPC_RPS: '100', CAIRN_RPC_TIMEOUT_MS: '300',
      CAIRN_LOG: 'error', ...extra },
    async second() {
      const n = await fakeStarknet({ t0: T0 }).listen('/backup/key');
      n.contract(ADDR.token, erc20({ symbol: 'STRK', decimals: 0 }));
      nodes.push(n);
      w.env.STARKNET_RPC_URLS = nodes.map((x) => x.url).join(',');
      return n;
    },
    person(group = false) {
      const u = tg.user(9000 + serial * 10 + nodes.length, 'Member');
      const chat = group ? tg.group(-(9000 + serial), 'Demo group') : tg.dm(u);
      if (group) tg.members.set(`${chat.id}:${u.id}`, 'administrator');
      return { u, chat };
    },
    tick() {
      return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['cairn.mjs', 'tick'], { cwd: ROOT, env: { PATH: process.env.PATH, ...w.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tick exited ${code}: ${err.slice(-300)}`))));
      });
    },
    /** Prints what Cairn sent to `p` since last time; a correction shows the message it replies to. */
    show(p) {
      const all = tg.to(p.chat.id), from = w.seen.get(p.chat.id) ?? 0;
      for (const m of all.slice(from)) {
        const to = m.params.reply_parameters?.message_id;
        say(to ? '🤖 ↪' : '🤖', `${m.text}${to ? `\n(a reply to message ${all.findIndex((x) => x.message_id === to) + 1} of this chat)` : ''}`);
      }
      w.seen.set(p.chat.id, all.length);
    },
    async command(p, text, shown = text) {
      say('👤', shown);
      tg.say(p.chat, p.u, text, { date: T0 + 100 + ++serial * 61 });
      await w.tick();
      w.show(p);
    },
    tx(events, block = w.node.head.number) {
      const t = { hash: feltOf(`transcript ${++serial}`), block, fee: 1n, sender: ADDR.relayer, finality: 'ACCEPTED_ON_L2', execution: 'SUCCEEDED', events };
      w.node.tx(t);
      return t;
    },
    close: () => Promise.all([tg.close(), ...nodes.map((n) => n.close())]),
  };
  return w;
}
const scenario = async (title, fn, extra) => {
  console.log(`\n━━ ${title} ━━`);
  const w = await world(extra);
  try { await fn(w); } finally { await w.close(); }
};

await scenario('A stall, then blocks again (CAIRN_STALL_SECONDS=2)', async (w) => {
  const p = w.person(true);
  await w.command(p, '/network on');
  await sleep(2300);
  note('no new block for 2.3 s');
  await w.tick(); w.show(p);
  w.node.addBlock();
  note(`block ${w.node.head.number} arrives`);
  await w.tick(); w.show(p);
}, { CAIRN_STALL_SECONDS: '2' });

await scenario('A reorg takes back an alerted transfer, and replaces it', async (w) => {
  const p = w.person();
  await w.command(p, `/watch ${felt(ADDR.trader)} Treasury`);
  w.node.addBlock();
  const t = w.tx([transfer(ADDR.other, ADDR.trader, 100n)]);
  note(`a transfer to Treasury in block ${t.block}`);
  await w.tick(); w.show(p);
  w.node.reorgAfter(t.block - 1);
  w.tx([transfer(ADDR.other, ADDR.trader, 250n)], t.block);
  note(`block ${t.block} is replaced: the first transfer is gone, another one is in its place`);
  await w.tick(); w.show(p);
});

await scenario('A reorg re-includes the transaction in the next block: nothing more to say', async (w) => {
  const p = w.person();
  await w.command(p, `/watch ${felt(ADDR.trader)} Treasury`);
  w.node.addBlock();
  const t = w.tx([transfer(ADDR.other, ADDR.trader, 100n)]);
  await w.tick(); w.show(p);
  w.node.addBlock();
  w.node.reorgAfter(t.block - 1);
  w.node.tx({ ...t, block: t.block + 1 });
  note(`blocks ${t.block} and ${t.block + 1} are replaced, with the same transaction in block ${t.block + 1}`);
  await w.tick(); w.show(p);
  note('(no message: no duplicate, no false correction)');
});

await scenario('Every RPC endpoint fails: the operator alone is told, once', async (w) => {
  await w.second();
  const op = w.person(), member = w.person();
  w.env.CAIRN_OPERATOR_CHAT = String(op.chat.id);
  await w.command(op, '/status');
  await w.command(member, '/network on');
  for (const n of w.nodes) n.down(60_000);
  note('both endpoints of STARKNET_RPC_URLS go down');
  await w.tick(); await w.tick();
  w.show(op);
  note('(the member with /network on hears nothing: the chain may be fine)');
  w.show(member);
  for (const n of w.nodes) { n.down(0); n.addBlock(); }
  note('the endpoints answer again');
  await w.tick(); w.show(op);
});

await scenario('Back after a long downtime: a gap longer than CAIRN_MAX_GAP=3 is skipped once', async (w) => {
  const p = w.person();
  await w.command(p, `/watch ${felt(ADDR.trader)} Treasury`);
  for (let i = 0; i < 5; i++) w.node.addBlock();
  note('5 blocks arrive while Cairn is stopped');
  await w.tick(); w.show(p);
}, { CAIRN_MAX_GAP: '3' });

const WORDS = [...loadWordlist()];
await scenario('The guards: a seed phrase and a phishing link, in a private chat and in a group', async (w) => {
  const p = w.person(), g = w.person(true);
  const phrase = Array.from({ length: 12 }, (_, i) => WORDS[(i * 157 + 41) % WORDS.length]).join(' ');
  await w.command(p, phrase, '(12 words of the BIP-39 list: a made-up seed phrase)');
  await w.command(p, 'Claim your airdrop at https://claim.starknet-bot.com/drop');
  await w.command(p, 'Our site is https://starknet-bot.com.safe.example/ and https://safe.example/starknet-bot.com');
  note('(not deleted: neither host is, or sits under, a listed domain)');
  w.tg.fail('deleteMessage', { chat: g.chat.id, code: 400, description: "Bad Request: message can't be deleted" });
  await w.command(g, phrase, '(the same phrase, in a group where Cairn may not delete messages)');
  await w.command(g, '/guard');
});

await scenario('/healthz while a node answers, then stops moving (run, CAIRN_HTTP_PORT=0, CAIRN_STALL_SECONDS=2)', async (w) => {
  const child = spawn(process.execPath, ['cairn.mjs', 'run'], { cwd: ROOT, env: { PATH: process.env.PATH, ...w.env, CAIRN_LOG: 'info', CAIRN_HTTP_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let port = null, out = '';
    child.stderr.on('data', (d) => { out += d; port ??= /"event":"http","port":(\d+)/.exec(out)?.[1] ?? null; });
    for (let i = 0; i < 100 && !port; i++) await sleep(50);
    const health = async () => { const r = await fetch(`http://127.0.0.1:${port}/healthz`); return `${r.status} ${await r.text()}`; };
    for (let i = 0; i < 50 && !(await health()).startsWith('200'); i++) await sleep(100);
    say('$', `curl 127.0.0.1:${port}/healthz\n${await health()}`);
    await sleep(2300);
    note('no new block for 2.3 s');
    say('$', `curl 127.0.0.1:${port}/healthz\n${await health()}`);
    const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    say('$', `curl 127.0.0.1:${port}/metrics | grep -v '^#' | head -6\n${metrics.split('\n').filter((l) => l && !l.startsWith('#')).slice(0, 6).join('\n')}`);
  } finally { child.kill('SIGTERM'); }
}, { CAIRN_STALL_SECONDS: '2' });
