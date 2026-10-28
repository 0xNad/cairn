import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedRun, blockedLink } from '../src/protection.mjs';
import { Store } from '../src/store.mjs';
import { Subscriptions } from '../src/subscriptions.mjs';
import { Operations } from '../src/operations.mjs';
import { Ledger } from '../src/ledger.mjs';
import { RpcError } from '../src/errors.mjs';

test('dictionary protection checks consecutive words, not checksum, with no substring matches', () => {
  const phrase = 'zoo zone zero zebra youth young you yellow year write wrong wrist';
  assert.equal(seedRun(phrase.toUpperCase()), true);
  assert.equal(seedRun(phrase.replace('yellow','notaword')), false);
  assert.equal(seedRun('please check our latest status report for this community bot'), false);
});
test('blocked hosts include hidden text links and exclude userinfo, paths and suffix lookalikes', () => {
  assert.equal(blockedLink({entities:[{type:'text_link',url:'https://drop.bad.example/'}]},['bad.example']),true);
  for (const url of ['https://bad.example@safe.example/', 'https://safe.example/bad.example','https://bad.example.safe/']) assert.equal(blockedLink({text:url},['bad.example']),false);
});
test('protection settings migrate with the chat and forget removes only that chat', () => {
  const dir=mkdtempSync(join(tmpdir(),'cairn-r4-')), store=new Store(dir);
  try {
    const subs=new Subscriptions(store, {maxWatches:20});
    store.sql('INSERT INTO protection(chat_id,network,seed) VALUES (1,1,0),(2,1,1)').run();
    subs.migrate(1,3);
    assert.equal(subs.export(3).protection.seed,0);
    subs.forget(3);
    assert.equal(subs.export(3).protection,undefined);
    assert.equal(subs.export(2).protection.network,1);
  } finally {store.close();rmSync(dir,{recursive:true});}
});
test('fork correction shares existing ledger message identity and persists across later forks', async () => {
  const dir=mkdtempSync(join(tmpdir(),'cairn-fork-')), store=new Store(dir);
  try {
    const ledger=new Ledger(store), sent=[];
    store.cursor=11;
    store.sql('INSERT INTO headers VALUES (10,?), (11,?)').run('a','old');
    ledger.add({chatId:1,txHash:'0x123',eventIndex:0,kind:'transfer',block:11,chainTime:10,body:'transfer'});
    ledger.sent(1,99);
    const bot={store,config:{reorgDepth:2},ledger,head:{block_number:11,block_hash:'new'},rpc:{call:async(method,p)=>{
      if(method==='starknet_getTransactionByHash') throw new RpcError(29);
      return {block_hash:p.block_id.block_number===10?'a':'new'};
    }},send:async(chat,text,extra)=>{sent.push(extra);return {message:{message_id:100}}}};
    const ops=new Operations(bot);
    await ops.reconcile();
    assert.equal(store.cursor,10);
    assert.deepEqual(sent,[{reply_parameters:{message_id:99}}]);
    store.sql("UPDATE headers SET hash='another-old' WHERE number=11").run();
    await new Operations(bot).reconcile();
    assert.equal(sent.length,1);
    assert.equal(ledger.add({chatId:1,txHash:'0x123',eventIndex:0,kind:'transfer',block:11,chainTime:10,body:'transfer'}),false);
  } finally {store.close();rmSync(dir,{recursive:true});}
});
