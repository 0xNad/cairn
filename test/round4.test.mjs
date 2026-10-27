import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Guards, seedRun, blockedLink } from '../src/guard.mjs';
import { Network, duration } from '../src/network.mjs';
import { Store } from '../src/store.mjs';
import { Ledger } from '../src/ledger.mjs';
import { Names, encode } from '../src/names.mjs';
import { tradeOf, tradeFeed } from '../src/trades.mjs';
import { plan, summarise } from '../src/summary.mjs';
import { Prices, parseMedian, valueOf, usdText } from '../src/prices.mjs';
import { chainOrder } from '../src/bot.mjs';
import { answer } from '../src/commands.mjs';
import { hex64, SELECTORS } from '../src/felt.mjs';
import { links } from '../src/format.mjs';
import { startHttp } from '../src/http.mjs';
import { RpcPool } from '../src/rpcpool.mjs';
import { NodeBusy, RpcError } from '../src/errors.mjs';
const storeOf = () => new Store(mkdtempSync(join(tmpdir(), 'cairn-r4-')));
const words = readFileSync(new URL('../wordlists/bip39-english.txt', import.meta.url), 'utf8').trim().split('\n');
for (const n of [12,15,18,21,24]) test(`guard deletes exact ${n} word run`, () => assert.equal(seedRun(words.slice(0,n).join(' ')), true));
test('guard rejects 11, 13, interrupted runs and five sentences of prose', () => {
  for (const text of [words.slice(0,11).join(' '), words.slice(0,13).join(' '), words.slice(0,6).join(' ')+' not_a_word '+words.slice(6,12).join(' '),
    'The sun came up over the hill. We took a walk by the river. My friend brought a book to read. After lunch we went back home. It was a good day for a quiet walk.']) assert.equal(seedRun(text),false);
});
for (const url of ['https://STARKNET-BOT.COM/a','http://starknet-bot.com','https://sub.starknet-bot.com','https://person@starknet-bot.com/path']) test(`blocked host ${url}`,()=>assert.equal(blockedLink(url,['starknet-bot.com']),true));
for (const url of ['https://starknet-bot.com.safe.example','https://safestarknet-bot.com','https://safe.example/starknet-bot.com','https://starknet-bot.com@safe.example','https://evil-example.com','https://example.com.evil']) test(`safe lookalike ${url}`,()=>assert.equal(blockedLink(url,['starknet-bot.com','example.com']),false));
test('guard settings persist, forget resets defaults, other chat survives',()=>{
  const store=storeOf(); try {const g=new Guards(store,[]);g.set({id:1,type:'private'},'seed',false);g.set({id:2,type:'private'},'network',true);
  assert.equal(new Guards(store,[]).settings(1).seed,0);store.sql('DELETE FROM protection WHERE chat_id=1').run();assert.equal(g.settings(1).seed,1);assert.equal(g.settings(2).network,1);}finally{store.close()}
});
test('B2 nets only swaps touching the target, with signs; routed hops stay zero',()=>{
  const venue={key:'avnu',aggregator:true,address:'pool'};
  const swap=(a,x,b,y)=>({venue,legs:[{token:a,amount:x},{token:b,amount:y}]});
  const vs=[venue];
  assert.equal(tradeOf('STRK',[swap('STRK',1000n,'USDC',-125n),swap('ETH',-1n,'USDC',250n)],[],vs).nets.get('USDC'),-125n);
  const route=[swap('ETH',-1n,'USDC',125n),swap('USDC',-125n,'STRK',1000n)];
  assert.equal(tradeOf('STRK',route,[],vs).nets.get('USDC'),-125n);
  assert.equal(tradeOf('USDC',route,[],vs),null);
  assert.equal(tradeOf('HOP',route,[{kind:'Transfer',token:'HOP',a:'pool',b:'user'}],vs),null);
});
test('B3 twelve trades preserve 900000 STRK and largest remaining link; budget spans deliveries',()=>{
  const rows=Array.from({length:12},(_,i)=>({seq:i,kind:'trade',tx_hash:`tx${i}`,block:1,digest:JSON.stringify({k:'trade',side:'sell',token:'t',symbol:'STRK',decimals:0,verified:true,amount:String(i===9?900000:i+1),cents:null})}));
  const {full,rest}=plan(rows,'supergroup',0);assert.ok(full.some(r=>r.seq===9));
  const summary=summarise(rest,{tx:(tx,text)=>`${text} [${tx}]`});assert.match(summary,/Largest: Sell 11 STRK/);assert.match(summary,/tx10/);
  assert.deepEqual(plan(rows,'group',3),{full:[],rest:[]});
});
test('B4 reads trade block each time including replacement and treats zero as absent',async()=>{
  const calls=[];let price='0x773594'; // 0.078125; use exact .125 below
  price='0xbebc20';
  const prices=new Prices({contracts:{pragma:'p'}},{call:async(m,p)=>{calls.push(p.block_id);return [price,'0x8','0x64','0x1','0x1']}});
  const token={verified:true,pragma_pair:'STRK/USD'};
  const sample=await prices.usd(token,{number:10,timestamp:100});assert.equal(usdText(valueOf(1000n,0,sample)),'$125.00');
  prices.reset();price='0x17d7840';assert.equal((await prices.usd(token,{number:10,timestamp:100})).price,25000000n);assert.deepEqual(calls,[{block_number:10},{block_number:10}]);
  assert.deepEqual(parseMedian(['0x0','0x8','0x64','0x1','0x1']),{missing:true});
});
test('C1 failed forward verification retries next pass',async()=>{
  const store=storeOf();try{let reverse=0,back=hex64('0x2');const address=hex64('0x1');
  const rpc={call:async(m,p)=>p.request.entry_point_selector===SELECTORS.address_to_domain?(reverse++,['0x1',`0x${encode('ben').toString(16)}`]):[back]};
  const names=new Names({contracts:{naming:'n'}},store,rpc);assert.equal(await names.display(address,100),null);back=address;names.reset();assert.equal(await names.display(address,101),'ben.stark');assert.equal(reverse,2);
  }finally{store.close()}
});
test('C2 balance shows a verified reverse name',async()=>{
  const address=hex64('0x1');const config={chain:'SN_MAIN',tokens:[],explorer:'https://x.example'};
  const result=await answer({name:'balance',argument:address},{config,rpc:{call:async()=>[]},clean:String,head:{block_number:1,timestamp:100},names:{display:async()=> 'ben.stark'},signal:new AbortController().signal,tokens:{registry:new Map()}});
  assert.match(result.join('\n'),/ben.stark/);
});
test('C3 absent chain position sorts safely',()=>assert.doesNotThrow(()=>[{block:1},{position:[2,0,0]},{}].sort(chainOrder)));
test('network wall-time latch, recovery duration and outage persist',async()=>{
  const store=storeOf();try {const ledger=new Ledger(store),g=new Guards(store,[]);g.set({id:1,type:'private'},'network',true);store.cursor=10;
  const network=new Network({stallSeconds:2,maxGap:100,confirmations:0,operatorChat:2},store,{},ledger);
  const h={block_number:10,block_hash:'0x1',timestamp:100};await network.step(h,1000);await network.step(h,2999);assert.equal(ledger.pending().length,0);
  await network.step(h,3000);await network.step(h,4000);assert.equal(ledger.pending().length,1);
  await network.step({...h,block_number:11,block_hash:'0x2'},5000);assert.match(ledger.pending()[1].body,/4 s/);
  await network.step(null,6000);await network.step(null,7000);assert.equal(ledger.pending().filter(r=>r.chat_id===2).length,1);assert.equal(duration(252000),'4 min 12 s');
  }finally{store.close()}
});
test('http exposes live snapshots and exactly two GET routes',async()=>{
  let updates=1;const server=await startHttp({httpPort:0,httpHost:'127.0.0.1'},()=>({head:10,lag:3,updates,sent:1,alerts:0,errors:0}));
  try {const url=`http://127.0.0.1:${server.address().port}`;assert.deepEqual(await (await fetch(url+'/healthz')).json(),{ok:true,head:10,lag_s:3});updates++;
  assert.match(await (await fetch(url+'/metrics')).text(),/cairn_updates_total 2/);assert.equal((await fetch(url+'/healthz',{method:'POST'})).status,404);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
});
test('rpcpool restarts a page before transmitting a foreign token',async()=>{
  const pool=new RpcPool({rpcUrls:['http://a','http://b']},new AbortController().signal);let secondary=0;
  pool.clients=[{call:async()=>{throw new NodeBusy()}},{call:async()=>{secondary++;return []}}];
  await assert.rejects(pool.call('starknet_getEvents',{filter:{continuation_token:'foreign'}}),e=>e instanceof RpcError&&e.code===33);assert.equal(secondary,0);
  await pool.call('starknet_getEvents',{filter:{}});assert.equal(secondary,1);
});

test('B1 sale says Received, buy says Paid; B5 250k sale stays within five short lines',async()=>{
  const { render }=await import('../src/trades.mjs');
  const token={address:hex64('0x1'),symbol:'STRK',decimals:0,verified:true},quote={...token,address:hex64('0x2'),symbol:'USDC'};
  const post={token,side:'sell',amount:1000n,others:[{token:quote,amount:125n}],value:{num:125n,den:1n},trader:hex64('0x3'),name:'ben.stark',block:{timestamp:100},venue:{name:'Ekubo'},tx:'0x4'};
  const fmt=links({explorer:'https://x.example'},String);
  assert.match(render(post,{},fmt),/Received 125 USDC/);assert.doesNotMatch(render(post,{},fmt),/Paid/);
  assert.match(render({...post,side:'buy'},{},fmt),/Paid 125 USDC/);
  const html=render({...post,amount:2000000n,value:{num:250000n,den:1n},others:[{token:quote,amount:250000n}]},{},fmt);
  const lines=html.replace(/<[^>]+>/g,'').split('\n');assert.equal(lines.length,5);assert.ok(lines.every(l=>Array.from(l).length<=32),lines.join('\n'));assert.match(lines.at(-1),/Ekubo · \d\d:\d\d UTC · tx/);
});
test('guard warning cannot repeat any protected BIP39 word, even without delete rights',async()=>{
  const {guardWarning}=await import('../src/guard.mjs');const vocabulary=new Set(words);
  for(const kind of ['seed','links'])for(const removed of [true,false]){
    const warning=guardWarning(kind,removed).join('\n');
    for(const word of warning.toLowerCase().match(/[a-z]+/g)) assert.equal(vocabulary.has(word),false,word);
    assert.ok(warning.split('\n').length<=2);if(!removed)assert.match(warning,/Delete messages/);
  }
});
test('HTTP handler health reasons, live counters and method boundaries without IO',async()=>{
  const {httpHandler}=await import('../src/http.mjs');let reason=null,updates=0;
  const handle=httpHandler(()=>({head:10,lag:2,reason,updates,sent:1,alerts:1,errors:1}));
  const request=(url,method='GET')=>{let code,body,headers;handle({url,method},{writeHead:(c,h)=>{code=c;headers=h},end:b=>{body=b}});return {code,body,headers}};
  assert.deepEqual(JSON.parse(request('/healthz').body),{ok:true,head:10,lag_s:2});
  for(reason of ['rpc','stalled','telegram']){assert.equal(request('/healthz').code,503);assert.equal(JSON.parse(request('/healthz').body).reason,reason)}
  updates=3;assert.match(request('/metrics').body,/cairn_updates_total 3/);
  for(const path of ['/','/healthz/a','/healthz?x=1'])assert.equal(request(path).code,404);assert.equal(request('/metrics','POST').code,404);
});

/** In-memory services exercise the actual pass, scanner and SQLite ledger without a socket. */
async function passWorld(extra={}) {
  const {Bot}=await import('../src/bot.mjs');
  const directory=mkdtempSync(join(tmpdir(),'cairn-pass-'));
  let store=new Store(directory), head=10, fork=0, nextMessage=100, admin=true, deleteAllowed=true, messageId=0;
  const token=hex64('0x70'),trader=hex64('0x20'),peer=hex64('0x21');
  const config={tokens:[{address:token,symbol:'STRK',decimals:0}],contracts:{},maxWatches:20,maxBlocks:500,pollMs:100000,
    confirmations:0,stallSeconds:120,maxGap:50000,reorgDepth:4,operatorChat:null,blocklist:['example.com'],explorer:'https://x.example',...extra};
  const blocks=new Map(Array.from({length:11},(_,n)=>[n,{block_number:n,block_hash:`0x${(n+100).toString(16)}`,timestamp:1000+n*2,sequencer_address:'0x99'}]));
  const txs=new Map(), sent=[], calls=[], deletes=[];
  const rpc={errors:0,clients:[],call:async(method,p)=>{
    calls.push([method,p]);
    if(method==='starknet_getBlockWithTxHashes')return blocks.get(p.block_id==='latest'?head:p.block_id.block_number);
    if(method==='starknet_getTransactionReceipt'){const tx=txs.get(p.transaction_hash);if(!tx)throw new RpcError(29);return {block_number:tx.block};}
    if(method==='starknet_getEvents'){
      const f=p.filter,events=[...txs.values()].filter(t=>t.block>=f.from_block.block_number&&t.block<=f.to_block.block_number).flatMap((t,index)=>t.events.map((e,i)=>({...e,block_number:t.block,transaction_hash:t.hash,event_index:i,transaction_index:index})));
      const offset=Number(f.continuation_token??0),end=offset+5;return {events:events.slice(offset,end),...(end<events.length?{continuation_token:String(end)}:{})};
    }
    throw Error(method);
  }};
  const tg={healthy:true,call:async(method,p)=>{
    if(method==='sendMessage'){sent.push({...p,message_id:++nextMessage});return {message_id:nextMessage};}
    if(method==='getUpdates')return [];
    if(method==='getChatMember')return {status:admin?'administrator':'member'};
    if(method==='deleteMessage'){deletes.push(p);return deleteAllowed?true:null;}
    return true;
  }};
  const create=()=>new Bot({config,store,rpc,tg,clean:String,username:'cairn_bot',me:{id:99},signal:new AbortController().signal,identity:{chain:'SN_MAIN',spec:'0.10.3'}});
  let bot=create();
  const pass=async()=>{bot.newPass();await bot.readHead();await bot.background();await bot.deliver()};
  const command=async(chat,text,extra={})=>bot.handle({update_id:++messageId,message:{message_id:messageId,chat,from:{id:chat.id===1?1:2},date:100000+messageId*61,text,...extra}});
  const add=(n=1)=>{for(let i=0;i<n;i++){head++;blocks.set(head,{block_number:head,block_hash:`0x${(head+100+fork*1000).toString(16)}`,timestamp:1000+head*2,sequencer_address:'0x99'})}};
  const tx=(hash,block=head,amount=100n)=>{const t={hash:hex64(hash),block,events:[{from_address:token,keys:[SELECTORS.Transfer,peer,trader],data:[`0x${amount.toString(16)}`,'0x0']}]};txs.set(t.hash,t);return t};
  const reorg=ancestor=>{fork++;for(let n=ancestor+1;n<=head;n++)blocks.get(n).block_hash=`0x${(n+100+fork*1000).toString(16)}`;for(const [key,t]of txs)if(t.block>ancestor)txs.delete(key)};
  const chat={id:1,type:'private'},group={id:-2,type:'supergroup'};
  await pass();
  return {config,chat,group,sent,calls,deletes,tx,add,reorg,pass,command,txs,
    get bot(){return bot},get store(){return store},get head(){return head},
    setAdmin:v=>{admin=v},setDelete:v=>{deleteAllowed=v},
    restart:()=>{store.close();store=new Store(directory);bot=create()},close:()=>store.close()};
}

test('three-block fork rewinds scanner, corrects orphan replies and preserves re-inclusion across restart',async()=>{
  const w=await passWorld();try{
    await w.command(w.chat,'/watch 0x20');w.add();const a=w.tx('0xa');w.add();const b=w.tx('0xb');w.add();const c=w.tx('0xc');await w.pass();
    const initial=w.sent.filter(m=>/View transaction/.test(m.text));assert.equal(initial.length,3);
    w.reorg(10);w.txs.set(b.hash,{...b,block:13});const x=w.tx('0xd',11),y=w.tx('0xe',12);
    w.restart();const before=w.sent.length;await w.pass();const replacement=w.sent.slice(before);
    const corrections=replacement.filter(m=>/Correction/.test(m.text));assert.equal(corrections.length,2);
    assert.deepEqual(corrections.map(m=>m.reply_parameters.message_id),[initial[0].message_id,initial[2].message_id]);
    assert.ok(replacement.some(m=>m.text.includes(x.hash)));assert.ok(replacement.some(m=>m.text.includes(y.hash)));
    assert.ok(replacement.findIndex(m=>m.text.includes(x.hash))<replacement.findIndex(m=>m.text.includes(y.hash)));
    assert.equal(replacement.filter(m=>m.text.includes(b.hash)).length,0);
    const after=w.sent.length;w.restart();await w.pass();assert.equal(w.sent.length,after);
    w.reorg(10);await w.pass();assert.equal(w.sent.filter(m=>m.reply_parameters?.message_id===initial[0].message_id).length,1);
    assert.ok(w.store.sql('SELECT count(*) n FROM blocks').get().n<=4);
  }finally{w.close()}
});
test('confirmation depth and gap equality run through the existing scanner',async()=>{
  const w=await passWorld({confirmations:2,maxGap:3});try{
    await w.command(w.chat,'/network on');await w.command(w.chat,'/watch 0x20');w.add();const t=w.tx('0xa');await w.pass();assert.ok(w.store.cursor<=w.head-2);assert.ok(!w.sent.some(m=>m.text.includes(t.hash)));
    w.add(2);await w.pass();assert.equal(w.sent.filter(m=>m.text.includes(t.hash)).length,1);
    w.add(3);const equal=w.tx('0xb',w.head-2);await w.pass();assert.equal(w.sent.filter(m=>m.text.includes(equal.hash)).length,1);
    w.add(4);const skipped=w.tx('0xc',w.head-2);await w.pass();assert.ok(!w.sent.some(m=>m.text.includes(skipped.hash)));assert.equal(w.sent.filter(m=>/Skipped/.test(m.text)).length,1);await w.pass();assert.equal(w.sent.filter(m=>/Skipped/.test(m.text)).length,1);
  }finally{w.close()}
});
test('B3 six-block catch-up and repeated deliver share the group budget, including network and corrections',async()=>{
  const w=await passWorld({maxBlocks:1});try{
    await w.command(w.group,'/watch 0x20');for(let i=0;i<6;i++){w.add();for(let j=0;j<4;j++)w.tx(`0x${(100+i*4+j).toString(16)}`)}
    const before=w.sent.length;for(let i=0;i<6;i++)await w.pass();assert.equal(w.sent.length-before,3);
    w.bot.ledger.add({chatId:-2,txHash:'stall:test',eventIndex:-10,kind:'network',chainTime:1012,body:'⏸ No new blocks.'});
    w.bot.ledger.add({chatId:-2,txHash:'0x123',eventIndex:-10000000,kind:'correction',chainTime:1012,body:'↩️ Correction.',digest:{reply:101}});
    await w.bot.deliver();assert.equal(w.sent.length-before,3);
    w.bot.budget.start=-Infinity;w.bot.newPass();await w.bot.deliver();assert.equal(w.sent.length-before,6);assert.ok(w.sent.some(m=>m.reply_parameters?.message_id===101));
  }finally{w.close()}
});
test('guard deletes privately and in groups, warns without rights, and member cannot disable',async()=>{
  const w=await passWorld();try{
    const phrase=words.slice(0,12).join(' ');for(const chat of [w.chat,w.group]){
      await w.command(chat,phrase);assert.equal(w.deletes.at(-1).chat_id,chat.id);assert.match(w.sent.at(-1).text,/recovery/);
      w.setDelete(false);await w.command(chat,phrase);assert.match(w.sent.at(-1).text,/Delete messages/);w.setDelete(true);
      await w.command(chat,'/guard seed off');const before=w.deletes.length;await w.command(chat,phrase);assert.equal(w.deletes.length,before);await w.command(chat,'/guard seed on');
    }
    w.setAdmin(false);await w.command(w.group,'/guard seed off');assert.match(w.sent.at(-1).text,/administrator/);const n=w.deletes.length;await w.command(w.group,phrase);assert.equal(w.deletes.length,n+1);
    w.restart();await w.command(w.chat,'/export');assert.ok(!w.sent.at(-1).text.includes(phrase));assert.ok(!readFileSync(w.store.file).includes(Buffer.from(phrase)));
    for(const url of ['https://evil-example.com','https://example.com.evil','https://example.com@safe.example']){const n=w.sent.length;await w.command(w.chat,url);assert.equal(w.sent.length,n)}
  }finally{w.close()}
});

test('network notices survive restart, reach only subscribers/operator, and reset after recovery',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'cairn-network-'));let store=new Store(directory);
  const config={stallSeconds:2,maxGap:100,confirmations:0,operatorChat:3};
  const head={block_number:10,block_hash:'0xa',timestamp:100};
  try{
    const guards=new Guards(store,[]);guards.set({id:1,type:'private'},'network',true);guards.set({id:2,type:'private'},'network',false);store.cursor=10;
    let ledger=new Ledger(store),network=new Network(config,store,{},ledger);await network.step(head,1000);await network.step(head,3000);
    for(const row of ledger.pending())ledger.sent(row.seq,100+row.seq);
    store.close();store=new Store(directory);ledger=new Ledger(store);network=new Network(config,store,{},ledger);
    await network.step(head,4000);assert.equal(ledger.pending().length,0);await network.step({...head,block_hash:'0xb'},5000);
    assert.equal(ledger.pending().length,1);assert.match(ledger.pending()[0].body,/Recovered after 4 s/);assert.equal(ledger.pending()[0].chat_id,1);
    await network.step(null,6000);assert.equal(ledger.pending().filter(r=>r.chat_id===3).length,1);
    store.close();store=new Store(directory);ledger=new Ledger(store);network=new Network(config,store,{},ledger);
    await network.step(null,7000);assert.equal(ledger.pending().filter(r=>r.chat_id===3).length,1);
    await network.step({...head,block_hash:'0xc'},8000);await network.step(null,9000);assert.equal(ledger.pending().filter(r=>r.chat_id===3).length,2);
    assert.equal(ledger.pending().filter(r=>r.chat_id===2).length,0);
  }finally{store.close()}
});
test('configured depth bounds the fork walk and retained hashes',async()=>{
  const w=await passWorld({reorgDepth:2});try{
    w.add(4);await w.pass();assert.equal(w.store.sql('SELECT count(*) n FROM blocks').get().n,2);w.reorg(10);
    const before=w.calls.length;await w.pass();const reads=w.calls.slice(before).filter(([m,p])=>m==='starknet_getBlockWithTxHashes'&&p.block_id!=='latest');
    assert.ok(reads.length);assert.ok(reads.every(([,p])=>p.block_id.block_number>=w.head-2));assert.equal(w.store.cursor,w.head);
  }finally{w.close()}
});
for(const text of ['starknet-bot.com/drop','www.starknet-bot.com','(https://starknet-bot.com).'])test(`bare or punctuated listed link ${text}`,()=>assert.equal(blockedLink(text,['starknet-bot.com']),true));

