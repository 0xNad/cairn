import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { FIELD, hex64, normalize, SELECTORS } from '../src/felt.mjs';
import { links } from '../src/format.mjs';
import { encodeLabel, decodeLabel, Names } from '../src/names.mjs';
import { meetsUsd, parsePrice, Prices, usdValue } from '../src/prices.mjs';
import { decodeSwaps, netTrade, traderFromTransfers } from '../src/trades.mjs';
import { decodeTokenEvents } from '../src/scanner.mjs';
import { Store } from '../src/store.mjs';
import { Subscriptions } from '../src/subscriptions.mjs';
import { Ledger } from '../src/ledger.mjs';
import { feedSetting } from '../src/feed-settings.mjs';
const h = n => `0x${BigInt(n).toString(16)}`;
const [TOKEN, QUOTE, EKUBO, AVNU, TRADER, OTHER, WRAPPER] = [1,2,3,4,5,6,7].map(n => normalize(h(n)));
const config = { maxWatches: 20, priceMaxAge: 900, explorer: 'https://explorer.example', contracts: { ekubo_core: EKUBO, avnu_exchange: AVNU, pragma: OTHER, naming: WRAPPER } };
const token = { address: TOKEN, symbol: 'T', decimals: 6, pragma_pair: 'T/USD', verified: true };
const fmt = links(config, String);
const p = (value=125000000n, age=0, sources=4) => parsePrice([h(value),'0x8',h(1000-age),h(sources),'0x1'],1000,900);
function storeAt(t) {
  const path = mkdtempSync(join(tmpdir(),'cairn-r3-'));
  t.after(() => rmSync(path,{recursive:true,force:true}));
  return path;
}
const event = (from, keys, data, index=0) => ({from_address:from,keys,data,block_number:10,transaction_hash:'0x123',event_index:index});
const words = n => [h(n % (1n<<128n)),h(n>>128n)];
const signed = n => [h(n < 0n ? -n : n),h(n<0n?1:0)];
function ekubo(a,b,index=0) {
  return event(EKUBO,[SELECTORS.Swapped],[WRAPPER,TOKEN,QUOTE,'0x0','0x0','0x0','0x0','0x0','0x0','0x0','0x0','0x0',...signed(a),...signed(b),'0x0','0x0','0x0','0x0','0x0'],index);
}
function avnu(sell,buy,a,b,index=1) { return event(AVNU,[SELECTORS.Swap],[WRAPPER,sell,...words(a),buy,...words(b),WRAPPER],index); }
const transfer = (a,b,amount,index,legacy=false) => event(TOKEN,legacy?[SELECTORS.Transfer]:[SELECTORS.Transfer,a,b],legacy?[a,b,...words(amount)]:words(amount),index);

