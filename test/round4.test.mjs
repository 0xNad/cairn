import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Guards, seedRun, blockedLink } from '../src/guard.mjs';
import { Network, duration } from '../src/network.mjs';
import { Store } from '../src/store.mjs';
import { Ledger, STAGE } from '../src/ledger.mjs';
import { Subscriptions } from '../src/subscriptions.mjs';
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
test('judge 1: guards delete numbered, punctuated and extended seed runs but keep prose',async()=>{
  const w=await passWorld();try{
    const phrase=words.slice(0,12),formats=[phrase.join(' '),phrase.join(', '),phrase.join('; '),phrase.join('. '),phrase.join('\n'),
      phrase.map((x,i)=>`${i+1}. ${x}`).join(' '),phrase.map((x,i)=>`${i+1}) ${x}`).join(' '),
      phrase.map((x,i)=>`${i+1} ${x}`).join(' '),phrase.map((x,i)=>`#${i+1} ${x}`).join(' '),
      phrase.map((x,i)=>i%2?x.toUpperCase():x).join(', '),`My seed: "${phrase.join(' ')}" thanks`,
      ...[13,14,25].map(n=>words.slice(0,n).join(' ')),phrase.join(' ')+' help'];
    for(const body of formats){const n=w.deletes.length;await w.command(w.chat,body);assert.equal(w.deletes.length,n+1,body)}
    const prose='Please check the account balance and confirm the action before you access the private area today. '+
      'Our team will review the project status after lunch. We can help each other learn how the system works. '+
      'Keep your account secure and ask the team if you need assistance. The market may change before our next meeting.';
    for(const body of [phrase.slice(0,11).join(' '),phrase.slice(0,6).join(' ')+' not_a_bip39_word '+phrase.slice(6).join(' '),
      'Please help us check this ordinary project status.',prose]){const n=w.deletes.length;await w.command(w.chat,body);assert.equal(w.deletes.length,n,body)}
  }finally{w.close()}
});
for (const url of ['https://STARKNET-BOT.COM/a','http://starknet-bot.com','https://sub.starknet-bot.com','https://person@starknet-bot.com/path']) test(`blocked host ${url}`,()=>assert.equal(blockedLink(url,['starknet-bot.com']),true));
for (const url of ['https://starknet-bot.com.safe.example','https://safestarknet-bot.com','https://safe.example/starknet-bot.com','https://starknet-bot.com@safe.example','https://evil-example.com','https://example.com.evil']) test(`safe lookalike ${url}`,()=>assert.equal(blockedLink(url,['starknet-bot.com','example.com']),false));
test('guard settings persist, forget resets defaults, other chat survives',()=>{
  const store=storeOf(); try {const g=new Guards(store,[]);g.set({id:1,type:'private'},'seed',false);g.set({id:2,type:'private'},'links',false);
  assert.equal(new Guards(store,[]).settings(1).seed,0);store.sql('DELETE FROM protection WHERE chat_id=1').run();assert.equal(g.settings(1).seed,1);assert.equal(g.settings(2).links,0);}finally{store.close()}
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
  const store=storeOf();try {const ledger=new Ledger(store),subs=new Subscriptions(store,{});subs.network({id:1,type:'private'},true);store.cursor=10;
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
test('judge 2: fixed guard warnings explain deletion and advice without echoing protected input',async()=>{
  const {guardWarning}=await import('../src/guard.mjs');
  for(const kind of ['seed','links'])for(const removed of [true,false]){
    const warning=guardWarning(kind,removed).join('\n'),tokens=warning.toLowerCase().match(/[a-z]+/g);
    for(const word of words.slice(0,24))assert.ok(!tokens.includes(word),word);
    assert.ok(warning.split('\n').length<=2);
    if(removed){assert.match(warning,/Deleted a message/);assert.match(warning,kind==='seed'?/Never share.*never ask/:/phishing.*\nDon't open/)}
    else assert.match(warning,/couldn't delete.*admin.*Delete messages/);
  }
  const w=await passWorld();try{
    for(const body of [words.slice(0,12).join(' '),'https://example.com/private-secret']){
      await w.command(w.chat,body);assert.equal(w.sent.at(-1).text,guardWarning(body.startsWith('https')?'links':'seed',true).join('\n'));
      assert.ok(!w.sent.at(-1).text.includes(body));
    }
  }finally{w.close()}
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
    if(method==='starknet_getTransactionStatus'){if(!txs.has(p.transaction_hash))throw new RpcError(29);return {finality_status:'ACCEPTED_ON_L2'};}
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
    w.bot.ledger.add({chatId:-2,txHash:'stall:test',eventIndex:STAGE.network,kind:'network',chainTime:1012,body:'⏸ No new blocks.'});
    const original=w.store.sql("SELECT * FROM deliveries WHERE message_id IS NOT NULL ORDER BY seq LIMIT 1").get();
    w.bot.ledger.correct(original,{block:16,chainTime:1012,body:'↩️ Correction.'});
    await w.bot.deliver();assert.equal(w.sent.length-before,3);
    w.bot.budget.start=-Infinity;w.bot.newPass();await w.bot.deliver();assert.equal(w.sent.length-before,5);assert.ok(w.sent.some(m=>m.reply_parameters?.message_id===original.message_id));
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
    const subs=new Subscriptions(store,config);subs.network({id:1,type:'private'},true);subs.network({id:2,type:'private'},false);store.cursor=10;
    let ledger=new Ledger(store),network=new Network(config,store,{},ledger);await network.step(head,1000);await network.step(head,3000);
    for(const row of ledger.pending())ledger.sent(row.seq,100+row.seq);
    store.close();store=new Store(directory);ledger=new Ledger(store);network=new Network(config,store,{},ledger);
    await network.step(head,4000);assert.equal(ledger.pending().length,0);await network.step({...head,block_hash:'0xb'},5000);
    assert.equal(ledger.pending().length,1);assert.match(ledger.pending()[0].body,/Recovered after 4 s/);assert.equal(ledger.pending()[0].chat_id,1);
    await network.step(null,6000);assert.equal(ledger.pending().filter(r=>r.chat_id===3).length,1);
    store.close();store=new Store(directory);ledger=new Ledger(store);network=new Network(config,store,{},ledger);
    await network.step(null,7000);assert.equal(ledger.pending().filter(r=>r.chat_id===3).length,1);
    await network.step({...head,block_hash:'0xc'},8000);await network.step(null,9000);assert.equal(ledger.pending().filter(r=>r.chat_id===3&&/Chain access is down/.test(r.body)).length,2);
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

test('run resets outage latch on update-path recovery and sends exactly two operator notices',async()=>{
  const w=await passWorld({operatorChat:3,tgTimeout:1});
  const controller=new AbortController(),wallClock=Date.now;
  let now=wallClock(),down=true,polls=0;
  try{
    await w.command(w.chat,'/network on');await w.command(w.group,'/network on');
    const before=w.sent.length,call=w.bot.rpc.call;
    w.bot.signal=controller.signal;
    Date.now=()=>now;
    w.bot.rpc.call=async(method,params)=>{
      if(down)throw new NodeBusy();
      const result=await call(method,params);
      return method==='starknet_getBlockWithTxHashes'?{...result,
        l1_gas_price:{price_in_fri:'0x1'},l1_data_gas_price:{price_in_fri:'0x1'},l2_gas_price:{price_in_fri:'0x1'}}:result;
    };
    const notices=()=>w.sent.slice(before).filter(m=>/Chain access is down/.test(m.text));
    w.bot.poll=async()=>{
      try { switch(++polls){
        case 1:
          assert.equal(notices().length,1);
          down=false;now+=1000;w.add();
          return [{update_id:1000,message:{message_id:1000,chat:w.chat,from:{id:1},date:200000,text:'/status'}}];
        case 2:
          assert.ok(w.sent.slice(before).some(m=>m.chat_id===1&&/Head: 11/.test(m.text)));
          assert.equal(w.store.get('rpc_outage'),'0','successful update-path head read must clear outage before its reply');
          down=true;now+=1000;w.bot.wake=true;return [];
        case 3:
          assert.equal(notices().length,2);
          w.bot.wake=true;return []; // Repeated failure must not send a third notice.
        case 4:
          assert.equal(notices().length,2);controller.abort();return [];
        default: throw Error('unexpected extra poll');
      } } catch(error) { controller.abort();throw error; }
    };
    await w.bot.run();
    assert.equal(polls,4);
    assert.deepEqual(notices().map(m=>m.chat_id),[3,3]);
  }finally{Date.now=wallClock;controller.abort();w.close()}
});

test('review 1: orphaned Accepted on L2 track notice receives one correction',async()=>{
  const w=await passWorld();try{
    const call=w.bot.rpc.call;
    w.bot.rpc.call=async(method,p)=>method==='starknet_getTransactionStatus'
      ? (w.txs.has(p.transaction_hash)?{finality_status:'ACCEPTED_ON_L2',execution_status:'SUCCEEDED'}:Promise.reject(new RpcError(29))) : call(method,p);
    await w.command(w.chat,'/track 0xa');w.add(2);w.tx('0xa',11);await w.pass();
    const notice=w.sent.find(m=>/Accepted on L2/.test(m.text));assert.ok(notice);
    const row=w.store.sql("SELECT block FROM deliveries WHERE kind='track'").get();assert.equal(row.block,11);
    w.reorg(10);await w.pass();await w.pass();
    assert.equal(w.sent.filter(m=>m.reply_parameters?.message_id===notice.message_id).length,1);
  }finally{w.close()}
});

test('review 3: each original message gets a correction in its topic, deduplicated after restart',async()=>{
  const w=await passWorld();try{
    w.add();const tx=w.tx('0xa');await w.pass();
    for(const [eventIndex,thread]of [[0,17],[1,21]])w.bot.ledger.add({chatId:1,txHash:tx.hash,eventIndex,kind:eventIndex?'trade':'alert',block:11,chainTime:1022,body:'Original notice',thread});
    await w.bot.deliver();const originals=w.sent.slice();assert.equal(originals.length,2);
    w.reorg(10);await w.pass();await w.pass();
    for(const original of originals){
      const corrections=w.sent.filter(m=>m.reply_parameters?.message_id===original.message_id);
      assert.equal(corrections.length,1);assert.equal(corrections[0].message_thread_id,original.message_thread_id);
    }
    const count=w.sent.length;w.restart();await w.pass();w.reorg(10);await w.pass();await w.pass();assert.equal(w.sent.length,count);
  }finally{w.close()}
});

test('review 4: deleted original does not discard its correction',async()=>{
  const {TelegramRefused}=await import('../src/errors.mjs');
  const w=await passWorld();try{
    w.bot.ledger.add({chatId:1,txHash:hex64('0xa'),eventIndex:0,kind:'alert',block:10,chainTime:1020,body:'Original notice'});
    await w.bot.deliver();const original=w.store.sql("SELECT * FROM deliveries WHERE kind='alert'").get();
    const call=w.bot.tg.call;
    w.bot.tg.call=async(method,p)=>{
      if(method==='sendMessage'&&p.reply_parameters?.message_id===original.message_id&&!p.reply_parameters.allow_sending_without_reply)
        throw new TelegramRefused(method,400,{description:'Bad Request: message to be replied not found'});
      return call(method,p);
    };
    w.bot.ledger.correct(original,{block:10,chainTime:1020,body:'↩️ Correction: transaction removed.'});await w.bot.deliver();
    assert.equal(w.store.sql("SELECT state FROM deliveries WHERE kind='correction'").get().state,'sent');
    assert.equal(w.sent.at(-1).reply_parameters.allow_sending_without_reply,true);
  }finally{w.close()}
});

test('review 5: network and guard use shared settings dispatch, persist, and reject members',async()=>{
  const {SETTINGS}=await import('../src/settings.mjs');const {respond}=await import('../src/commands.mjs');
  const w=await passWorld();try{
    assert.ok(SETTINGS.has('network')&&SETTINGS.has('guard'));
    const ctx=w.bot.context(w.group,{from:{id:2}});
    for(const command of [{name:'network',argument:'on'},{name:'guard',argument:'links off'}]){
      const commit=await respond(command,ctx);w.store.transaction(commit);
    }
    w.restart();assert.equal(w.bot.subs.networkOn(-2),true);assert.equal(w.bot.guards.settings(-2).links,0);
    await w.command(w.group,'/guard links on');w.setAdmin(false);
    for(const command of ['/network off','/guard seed off','/guard links off']){
      await w.command(w.group,command);assert.match(w.sent.at(-1).text,/administrator/);
    }
    assert.equal(w.bot.subs.networkOn(-2),true);assert.equal(w.bot.guards.settings(-2).seed,1);assert.equal(w.bot.guards.settings(-2).links,1);
    await w.command(w.chat,'/guard seed off');w.restart();assert.equal(w.bot.guards.settings(1).seed,0);
  }finally{w.close()}
});

test('review 2a: missing receipt with RECEIVED status is deferred and re-inclusion is never corrected',async()=>{
  const w=await passWorld();try{
    await w.command(w.chat,'/watch 0x20');w.add();const tx=w.tx('0xa');await w.pass();
    const original=w.sent.at(-1),call=w.bot.rpc.call;
    w.reorg(10);
    w.bot.rpc.call=async(method,p)=>method==='starknet_getTransactionStatus'?{finality_status:'RECEIVED'}:call(method,p);
    await w.pass();assert.equal(w.sent.filter(m=>m.reply_parameters?.message_id===original.message_id).length,0);
    w.restart();w.add();w.txs.set(tx.hash,{...tx,block:w.head});
    await w.pass();await w.pass();
    assert.equal(w.sent.filter(m=>m.reply_parameters?.message_id===original.message_id).length,0);
    assert.equal(w.sent.filter(m=>m.text.includes(tx.hash)).length,1);
  }finally{w.close()}
});

test('review 2b: receipt and status not-found correct immediately once across restart',async()=>{
  const w=await passWorld();try{
    await w.command(w.chat,'/watch 0x20');w.add();w.tx('0xa');await w.pass();const original=w.sent.at(-1);
    const before=w.calls.length;w.reorg(10);await w.pass();
    assert.equal(w.sent.filter(m=>m.reply_parameters?.message_id===original.message_id).length,1);
    assert.ok(w.calls.slice(before).some(([m])=>m==='starknet_getTransactionStatus'));
    w.restart();await w.pass();w.reorg(10);await w.pass();
    assert.equal(w.sent.filter(m=>m.reply_parameters?.message_id===original.message_id).length,1);
  }finally{w.close()}
});

test('review 2c: dedicated reorg checks and correction replies survive restart without digest flags',async()=>{
  const w=await passWorld();try{
    await w.command(w.chat,'/watch 0x20');w.add();w.tx('0xa');await w.pass();const original=w.sent.at(-1),call=w.bot.rpc.call;
    w.reorg(10);
    w.bot.rpc.call=async(method,p)=>{if(method==='starknet_getTransactionStatus')throw new NodeBusy();return call(method,p)};
    await w.pass();assert.equal(w.sent.filter(m=>m.reply_parameters?.message_id===original.message_id).length,0);
    assert.equal(w.bot.ledger.reorgRows('check').length,1);
    assert.ok(w.store.sql('SELECT digest FROM deliveries').all().every(r=>r.digest===null||!Object.keys(JSON.parse(r.digest)).some(k=>['reorg','rebuild','reply'].includes(k))));
    w.bot.rpc.call=call;w.restart();assert.equal(w.bot.ledger.reorgRows('check').length,1);
    w.bot.newPass();await w.bot.readHead();await w.bot.background(); // Correction is persisted before Telegram sees it.
    assert.equal(w.bot.ledger.pending()[0].reply_to,original.message_id);
    assert.equal(w.bot.ledger.pending()[0].digest,null);
    w.restart();await w.pass();w.restart();await w.pass();
    assert.equal(w.sent.filter(m=>m.reply_parameters?.message_id===original.message_id).length,1);
    // Upgrade prior round-4 files once; preserve correction reply metadata outside the digest.
    w.store.sql("UPDATE deliveries SET digest = ? WHERE kind = 'correction'").run(JSON.stringify({reply:original.message_id}));
    w.store.sql('DELETE FROM reorg_checks').run();w.store.sql("DELETE FROM meta WHERE key = 'reorg_layout'").run();
    w.restart();await w.pass();
    assert.equal(w.store.sql('SELECT reply_to FROM reorg_checks').get().reply_to,original.message_id);
    assert.equal(w.store.sql("SELECT digest FROM deliveries WHERE kind = 'correction'").get().digest,null);
    assert.equal(w.sent.filter(m=>m.reply_parameters?.message_id===original.message_id).length,1);
    await w.command(w.chat,'/forget');assert.equal(w.store.sql('SELECT count(*) n FROM reorg_checks').get().n,0);
  }finally{w.close()}
});

test('review 2 endpoint: failover away and back cannot confirm absence against another provider history',async()=>{
  const w=await passWorld();try{
    await w.command(w.chat,'/watch 0x20');w.add(2);w.tx('0xa',11);await w.pass();const original=w.sent.at(-1);
    const call=w.bot.rpc.call,pool=new RpcPool({rpcUrls:['http://a','http://b']},w.bot.signal);
    let switched=false;
    pool.clients=[{call:async(method,p)=>{
      if(method==='starknet_getBlockWithTxHashes'&&p.block_id?.block_number===11&&!switched){switched=true;throw new NodeBusy()}
      return call(method,p);
    }},{call:async(method,p)=>{
      if(method==='starknet_getBlockWithTxHashes'&&p.block_id?.block_number===10)throw new NodeBusy();
      return call(method,p);
    }}];
    w.bot.rpc=w.bot.network.rpc=w.bot.scanner.rpc=pool;
    w.reorg(10);await w.pass();
    assert.equal(pool.active,0);assert.equal(pool.generation,2);
    assert.equal(w.sent.filter(m=>m.reply_parameters?.message_id===original.message_id).length,0);
    await w.pass();await w.pass();
    assert.equal(w.sent.filter(m=>m.reply_parameters?.message_id===original.message_id).length,1);
  }finally{w.close()}
});

test('review 2 bound: unresolved checks expire silently after reorg depth blocks and retain original history',async()=>{
  const w=await passWorld({reorgDepth:2});try{
    await w.command(w.chat,'/watch 0x20');w.add();w.tx('0xa');await w.pass();const original=w.sent.at(-1),call=w.bot.rpc.call;
    w.bot.rpc.call=async(method,p)=>method==='starknet_getTransactionStatus'?{finality_status:'RECEIVED'}:call(method,p);
    w.reorg(10);await w.pass();
    const row=()=>w.store.sql("SELECT * FROM deliveries WHERE kind='alert'").get();
    assert.equal(w.store.sql('SELECT since_block FROM reorg_checks WHERE original_seq = ?').get(row().seq).since_block,11);
    w.add();await w.pass();assert.equal(w.store.sql('SELECT since_block FROM reorg_checks WHERE original_seq = ?').get(row().seq).since_block,11);
    w.restart();w.add();await w.pass(); // Expire at the bound before a not-found status can cause a correction.
    assert.equal(w.store.sql('SELECT * FROM reorg_checks WHERE original_seq = ?').get(row().seq),undefined);assert.equal(row().digest,null);assert.equal(row().state,'sent');assert.equal(row().message_id,original.message_id);
    await w.pass();assert.equal(w.sent.filter(m=>m.reply_parameters?.message_id===original.message_id).length,0);
  }finally{w.close()}
});

test('review 2 status failover: not-found from a new provider is deferred until its own head is read',async()=>{
  const w=await passWorld();try{
    await w.command(w.chat,'/watch 0x20');w.add();w.tx('0xa');await w.pass();const original=w.sent.at(-1);
    const call=w.bot.rpc.call,pool=new RpcPool({rpcUrls:['http://a','http://b']},w.bot.signal);
    pool.clients=[{call:async(method,p)=>{if(method==='starknet_getTransactionStatus')throw new NodeBusy();return call(method,p)}},{call}];
    w.bot.rpc=w.bot.network.rpc=w.bot.scanner.rpc=pool;
    w.reorg(10);await w.pass();assert.equal(pool.active,1);
    assert.equal(w.sent.filter(m=>m.reply_parameters?.message_id===original.message_id).length,0);
    await w.pass();await w.pass();
    assert.equal(w.sent.filter(m=>m.reply_parameters?.message_id===original.message_id).length,1);
  }finally{w.close()}
});

test('second review 1: edits run both guards without executing commands or other message handlers',async()=>{
  const w=await passWorld();try{
    const call=w.bot.tg.call;let requested;
    w.bot.tg.call=async(method,p)=>{if(method==='getUpdates')requested=p.allowed_updates;return call(method,p)};
    await w.bot.poll(0);assert.ok(requested.includes('edited_message'));
    await w.command(w.group,'Harmless text');
    let update=1000;
    const edit=async(text,extra={})=>w.bot.handle({update_id:++update,edited_message:{message_id:1,chat:w.group,from:{id:2},date:200000,text,...extra}});
    const phrase=words.slice(0,12).join(' ');
    for(const text of [phrase,'https://example.com/claim']){
      const n=w.deletes.length;await edit(text);assert.equal(w.deletes.length,n+1);assert.equal(w.deletes.at(-1).message_id,1);
      assert.ok(!w.sent.at(-1).text.includes(text));
    }
    const n=w.sent.length,d=w.deletes.length;
    w.bot.subs.chat(w.group);w.bot.subs.pause(w.group.id);
    await edit('Harmless again');await edit('/guard seed off');await edit('/watch 0x20');await edit('Ordinary edit',{migrate_to_chat_id:-3});
    assert.equal(w.sent.length,n);assert.equal(w.deletes.length,d);assert.equal(w.bot.guards.settings(-2).seed,1);
    assert.equal(w.bot.subs.watches(-2).length,0);assert.equal(w.bot.subs.isPaused(-2),true);
  }finally{w.close()}
});

test('second review 2: systemd ExecStart keeps CAIRN_DATA writable despite EnvironmentFile precedence',()=>{
  const unit=readFileSync(new URL('../deploy/cairn.service',import.meta.url),'utf8');
  const example=readFileSync(new URL('../.env.example',import.meta.url),'utf8');
  const assignments=text=>Object.fromEntries(text.split('\n').map(l=>/^([A-Z_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map(m=>[m[1],m[2]]));
  const values=Object.fromEntries([...unit.matchAll(/^Environment=(\w+)=(.*)$/gm)].map(m=>[m[1],m[2]]));
  Object.assign(values,assignments(example)); // systemd EnvironmentFile overrides Environment.
  const exec=/^ExecStart=(.*)$/m.exec(unit)[1].split(/\s+/);
  if(exec[0]==='/usr/bin/env')for(const arg of exec.slice(1)){const m=/^(\w+)=(.*)$/.exec(arg);if(!m)break;values[m[1]]=m[2]}
  const working=/^WorkingDirectory=(.*)$/m.exec(unit)[1];
  const data=values.CAIRN_DATA.startsWith('/')?values.CAIRN_DATA:`${working}/${values.CAIRN_DATA.replace(/^\.\//,'')}`;
  const writable=[...unit.matchAll(/^StateDirectory=(.*)$/gm)].flatMap(m=>m[1].split(/\s+/).map(d=>`/var/lib/${d}`));
  writable.push(...[...unit.matchAll(/^ReadWritePaths=(.*)$/gm)].flatMap(m=>m[1].split(/\s+/)));
  assert.ok(writable.some(path=>data===path||data.startsWith(`${path}/`)),`${data} must be writable with ProtectSystem=strict`);
});

test('second review 3: pending facts rebuild and completed or reverted tracks resume from L2 through L1',async()=>{
  for(const amount of [777n,0n]){
    const w=await passWorld();try{
      await w.command(w.chat,'/watch 0x20');w.add();const tx=w.tx('0xa',11,100n);
      w.bot.newPass();await w.bot.readHead();await w.bot.background(); // Save the old execution without sending it.
      const row=w.bot.ledger.pending()[0];assert.match(row.body,/100 STRK/);
      w.reorg(10);w.tx('0xa',11,amount);w.restart();await w.pass();await w.pass();
      const posts=w.sent.filter(m=>m.text.includes(tx.hash));assert.equal(posts.length,amount?1:0);
      if(amount){assert.match(posts[0].text,/777 STRK/);assert.doesNotMatch(posts[0].text,/100 STRK/)}
      assert.equal(w.sent.filter(m=>/Correction/.test(m.text)).length,0);
    }finally{w.close()}
  }
  for(const previous of ['REVERTED','ACCEPTED_ON_L1']){
    const w=await passWorld();try{
      let fee=10n**18n,execution=previous==='REVERTED'?'REVERTED':'SUCCEEDED',finality=previous==='REVERTED'?'ACCEPTED_ON_L2':'ACCEPTED_ON_L1';
      const call=w.bot.rpc.call;
      w.bot.rpc.call=async(method,p)=>{
        const result=await call(method,p);
        if(method==='starknet_getTransactionStatus')return {...result,finality_status:finality,execution_status:execution};
        if(method==='starknet_getTransactionReceipt')return {...result,execution_status:execution,actual_fee:{unit:'FRI',amount:`0x${fee.toString(16)}`}};
        return result;
      };
      await w.command(w.chat,'/track 0xa');w.add();w.tx('0xa');
      w.bot.newPass();await w.bot.readHead();await w.bot.background();assert.match(w.bot.ledger.pending()[0].body,/Fee: 1 STRK/);
      assert.equal(w.bot.subs.allTracks().length,0);
      w.reorg(10);w.tx('0xa');fee=25n*10n**17n;execution='SUCCEEDED';finality='ACCEPTED_ON_L2';w.restart();await w.pass();await w.pass();
      const posts=w.sent.filter(m=>/Accepted on L2/.test(m.text));assert.equal(posts.length,1);assert.match(posts[0].text,/Fee: 2.5 STRK/);
      assert.equal(w.bot.subs.allTracks()[0].stage,1);
      w.restart();finality='ACCEPTED_ON_L1';await w.pass();await w.pass();
      assert.equal(w.sent.filter(m=>/Accepted on L1/.test(m.text)).length,1);assert.equal(w.bot.subs.allTracks().length,0);
    }finally{w.close()}
  }
});

test('second review 4: one planner keeps individual corrections and notices inside the group budget',()=>{
  const individual=[{kind:'correction',seq:1},{kind:'network',seq:2}];
  const trades=[1,2,900000,4,5].map((amount,i)=>({kind:'trade',seq:i+3,block:1,tx_hash:`tx${i}`,digest:JSON.stringify({k:'trade',side:'buy',token:'STRK',symbol:'STRK',verified:true,decimals:0,amount:String(amount),cents:null})}));
  const rows=[trades[0],individual[0],...trades.slice(1),individual[1]];
  const result=plan(rows,'supergroup',0);
  assert.deepEqual(result.full,individual);assert.deepEqual(result.rest,trades);
  assert.equal(result.full.length+Number(result.rest.length>0),3);
  assert.match(summarise(result.rest,{tx:(tx,text)=>`${text} [${tx}]`}),/Largest: Buy 900,000 STRK.*tx2/);
  const next=plan(trades,'supergroup',0);assert.ok(next.full.includes(trades[2]));
  assert.deepEqual(plan(rows,'supergroup',2),{full:[individual[0]],rest:[]});
  assert.deepEqual(plan(rows,'supergroup',3),{full:[],rest:[]});
  assert.deepEqual(plan(rows,'private',0),{full:rows,rest:[]});
});

test('rewrite rule 1: lagging failover waits for matching hashes; only a real conflict corrects',async()=>{
  const w=await passWorld();try{
    await w.command(w.chat,'/watch 0x20');w.add(2);w.tx('0xa',12);await w.pass();const original=w.sent.at(-1),cursor=w.store.cursor,call=w.bot.rpc.call;
    let lagging=true;
    w.bot.rpc.call=async(method,p)=>{
      if(lagging&&method==='starknet_getBlockWithTxHashes'&&p.block_id==='latest')return call(method,{block_id:{block_number:11}});
      if(lagging&&['starknet_getTransactionReceipt','starknet_getTransactionStatus'].includes(method))throw new RpcError(29);
      return call(method,p);
    };
    const before=w.calls.length;await w.pass();await w.pass();
    assert.equal(w.store.cursor,cursor);assert.equal(w.sent.filter(m=>m.reply_parameters).length,0);
    assert.equal(w.store.sql('SELECT max(number) n FROM blocks').get().n,12);
    assert.ok(!w.calls.slice(before).some(([m])=>m==='starknet_getEvents'));
    assert.equal(w.bot.ledger.reorgRows('check').length,0);
    // A previous fork may already have rewound stored hashes while its checks are unresolved.
    w.store.sql('DELETE FROM blocks WHERE number = 12').run();
    w.bot.ledger.recheck(w.store.sql("SELECT * FROM deliveries WHERE kind='alert'").get(),12);
    await w.pass();assert.equal(w.sent.filter(m=>m.reply_parameters).length,0);
    assert.equal(w.bot.ledger.reorgRows('check').length,1);
    lagging=false;await w.pass();assert.equal(w.sent.at(-1),original);
    w.reorg(11);await w.pass();await w.pass();
    assert.equal(w.sent.filter(m=>m.reply_parameters?.message_id===original.message_id).length,1);
  }finally{w.close()}
});

test('rewrite rule 2: later-filter or enrichment failover rolls back the whole range and rescans one provider',async()=>{
  for(const switchAt of ['filter','enrichment']){
    const w=await passWorld();try{
      w.add();w.bot.rpc.generation=0;let provider='A',switched=false;
      const first={address:'first'},later={address:'later'},filterCalls=[];
      const rpcCall=w.bot.rpc.call;
      w.bot.rpc.call=async(method,p)=>{
        if(method==='starknet_getEvents'){
          filterCalls.push([provider,p.filter.address]);
          if(switchAt==='filter'&&p.filter.address==='later'&&!switched){switched=true;provider='B';w.bot.rpc.generation++}
          return {events:[{provider}]};
        }
        if(method==='starknet_call'){
          if(switchAt==='enrichment'&&!switched){switched=true;provider='B';w.bot.rpc.generation++}
          return [];
        }
        return rpcCall(method,p);
      };
      w.bot.feeds=[{filters:[first,later],wanted:()=>true,find:async(events,context)=>{
        const from=events.get(first)[0].provider;
        // Enrichment writes must roll back with the range as well as its delivery/cursor.
        w.store.set(`range_cache_${from}`,1);
        await context.rpc.call('starknet_call',{});
        const header=await context.header(11);
        return {deliveries:[{chatId:1,txHash:hex64('0xabc'),eventIndex:0,kind:'alert',block:11,chainTime:header.timestamp,body:`Facts from ${from}`,digest:{k:'alert'}}],seen:[]};
      }}];
      await w.pass();await w.pass();
      assert.equal(w.store.cursor,11);assert.equal(w.sent.length,1);assert.equal(w.sent[0].text,'Facts from B');
      assert.equal(w.store.get('range_cache_A'),null);assert.equal(w.store.get('range_cache_B'),'1');assert.equal(filterCalls.filter(([p,f])=>p==='B'&&f==='first').length,1);
      assert.equal(w.store.sql("SELECT count(*) n FROM deliveries WHERE kind='alert'").get().n,1);
    }finally{w.close()}
  }
});

test('third review 1: failed validation holds queued chain alerts across restart but sends network notices',async()=>{
  for(const failure of ['outage','history','lagging']){
    const w=await passWorld({operatorChat:1});try{
      await w.command(w.chat,'/watch 0x20');w.add();const tx=w.tx('0xa');
      w.bot.newPass();await w.bot.readHead();await w.bot.background();
      w.restart();w.add();const call=w.bot.rpc.call;
      w.bot.rpc.call=async(method,p)=>{
        if(method==='starknet_getBlockWithTxHashes'){
          if(failure==='outage'||(failure==='history'&&p.block_id!=='latest'))throw new NodeBusy();
          if(failure==='lagging'&&p.block_id==='latest')return call(method,{block_id:{block_number:10}});
        }
        return call(method,p);
      };
      if(failure!=='outage')w.bot.network.notice(`outage:${failure}`,'⚠️ Chain access is down.',null,[{chat_id:1}]);
      const before=w.sent.length;await w.pass();
      assert.equal(w.sent.length,before+1);assert.match(w.sent.at(-1).text,/Chain access is down/);
      assert.ok(w.bot.ledger.pending().some(r=>r.tx_hash===tx.hash));
      w.bot.rpc.call=call;await w.pass();await w.pass();
      assert.equal(w.sent.filter(m=>m.text.includes(tx.hash)).length,1);
    }finally{w.close()}
  }
  const rows=['alert','trade','track','correction','network'].map(kind=>({kind}));
  for(const type of ['private','supergroup'])assert.deepEqual(plan(rows,type,0,false),{full:[rows.at(-1)],rest:[]});
});

test('third review 2: compact trade bars distinguish sizes and preserve the whale within five short lines',async()=>{
  const {render}=await import('../src/trades.mjs');
  const token={address:hex64('0x1'),symbol:'STRK',decimals:0,verified:true},fmt=links({explorer:'https://x.example'},String);
  const bars=[];
  for(const dollars of [5n,500n,5000n,250000n]){
    const post={token,side:'buy',amount:1000n,others:[],value:{num:dollars,den:1n},trader:hex64('0x3'),block:{timestamp:100},venue:{name:'Ekubo'},tx:'0x4'};
    const lines=render(post,{},fmt).replace(/<[^>]+>/g,'').split('\n');
    assert.ok(lines.length<=5);assert.ok(lines.every(l=>Array.from(l).length<=32),lines.join('\n'));
    const bar=lines[0].split(' ')[0];assert.ok(Array.from(bar).length<=4);bars.push(bar);
  }
  assert.equal(new Set(bars).size,4);assert.match(bars.at(-1),/🐋/);
});

test('third review 3: successive forks preserve the first unresolved check expiry',async()=>{
  const w=await passWorld({reorgDepth:3});try{
    await w.command(w.chat,'/watch 0x20');w.add();w.tx('0xa');await w.pass();const original=w.sent.at(-1),call=w.bot.rpc.call;
    w.bot.rpc.call=async(method,p)=>method==='starknet_getTransactionStatus'?{finality_status:'RECEIVED'}:call(method,p);
    w.reorg(10);await w.pass();assert.equal(w.bot.ledger.reorgRows('check')[0].since_block,11);
    w.add();w.reorg(10);await w.pass();assert.equal(w.bot.ledger.reorgRows('check')[0].since_block,11);
    w.restart();w.add(2);await w.pass();
    assert.equal(w.bot.ledger.reorgRows('check').length,0);
    assert.equal(w.store.sql("SELECT message_id FROM deliveries WHERE kind='alert'").get().message_id,original.message_id);
    assert.equal(w.sent.filter(m=>m.reply_parameters).length,0);
  }finally{w.close()}
});

test('third review 4: paused pending correction retains its expired original and reply target until sent',async()=>{
  const w=await passWorld();try{
    await w.command(w.chat,'/watch 0x20');w.add();w.tx('0xa');await w.pass();const original=w.store.sql("SELECT * FROM deliveries WHERE kind='alert'").get();
    w.bot.ledger.correct(original,{block:11,chainTime:original.chain_time+86400,body:'↩️ Correction.'});
    w.bot.subs.pause(1);const now=original.chain_time+7*86400+1;w.bot.ledger.prune(now);
    assert.ok(w.store.sql('SELECT seq FROM deliveries WHERE seq=?').get(original.seq));
    w.restart();await w.pass();assert.equal(w.sent.filter(m=>m.reply_parameters).length,0);
    w.bot.subs.resume(1);await w.pass();await w.pass();
    const corrections=w.sent.filter(m=>m.reply_parameters);assert.equal(corrections.length,1);
    assert.deepEqual(corrections[0].reply_parameters,{message_id:original.message_id,allow_sending_without_reply:true});
    w.bot.ledger.prune(now);assert.equal(w.store.sql('SELECT seq FROM deliveries WHERE seq=?').get(original.seq),undefined);
  }finally{w.close()}
});

test('third review 5: network subscriptions persist independently of guards and forget clears both',async()=>{
  const w=await passWorld();try{
    await w.command(w.group,'/network on');assert.equal(w.bot.subs.networkOn(-2),true);
    assert.deepEqual(w.bot.guards.settings(-2),{seed:1,links:1});
    await w.command(w.group,'/guard links off');w.restart();
    assert.equal(w.bot.subs.networkOn(-2),true);assert.deepEqual({...w.bot.guards.settings(-2)},{seed:1,links:0});
    // Earlier round-4 files stored network subscriptions beside the guards: upgrade them once.
    w.store.db.exec('ALTER TABLE protection ADD COLUMN network INTEGER NOT NULL DEFAULT 0; UPDATE protection SET network = 1; DELETE FROM network_subscriptions');
    w.restart();assert.equal(w.bot.subs.networkOn(-2),true);assert.equal(w.bot.guards.settings(-2).links,0);
    assert.ok(!w.store.sql('PRAGMA table_info(protection)').all().some(c=>c.name==='network'));
    await w.command(w.group,'/network off');assert.equal(w.bot.subs.networkOn(-2),false);assert.equal(w.bot.guards.settings(-2).links,0);
    await w.command(w.group,'/network on');w.bot.subs.pause(-2);assert.equal(w.bot.subs.networkSubscribers().length,0);
    w.bot.subs.resume(-2);assert.deepEqual(w.bot.subs.networkSubscribers().map(r=>r.chat_id),[-2]);
    assert.throws(()=>w.bot.guards.set(w.group,'network',true),/Unknown setting/);
    w.restart();await w.command(w.group,'/forget');w.restart();
    assert.equal(w.bot.subs.networkOn(-2),false);assert.deepEqual(w.bot.guards.settings(-2),{seed:1,links:1});
    assert.equal(w.store.sql('SELECT count(*) n FROM protection').get().n,0);
  }finally{w.close()}
});

test('judge 3: network texts show last block, durations and one persisted operator recovery',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'cairn-texts-'));let store=new Store(directory);
  const config={stallSeconds:120,maxGap:50000,reorgDepth:4,confirmations:0,operatorChat:3};
  const head={block_number:4200010,block_hash:'0xa',timestamp:Date.UTC(2026,9,27,12,3)/1000};
  try{
    new Subscriptions(store,config).network({id:1,type:'private'},true);store.cursor=head.block_number;
    let ledger=new Ledger(store),network=new Network(config,store,{},ledger);
    await network.step(head,0);await network.step(head,120000);
    assert.match(ledger.pending()[0].body,/No new block for 2 min.*#4,200,010 at 12:03 UTC/);
    await network.step(null,200000);await network.step(null,210000);
    store.close();store=new Store(directory);ledger=new Ledger(store);network=new Network(config,store,{},ledger);
    await network.step({...head,block_hash:'0xb'},380000);
    const restored=()=>ledger.pending().filter(r=>r.chat_id===3&&/restored/.test(r.body));
    assert.equal(restored().length,1);assert.match(restored()[0].body,/restored after 3 min/);
    store.close();store=new Store(directory);ledger=new Ledger(store);network=new Network(config,store,{},ledger);
    await network.step({...head,block_hash:'0xb'},381000);assert.equal(restored().length,1);
  }finally{store.close()}
  const w=await passWorld();try{
    await w.command(w.chat,'/watch 0x20');w.add();w.tx('0xa');await w.pass();w.reorg(10);await w.pass();
    const correction=w.sent.find(m=>m.reply_parameters);assert.match(correction.text,/Correction:.*reorganisation.*ignore the alert/);assert.ok(!correction.text.includes('\n'));
  }finally{w.close()}
});

test('judge 4: RPC outage retains head metrics, outranks Telegram and logs unreachable endpoints',async()=>{
  const {Telegram}=await import('../src/transport.mjs'),{httpHandler}=await import('../src/http.mjs');
  const w=await passWorld({operatorChat:3}),fetchBefore=globalThis.fetch,write=process.stderr.write;let logs='';
  try{
    w.add();await w.pass();const head=w.head,call=w.bot.rpc.call;
    const tg=new Telegram({telegramRoot:'http://127.0.0.1',token:'fixture'},w.bot.signal);
    globalThis.fetch=async()=>new Response(JSON.stringify({ok:false,error_code:403,description:'Forbidden: bot cannot initiate conversation'}),{status:403});
    tg.healthy=false;assert.equal(await tg.call('sendMessage',{chat_id:3,text:'test'}),null);assert.equal(tg.healthy,true);
    w.bot.tg=tg;tg.healthy=false;
    w.bot.rpc.call=async()=>{throw new NodeBusy()};
    process.stderr.write=(chunk)=>{logs+=chunk;return true};
    const pool=new RpcPool({rpcUrls:['http://a','http://b']},w.bot.signal);pool.clients=[{call:async()=>{throw new NodeBusy()}},{call:async()=>11}];
    assert.equal(await pool.call('starknet_blockNumber'),11);assert.match(logs,/RPC endpoint 1 unreachable/);
    await w.bot.readHead();assert.equal(w.bot.snapshot().reason,'rpc');tg.healthy=true;
    await w.bot.background();await w.bot.deliver();assert.equal(tg.healthy,true);
    assert.equal(w.bot.snapshot().head,head);assert.equal(w.bot.snapshot().reason,'rpc');
    let body;httpHandler(()=>w.bot.snapshot())({method:'GET',url:'/metrics'},{writeHead(){},end(text){body=text}});
    assert.match(body,new RegExp(`cairn_head_block ${head}\\n`));assert.match(logs,/unreachable/i);assert.doesNotMatch(logs,/node busy/);
    w.restart();await w.bot.readHead();assert.equal(w.bot.snapshot().head,head);
    w.bot.rpc.call=call;
  }finally{globalThis.fetch=fetchBefore;process.stderr.write=write;w.close()}
});

test('judge 5: six-block trade catch-up sends two largest and one complete summary across restart',async()=>{
  const w=await passWorld({maxBlocks:1});try{
    w.bot.subs.chat(w.group);const filter={keys:[[SELECTORS.Transfer]]};
    const feeds=()=>[{filters:[filter],wanted:()=>true,find:async(events)=>({deliveries:events.get(filter).map(e=>{
      const amount=BigInt(e.data[0]);return {chatId:-2,txHash:e.transaction_hash,eventIndex:0,kind:'trade',block:e.block_number,chainTime:1000+e.block_number*2,
        body:`Buy ${Number(amount).toLocaleString('en-US')} STRK`,digest:{k:'trade',side:'buy',token:'STRK',symbol:'STRK',verified:true,decimals:0,amount:String(amount),cents:String(amount*100n)}};
    })})}];
    w.bot.feeds=feeds();
    for(let i=0;i<24;i++){if(i%4===0)w.add();w.tx(`0x${(100+i).toString(16)}`,w.head,i===23?900000n:i===22?800000n:BigInt(i+1))}
    for(let i=0;i<6;i++){
      w.bot.budget.start=-Infinity;await w.pass();
      if(i<5)assert.equal(w.sent.length,0);
      if(i===2){w.restart();w.bot.feeds=feeds()}
    }
    assert.equal(w.sent.length,3);assert.ok(w.sent.some(m=>m.text==='Buy 900,000 STRK'));assert.ok(w.sent.some(m=>m.text==='Buy 800,000 STRK'));
    const summaries=w.sent.filter(m=>/summaris/.test(m.text));assert.equal(summaries.length,1);assert.match(summaries[0].text,/22 more/);assert.match(summaries[0].text.replace(/<[^>]+>/g,''),/Largest: Buy 22 STRK/);
    assert.equal(w.store.sql("SELECT count(*) n FROM deliveries WHERE state='summarized'").get().n,22);
    await w.pass();assert.equal(w.sent.length,3);
    w.add();w.tx('0xffff',w.head,7n);w.bot.budget.start=-Infinity;await w.pass();assert.equal(w.sent.length,4);
  }finally{w.close()}
});

test('judge 6: extracted updates and delivery preserve topics, replies and named network stage',async()=>{
  const {deliver}=await import('../src/delivery.mjs'),{handle,context}=await import('../src/updates.mjs');
  const w=await passWorld();try{
    await handle(w.bot,{update_id:0,message:{message_id:7,chat:w.chat,text:'ordinary'}});assert.equal(context(w.bot,w.chat,null).head.block_number,10);
    await w.command(w.group,'/watch 0x20',{message_thread_id:17,is_topic_message:true});w.add();w.tx('0xa');
    await w.bot.readHead();await w.bot.background();const before=w.sent.length;await deliver(w.bot);
    assert.equal(w.sent.length,before+1);assert.equal(w.sent.at(-1).message_thread_id,17);
    const original=w.store.sql("SELECT * FROM deliveries WHERE kind='alert'").get();
    w.bot.ledger.correct(original,{block:w.head,chainTime:1022,body:'↩️ Correction.'});
    w.bot.network.notice('test:notice','⏸ No new block.',{timestamp:1022},[{chat_id:-2}]);
    assert.equal(w.store.sql("SELECT event_index FROM deliveries WHERE kind='network'").get().event_index,STAGE.network);
    await w.bot.deliver();assert.equal(w.sent.length,before+3);
    assert.deepEqual(w.sent.find(m=>m.reply_parameters).reply_parameters,{message_id:original.message_id,allow_sending_without_reply:true});
    await deliver(w.bot);assert.equal(w.sent.length,before+3);
  }finally{w.close()}
});

test('judge 7: logarithmic size tiers distinguish hundreds through whales for buys and sells',async()=>{
  const {sizeBar,render}=await import('../src/trades.mjs');
  const tiers=[1,1,2,3,4,0],sizes=[5n,50n,500n,5000n,50000n,250000n];
  for(const side of ['buy','sell'])for(const [i,usd]of sizes.entries()){
    const dot=side==='buy'?'🟢':'🔴',bar=sizeBar(side,usd*100n,1000n,null);
    assert.equal(bar,tiers[i]?dot.repeat(tiers[i]):`${dot}🐋`);
    const token={address:hex64('0x1'),symbol:'STRK',decimals:0,verified:true};
    const text=render({token,side,amount:1000n,others:[],value:{num:usd,den:1n},trader:hex64('0x3'),block:{timestamp:100},venue:{name:'Ekubo'},tx:'0x4'},{},links({explorer:'https://x.example'},String));
    const lines=text.replace(/<[^>]+>/g,'').split('\n');assert.ok(lines.length<=5);assert.ok(lines.every(l=>Array.from(l).length<=34));assert.ok(lines[0].startsWith(bar));
  }
});

test('judge 8: deployment guide explains operator id without tokens and keeps setup commands',()=>{
  const readme=readFileSync(new URL('../README.md',import.meta.url),'utf8');
  const section=readme.match(/## Find your operator chat id\n([\s\S]*?)(?=\n## )/)?.[1];assert.ok(section);
  for(const pattern of [/@userinfobot|t\.me\/userinfobot/,/\/start/,/CAIRN_OPERATOR_CHAT/,/never share.*token/i])assert.match(section,pattern);
  for(const pattern of [/docker build/,/docker run/,/systemctl enable --now/,/Delete messages/,/setprivacy/,/STARKNET_RPC_URLS/])assert.match(readme,pattern);
  assert.doesNotMatch(readme,/Eleven or thirteen words|Punctuation breaks a run/);
});

test('cubic v5 1',async()=>{
  const rows=Array.from({length:200000},(_,i)=>({kind:'alert',block:i+1,tx_hash:'tx',digest:null}));
  assert.match(summarise(rows,{tx:(_tx,label)=>label}),/in blocks 1–200000/);
  const w=await passWorld();try{
    w.bot.subs.chat(w.group);
    w.store.transaction(()=>{for(let i=1;i<=1005;i++)w.bot.ledger.add({chatId:-2,txHash:`tx${i}`,eventIndex:0,kind:'trade',block:10,chainTime:1020,
      body:`Buy ${i} STRK`,digest:{k:'trade',side:'buy',token:'STRK',symbol:'STRK',verified:true,decimals:0,amount:String(i),cents:String(i*100)}})});
    assert.equal(w.bot.ledger.pending().length,1000);
    await w.bot.deliver();assert.equal(w.sent.length,3);assert.ok(w.sent.some(m=>m.text==='Buy 1005 STRK'));
    const summaries=w.sent.filter(m=>/summaris/.test(m.text));assert.equal(summaries.length,1);assert.match(summaries[0].text,/1003 more/);
    assert.equal(w.store.sql("SELECT count(*) n FROM deliveries WHERE state='summarized'").get().n,1003);
    w.restart();await w.pass();assert.equal(w.sent.length,3);assert.equal(w.bot.ledger.pending().length,0);
  }finally{w.close()}
});

test('cubic v5 2',async()=>{
  const w=await passWorld();try{
    await w.command(w.chat,'/watch 0x20');w.add();w.tx('0xa');await w.pass();
    const original=w.store.sql("SELECT * FROM deliveries WHERE kind='alert'").get();
    w.bot.ledger.correct(original,{block:w.head,chainTime:original.chain_time,body:'↩️ Correction.'});
    w.bot.subs.pause(1);w.bot.ledger.prune(original.chain_time+8*86400);w.restart();await w.pass();
    assert.equal(w.sent.filter(m=>m.reply_parameters).length,0);
    assert.equal(w.store.sql("SELECT count(*) n FROM deliveries WHERE kind='correction' AND state='pending'").get().n,1);
    w.bot.subs.resume(1);await w.pass();await w.pass();
    const corrections=w.sent.filter(m=>m.reply_parameters);assert.equal(corrections.length,1);
    assert.deepEqual(corrections[0].reply_parameters,{message_id:original.message_id,allow_sending_without_reply:true});
  }finally{w.close()}
});

test('cubic v5 3',async()=>{
  const {TelegramRefused}=await import('../src/errors.mjs');
  const w=await passWorld();try{
    await w.command(w.group,'/network on',{message_thread_id:17,is_topic_message:true});w.restart();
    w.store.set('head_since',Date.now()-121000);await w.pass();
    const stall=w.sent.find(m=>/No new block for/.test(m.text));assert.equal(stall.message_thread_id,17);
    w.add();await w.pass();assert.equal(w.sent.find(m=>/Recovered after/.test(m.text)).message_thread_id,17);
    await w.command(w.group,'/network on',{message_thread_id:23,is_topic_message:true});
    const call=w.bot.tg.call,attempts=[];
    w.bot.tg.call=async(method,p)=>{
      if(method==='sendMessage'){attempts.push(p.message_thread_id);if(p.message_thread_id===23)throw new TelegramRefused(method,400,{description:'message thread not found'})}
      return call(method,p);
    };
    w.bot.budget.start=-Infinity;w.store.set('head_since',Date.now()-121000);await w.pass();
    assert.deepEqual(attempts,[23,undefined]);assert.equal(w.sent.at(-1).message_thread_id,undefined);
    w.store.db.exec('ALTER TABLE network_subscriptions DROP COLUMN thread_id');w.restart();
    assert.equal(w.bot.subs.networkOn(-2),true);assert.equal(w.bot.subs.networkSubscribers()[0].thread_id,null);
  }finally{w.close()}
});

test('judge v2 1',async()=>{
  const w=await passWorld();try{
    const topic={message_thread_id:17,is_topic_message:true};
    await w.command(w.group,'/network on',topic);await w.command(w.group,'/guard links off',topic);w.restart();await w.bot.readHead();
    await w.command(w.group,'/list',topic);
    assert.match(w.sent.at(-1).text,/📡 Network alerts: on \(this topic\)/);assert.match(w.sent.at(-1).text,/🛡 Guards: seed on · links off/);
    assert.doesNotMatch(w.sent.at(-1).text,/Nothing is set up/);assert.match(w.sent.at(-1).text,/No feed, watch or alert yet.*Start with \/feed/);
    await w.command(w.group,'/list',{message_thread_id:23,is_topic_message:true});assert.match(w.sent.at(-1).text,/on \(topic 17\)/);
    await w.command(w.group,'/network on');await w.command(w.group,'/list');assert.match(w.sent.at(-1).text,/Network alerts: on\n/);
    await w.command(w.group,'/forget');await w.command(w.group,'/watch 0x20');await w.command(w.group,'/list');
    assert.match(w.sent.at(-1).text,/Network alerts: off/);assert.match(w.sent.at(-1).text,/Guards: seed on · links on/);assert.match(w.sent.at(-1).text,/Watches/);
  }finally{w.close()}
});

test('judge v2 2',()=>{
  for(const [ms,expected]of [[45000,'45 s'],[120000,'2 min'],[252000,'4 min 12 s'],[5713000,'1 h 35 min'],[3600000,'1 h'],[2000,'2 s'],[0,'0 s']])assert.equal(duration(ms),expected);
});

test('cubic v6 1',async()=>{
  const w=await passWorld();try{
    await w.command(w.chat,'/watch 0x20');w.add(2);w.tx('0xa',12);await w.pass();const original=w.sent.at(-1),call=w.bot.rpc.call;
    w.bot.rpc.call=async(method,p)=>{
      if(method==='starknet_getBlockWithTxHashes'){
        if(p.block_id==='latest')return call(method,{block_id:{block_number:11}});
        assert.ok(p.block_id.block_number<=11,'shorter head must never read unavailable blocks');
      }
      return call(method,p);
    };
    const before={head:w.store.get('head_number'),hash:w.store.get('head_hash'),cursor:w.store.cursor,blocks:w.store.sql('SELECT * FROM blocks ORDER BY number').all(),messages:w.sent.length};
    await w.pass();assert.deepEqual({head:w.store.get('head_number'),hash:w.store.get('head_hash'),cursor:w.store.cursor,blocks:w.store.sql('SELECT * FROM blocks ORDER BY number').all(),messages:w.sent.length},before);
    w.reorg(10);const replacement=w.tx('0xb',11,777n);w.restart();await w.pass();
    assert.equal(w.store.get('head_number'),'11');assert.equal(w.store.cursor,11);
    assert.ok(w.store.sql('SELECT number FROM blocks').all().every(b=>b.number<=11));
    assert.equal(w.sent.filter(m=>m.reply_parameters?.message_id===original.message_id).length,1);
    assert.equal(w.sent.filter(m=>m.text.includes(replacement.hash)).length,1);
    w.restart();await w.pass();assert.equal(w.sent.filter(m=>m.reply_parameters?.message_id===original.message_id).length,1);
    assert.equal(w.sent.filter(m=>m.text.includes(replacement.hash)).length,1);
  }finally{w.close()}
});