test('rpcpool verifies every endpoint and refuses a different chain with exit 2',async()=>{
  const {handshake}=await import('../src/bot.mjs');
  const pool=new RpcPool({rpcUrls:['http://a','http://b']},new AbortController().signal);const calls=[];
  pool.clients=['0x534e5f4d41494e','0x534e5f5345504f4c4941'].map((chain,i)=>({call:async method=>{calls.push([i,method]);return method==='starknet_chainId'?chain:'0.10.3'}}));
  await assert.rejects(handshake(pool,{chain:'SN_MAIN'},String),e=>e.exitCode===2&&/chain.*SN_SEPOLIA/.test(e.message));assert.ok(calls.some(([i,m])=>i===1&&m==='starknet_chainId'));
});
test('rpcpool dead primary falls through while application errors do not rotate',async()=>{
  const pool=new RpcPool({rpcUrls:['http://a','http://b']},new AbortController().signal);
  pool.clients=[{call:async()=>{throw new NodeBusy()}},{call:async()=>42}];
  assert.equal(await pool.call('starknet_blockNumber'),42);assert.equal(pool.active,1);assert.ok(pool.errors>0);
  pool.clients[1].call=async()=>{throw new RpcError(29)};await assert.rejects(pool.call('starknet_getTransactionReceipt'),e=>e.code===29);assert.equal(pool.active,1);
});
test('round4 config defaults, two endpoint override, invalid numbers and blacklist fail before IO',async()=>{
  const {loadConfig}=await import('../src/config.mjs');
  const env={TELEGRAM_BOT_TOKEN:`12:${'x'.repeat(30)}`,STARKNET_RPC_URLS:'http://a, http://b',CAIRN_DATA:join(tmpdir(),'cairn-unused-r4')};
  const config=loadConfig(['tick'],env);assert.deepEqual(config.rpcUrls,['http://a/','http://b/']);
  assert.deepEqual([config.confirmations,config.stallSeconds,config.reorgDepth,config.maxGap,config.httpPort,config.httpHost],[0,120,64,50000,null,'127.0.0.1']);
  for(const [key,value]of [['CAIRN_CONFIRMATIONS','101'],['CAIRN_STALL_SECONDS','1'],['CAIRN_REORG_DEPTH','0'],['CAIRN_MAX_GAP','1.5'],['CAIRN_HTTP_PORT','65536'],['CAIRN_OPERATOR_CHAT','bad'],['STARKNET_RPC_URLS','http://a,'],['CAIRN_BLOCKLIST','/nonexistent-cairn-blocklist']])assert.throws(()=>loadConfig(['tick'],{...env,[key]:value}),e=>e.exitCode===2&&e.message.includes(key));
});
test('C4 venue documentation gives one entry and the exact generated filter keys',()=>{
  const readme=readFileSync(new URL('../README.md',import.meta.url),'utf8');
  for(const term of ["key: 'pool3'","contract: 'pool3_core'",'address: config.contracts.pool3_core','keys: [[SELECTORS.Swapped]]'])assert.ok(readme.includes(term));
});
test('health uses current request time for lag and flags Telegram without an RPC read',async()=>{
  const w=await passWorld();const original=Date.now;try{
    Date.now=()=>1025000;assert.equal(w.bot.snapshot().lag,5);const n=w.calls.length;Date.now=()=>1027000;assert.equal(w.bot.snapshot().lag,7);assert.equal(w.calls.length,n);
    w.bot.tg.healthy=false;assert.equal(w.bot.snapshot().reason,'telegram');w.bot.tg.healthy=true;w.bot.head=null;assert.equal(w.bot.snapshot().reason,'rpc');
  }finally{Date.now=original;w.close()}
});

test('failed history read leaves cursor and new alerts untouched until retry',async()=>{
  const w=await passWorld();try{
    await w.command(w.chat,'/watch 0x20');w.add(2);const t=w.tx('0xa',11);
    const call=w.bot.rpc.call;let fail=true;
    w.bot.rpc.call=async(m,p)=>{if(fail&&m==='starknet_getBlockWithTxHashes'&&p.block_id?.block_number===11)throw new NodeBusy();return call(m,p)};
    await w.pass();assert.equal(w.store.cursor,10);assert.ok(!w.sent.some(m=>m.text.includes(t.hash)));
    fail=false;await w.pass();assert.equal(w.store.cursor,12);assert.equal(w.sent.filter(m=>m.text.includes(t.hash)).length,1);
    assert.ok(w.store.sql('SELECT hash FROM blocks WHERE number=11').get());
  }finally{w.close()}
});