test('USD display rounds half up, keeps tiny values explicit and compares unrounded floors', () => {
  assert.equal(usdValue(1000000n,token,p()),'$1.25');
  assert.equal(usdValue(804000n,token,p()),'$1.01'); // exactly 1.005
  assert.equal(usdValue(799999n,token,p()),'$1.00');
  assert.equal(meetsUsd(799999n,token,p(),1n,0),false); // display is not a threshold oracle
  assert.equal(meetsUsd(800000n,token,p(),1n,0),true);
  assert.equal(usdValue(1n,token,p()),'<$0.01');
  assert.equal(usdValue(0n,token,p()),'$0.00');
  assert.equal(usdValue(1n,{...token,verified:false},p()),null);
  const big=(1n<<128n)+7n;
  assert.equal(meetsUsd(big,{...token,decimals:0},p(100000000n),big,0),true);
  assert.equal(meetsUsd(big-1n,{...token,decimals:0},p(100000000n),big,0),false);
});
test('oracle boundary, expiration, missing, future and unsourced answers cannot misprice alerts', () => {
  assert.equal(p(1n,900).fresh,true); assert.equal(p(1n,901).fresh,false);
  assert.equal(p(1n,-1).fresh,false); assert.equal(p(1n,0,0).fresh,false);
  assert.equal(parsePrice(['0','0','0','0','1'],1000,900),null);
  assert.equal(parsePrice(['1','8','1000','2','0','999'],1000,900).fresh,false);
  assert.equal(parsePrice(['1','8','1000','2','0','1000'],1000,900).fresh,true);
  for(const bad of [[],['1','8','1000','2','0'],['1','37','1000','2','1'],['1','8','1000','2','2'],['-1','8','1000','2','1']]) assert.throws(()=>parsePrice(bad,1000,900));
  assert.equal(usdValue(1000000n,token,p(125000000n,901)),null);
});
test('price cache isolates pairs and refreshes at the next pass even at the same head', async () => {
  let calls=0, fail=true;
  const prices=new Prices(config,{async call(_,params){calls++;assert.equal(params.block_id.block_number,10);if(fail&&params.request.calldata[1] === '0x422f555344')throw Error();return ['125','2','1000','4','1'];}});
  const bad={...token,pragma_pair:'B/USD'};
  assert.equal(await prices.get(bad,1000,{block_number:10}),null);
  assert.equal((await prices.get(token,1000,{block_number:10})).value,125n);
  await prices.get(token,1000,{block_number:10});assert.equal(calls,2);
  fail=false;prices.reset();assert.equal((await prices.get(bad,1000,{block_number:10})).fresh,true);assert.equal(calls,3);
});
test('name codec preserves trailing a, digits and the published extended alphabet', () => {
  for(const [s,n] of [['a',37n],['aa',1406n],['ben',18925n],['banana',2958826757n],['abc-123',89594016830n]]) {
    assert.equal(encodeLabel(s),n);assert.equal(decodeLabel(n),s);
  }
  for(const s of ['来','这','来来','abc这','abc来','abc来ab','ab-09','aaa'])assert.equal(decodeLabel(encodeLabel(s)),s);
  assert.ok(encodeLabel('z'.repeat(60))>=FIELD);
});
test('forward input rejects subdomains uppercase overflow and zero answers before use', async () => {
  const calls=[];
  const names=new Names(config,{async call(_,params){calls.push(params);return ['0x0'];}});
  for(const s of ['a.b.stark','BAD.stark','a_b.stark','z'.repeat(60)+'.stark'])await assert.rejects(names.resolve(s),/Invalid/);
  assert.equal(calls.length,0);await assert.rejects(names.resolve('ben.stark'),/Unknown/);
  assert.deepEqual(calls[0].request.calldata,['0x1','0x49ed','0x0']);
  assert.equal(await names.resolve('0x5'),TRADER);
  await assert.rejects(new Names({contracts:{}},{}).resolve('ben.stark'),/not configured/);
});
test('every reverse label is forward verified at the same block and mismatches remain addresses', async () => {
  let wrong=false;const calls=[];
  const names=new Names(config,{async call(_,params){calls.push(params);return params.request.entry_point_selector===SELECTORS.address_to_domain?['0x2','0x1','0x49ed']:[wrong?OTHER:TRADER];}});
  assert.equal(await names.reverse(TRADER,{block_number:10}),'b.ben.stark');
  assert.deepEqual(calls[1].request.calldata,['0x2','0x1','0x49ed','0x0']);
  assert.ok(calls.every(c=>c.block_id.block_number===10));
  wrong=true;names.reset();assert.equal(await names.reverse(TRADER,{block_number:10}),null);
});
test('venue decoders reject malformed signed values and duplicate pages without losing u256 precision', () => {
  const a=ekubo(-100n,200n), bad=ekubo(-100n,200n);bad.data[13]='0x2';
  const short={...a,data:a.data.slice(1)},spoof={...a,from_address:OTHER};
  const v=decodeSwaps([a,a,bad,short,spoof,avnu(TOKEN,QUOTE,(1n<<128n)+7n,9n)],config.contracts);
  assert.equal(v.length,2);assert.equal(v[0].deltas.get(TOKEN),100n);
  assert.equal(v[1].deltas.get(TOKEN),-((1n<<128n)+7n));
});
test('relevant AVNU takes precedence including zero round trips while unrelated routes do not', () => {
  const decode=raw=>decodeSwaps(raw,config.contracts);
  assert.equal(netTrade(decode([ekubo(-100n,200n),avnu(QUOTE,TOKEN,80n,40n)]),TOKEN).net,40n);
  assert.equal(netTrade(decode([ekubo(-100n,200n),avnu(QUOTE,OTHER,80n,40n)]),TOKEN).venue,'Ekubo');
  assert.equal(netTrade(decode([ekubo(-100n,200n),avnu(QUOTE,TOKEN,80n,40n),avnu(TOKEN,QUOTE,40n,80n,2)]),TOKEN).net,0n);
  assert.equal(netTrade(decode([ekubo(-140n,280n),ekubo(40n,-80n,1)]),TOKEN).net,100n);
});
test('trader selection nets self transfers, excludes venues and fees, and honors earliest ties', () => {
  const raw=[transfer(EKUBO,OTHER,80n,1),transfer(OTHER,TRADER,60n,2),transfer(EKUBO,TRADER,20n,3,true),transfer(TRADER,TRADER,500n,4),transfer(EKUBO,AVNU,5000n,5),transfer(OTHER,WRAPPER,9999n,6)];
  const events=decodeTokenEvents(raw);const exclude=new Set([EKUBO,AVNU]);
  assert.equal(traderFromTransfers(events,TOKEN,100n,exclude,6),TRADER);
  const ties=decodeTokenEvents([transfer(EKUBO,OTHER,50n,7),transfer(EKUBO,TRADER,50n,8)]);
  assert.equal(traderFromTransfers(ties,TOKEN,100n,exclude),OTHER);
  assert.equal(traderFromTransfers(decodeTokenEvents([transfer(TRADER,EKUBO,30n,0)]),TOKEN,-30n,exclude),TRADER);
  assert.equal(traderFromTransfers(decodeTokenEvents([transfer(EKUBO,AVNU,30n,0)]),TOKEN,30n,exclude),null);
});
test('group summary is durable across restart, shares receipt and never replays members', t => {
  const path=storeAt(t);let store=new Store(path),subs=new Subscriptions(store,config),ledger=new Ledger(store);
  const chat={id:-1,type:'supergroup'};
  store.transaction(()=>{subs.chat(chat);for(let i=0;i<8;i++)ledger.add({chatId:-1,txHash:h(i+1),eventIndex:0,kind:'alert',topic:17,chainTime:1000,body:'pending private body'});ledger.summarize(fmt);});
  assert.equal(ledger.pending().length,3);assert.match(ledger.pending()[2].body,/6 more alerts/);
  store.close();store=new Store(path);ledger=new Ledger(store);
  try{
    store.transaction(()=>ledger.summarize(fmt));assert.equal(ledger.pending().length,3);
    for(const row of ledger.pending())store.transaction(()=>ledger.sent(row.seq,123));
    assert.equal(ledger.pending().length,0);
    assert.equal(store.sql('SELECT count(*) n FROM deliveries WHERE state = ?').get('sent').n,9);
    assert.equal(store.sql('SELECT count(*) n FROM deliveries WHERE body IS NOT NULL').get().n,0);
    assert.equal(ledger.add({chatId:-1,txHash:'0x8',eventIndex:0,kind:'alert',topic:17,chainTime:1000,body:'duplicate'}),false);
  }finally{store.close();}
});
test('private alerts are never summarized, and identical keys in different topics remain independent', t => {
  const store=new Store(storeAt(t));t.after(()=>store.close());const subs=new Subscriptions(store,config),ledger=new Ledger(store);
  subs.chat({id:1,type:'private'});subs.chat({id:-1,type:'supergroup'});
  for(let i=0;i<5;i++)ledger.add({chatId:1,txHash:h(i+1),eventIndex:0,kind:'alert',chainTime:1000,body:'private'});
  for(const topic of [17,21])assert.equal(ledger.add({chatId:-1,txHash:'0x8',eventIndex:0,kind:'alert',topic,chainTime:1000,body:'topic'}),true);
  store.transaction(()=>ledger.summarize(fmt));assert.equal(ledger.pending().length,7);
});
test('paused summaries retain unsent work beyond retention and re-summarize new backlog once', t => {
  const store=new Store(storeAt(t));t.after(()=>store.close());const subs=new Subscriptions(store,config),ledger=new Ledger(store);
  subs.chat({id:-1,type:'supergroup'});
  const add=(i)=>ledger.add({chatId:-1,txHash:h(i),eventIndex:0,kind:'feed',topic:17,chainTime:1000,body:'x'});
  for(let i=1;i<=5;i++)add(i);store.transaction(()=>ledger.summarize(fmt));
  subs.pause(-1);ledger.prune(1000+8*86400);assert.equal(ledger.pending().length,0);
  subs.resume(-1);for(let i=6;i<=10;i++)add(i);store.transaction(()=>ledger.summarize(fmt));
  let rows=ledger.pending();assert.equal(rows.length,3);assert.match(rows[2].body,/8 more alerts/);
  for(let i=11;i<=15;i++)add(i);store.transaction(()=>ledger.summarize(fmt));
  rows=ledger.pending();assert.equal(rows.length,3);assert.match(rows[2].body,/13 more alerts/);
  for(const r of rows)store.transaction(()=>ledger.sent(r.seq,987));
  assert.equal(store.sql("SELECT count(*) n FROM deliveries WHERE state <> 'sent'").get().n,0);
});
test('feeds and topics migrate and export, then permanent deletion leaves no feed marker', t => {
  const path=storeAt(t),store=new Store(path),subs=new Subscriptions(store,config);
  store.transaction(()=>{subs.feed({id:-1,type:'supergroup'},TOKEN,'feed-marker-delete',123n,false,'all',10,17);subs.watch({id:-1,type:'supergroup'},TRADER,'label-to-delete',10,21);subs.migrate(-1,-2);});
  assert.equal(subs.export(-2).feed.topic,17);assert.equal(subs.export(-2).watches[0].topic,21);
  assert.equal(subs.feedFor(-1),null);store.transaction(()=>subs.forget(-2));assert.equal(subs.feedFor(-2),null);store.close();
  for(const f of readdirSync(path))assert.equal(readFileSync(join(path,f)).includes('feed-marker-delete'),false);
});
test('round 2 database upgrade retains cursor, offset, subscriptions and confirmed receipts', t => {
  const path=storeAt(t),db=new DatabaseSync(join(path,'state.db'));
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
    INSERT INTO meta VALUES ('schema','2'),('offset','88'),('cursor','99');
    CREATE TABLE watches(id INTEGER PRIMARY KEY AUTOINCREMENT,chat_id INTEGER NOT NULL,address TEXT NOT NULL,label TEXT,since_block INTEGER NOT NULL,UNIQUE(chat_id,address)) STRICT;
    INSERT INTO watches VALUES (1,1,'${TRADER}','old',50);
    CREATE TABLE deliveries(seq INTEGER PRIMARY KEY AUTOINCREMENT,chat_id INTEGER NOT NULL,tx_hash TEXT NOT NULL,event_index INTEGER NOT NULL,kind TEXT NOT NULL,events TEXT NOT NULL,block INTEGER,chain_time INTEGER NOT NULL,state TEXT NOT NULL,message_id INTEGER,body TEXT,UNIQUE(chat_id,tx_hash,event_index)) STRICT;
    INSERT INTO deliveries VALUES(1,1,'0x1',0,'alert','[0]',51,1000,'sent',77,NULL);`);
  db.close();const store=new Store(path);
  try{assert.equal(store.offset,88);assert.equal(store.cursor,99);assert.equal(store.get('schema'),'3');assert.equal(new Subscriptions(store,config).watches(1)[0].topic,0);assert.equal(new Ledger(store).messageId(1,'0x1',0),77);}finally{store.close();}
});
test('unauthorized feed commands perform no lookup or mutation, anonymous admin authorization is supplied by bot', async () => {
  let touched=0;const ctx={chat:{id:-1,type:'supergroup'},admin:async()=>false,tokens:{resolve(){touched++;}},subs:{unfeed(){touched++;}}};
  for(const name of ['feed','unfeed']){const commit=await feedSetting({name,argument:'STRK'},ctx);assert.match(commit().lines.join(' '),/administrator/);}
  assert.equal(touched,0);
});

test('busy wallet alerts keep valid bounded HTML when verified names are long', async () => {
  const { findAlerts } = await import('../src/alerts.mjs');
  const raw=Array.from({length:20},(_,i)=>transfer(OTHER,TRADER,((1n<<256n)-1n),i));
  const interests={watchers:new Map([[TRADER,[{chatId:1,since:0,topic:0}]]]),whales:new Map(),muted:new Set(),floors:new Map(),labels:new Map()};
  const rpc={async call(method){assert.equal(method,'starknet_getBlockWithTxHashes');return {timestamp:1000,sequencer_address:WRAPPER};}};
  const {deliveries}=await findAlerts(decodeTokenEvents(raw),{interests,tokens:{strk:TOKEN,async get(){return token;}},rpc,now:1000,fmt,names:{async reverse(){return 'a'.repeat(122)+'.stark';}}});
  assert.equal(deliveries.length,1);assert.ok(deliveries[0].body.length<=4096);assert.match(deliveries[0].body,/more in this transaction/);
  const {parseHtml}=await import('../.launchpad/checks/round-3/fake-telegram.mjs');
  assert.equal(parseHtml(deliveries[0].body).error,undefined);
});

test('legacy wallet fee suppression verifies sender while trades never infer trader from sender', async () => {
  const { findAlerts } = await import('../src/alerts.mjs');
  const interests={watchers:new Map([[TRADER,[{chatId:1,since:0,topic:0}]]]),whales:new Map(),muted:new Set(),floors:new Map(),labels:new Map()};
  const calls=[];
  const rpc={async call(method){calls.push(method);
    if(method==='starknet_getBlockWithTxHashes')return {timestamp:1000,sequencer_address:WRAPPER};
    if(method==='starknet_getTransactionReceipt')return {events:[{}],actual_fee:{unit:'FRI',amount:'0x9'}};
    if(method==='starknet_getTransactionByHash')return {sender_address:OTHER};
    throw Error('unexpected RPC');
  }};
  const {deliveries}=await findAlerts(decodeTokenEvents([transfer(TRADER,WRAPPER,9n,0)]),{interests,tokens:{strk:TOKEN,async get(){return token;}},rpc,now:1000,fmt});
  assert.equal(deliveries.length,1);assert.equal(calls.filter(c=>c==='starknet_getTransactionByHash').length,1);
});
