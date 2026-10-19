// Black-box Round 2 checks. Entry code runs only in child processes with a clean environment.
// Every scenario owns its fakes and data directory. No live credentials or chain access are used.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, lstatSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, harness } from './lib/harness.mjs';
import { ROOT, entry, input, workspace } from './lib/entry.mjs';
import { fakeTelegram, linksOf } from './fake-telegram.mjs';
import { fakeStarknet, erc20, SEL, feltOf, felt, hex64, u256, shortString, P } from './fake-starknet.mjs';

const { test, done } = harness();
const cli = entry('node', ['cairn.mjs']);
const ws = workspace(), live = new Set();
const DEADLINE = Date.now() + 280_000;
const TOKEN = '7700112233:check-TOKEN-MARKER-zz9Qx7Lw3Vb5Nt1Rp0';
const RPC_SECRET = 'ROUND2-RPC-SECRET-8b7c';
const ME = { id: 7700112233, is_bot: true, first_name: 'Cairn fixture', username: 'cairn_check_bot' };
const T0 = 1792454400, HEAD = 4_200_010;
const TRAP = fileURLToPath(new URL('./trap.mjs', import.meta.url));
const EXPLORER = 'https://scan.cairn-check.example';
const A = feltOf('round2 watched A'), B = feltOf('round2 watched B'), C = feltOf('round2 counterparty');
const makeToken = (symbol, decimals, layout = 'modern') => ({ symbol, decimals, layout, address: feltOf(`round2 token ${symbol}`) });
const TOKENS = [makeToken('STRK',18), makeToken('ETH',18), makeToken('USDC',6), makeToken('WBTC',8,'legacy'), makeToken('BIG',0), makeToken('SIX',0)];
const [STRK, ETH, USDC, WBTC, BIG, SIX] = TOKENS;
const OTHER = makeToken('OUTSIDE',6), SPOOF = { ...makeToken('fake USDC',6), symbol:'USDC' };
const BYTE = { ...makeToken('byte symbol',2), symbol:'<x>&USDCmorethan11' };
const E18 = 10n**18n;
const eq = (a,b) => { try { return BigInt(a) === BigInt(b); } catch { return false; } };
const norm = s => String(s).replace(/(\d),(?=\d)/g,'$1').replace(/\s+/g,' ').trim();
const amount = (m,n,symbol) => new RegExp(`(^|[^\\d.])${n.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s+${symbol}(?![A-Za-z0-9.])`).test(norm(m));
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function until(fn, why, ms=5000) { for (const end=Date.now()+ms; Date.now()<end;) { if (await fn()) return; await sleep(20); } throw new Error(why); }
process.on('exit',()=>{ for (const pid of live) try { process.kill(-pid,'SIGKILL'); } catch {} });
let worlds=0, users=9000, txs=0;
function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir,{withFileTypes:true}).flatMap(e=>{const p=join(dir,e.name);return e.isDirectory()?files(p):e.isFile()?[p]:[];});
}
const bytes = dir => files(dir).map(p=>readFileSync(p).toString('utf8')).join('\n');
function event(t,from,to,value,kind='Transfer',layout=t.layout) {
  const pair=u256(value).map(felt), a=felt(from),b=felt(to),sel=felt(SEL[kind]);
  return { from_address:felt(t.address), keys:layout==='legacy'?[sel]:[sel,a,b], data:layout==='legacy'?[a,b,...pair]:pair };
}
function transaction(w, events, {hash=feltOf(`round2 tx ${++txs}`),block=w.node.head.number,fee=9n,sender=A,finality='ACCEPTED_ON_L2',execution='SUCCEEDED',revert=''}={}) {
  const t={hash,block,fee,sender,finality,execution,revert,events}; w.node.tx(t); return t;
}
function advance(w,n=1) { for(let i=0;i<n;i++)w.node.addBlock(); }
function register(w,t,{balances=new Map([[A,123456789n],[B,42n]]),symbolWords,decimals=t.decimals}={}) {
  const c=erc20({symbol:t.symbol,decimals,layout:t.layout,balances});
  if (symbolWords) c.calls[SEL.symbol]=()=>symbolWords;
  w.node.contract(t.address,c);
}
async function world(env={}) {
  const id=++worlds, tg=await fakeTelegram({token:TOKEN,me:ME,t0:T0}).listen();
  const node=fakeStarknet({head:HEAD,t0:T0}); await node.listen(`/rpc/${RPC_SECRET}`);
  const data=join(ws.scratch,`data-${id}`), trap=join(ws.scratch,`trap-${id}.log`);
  const w={id,tg,node,data,trap,runs:[],people:[],children:[]};
  for (const t of [...TOKENS,OTHER,SPOOF])register(w,t);
  register(w,BYTE,{symbolWords:[0n,shortString(BYTE.symbol),BigInt(Buffer.byteLength(BYTE.symbol))]});
  w.env={TELEGRAM_BOT_TOKEN:TOKEN,TELEGRAM_API_ROOT:tg.url,STARKNET_RPC_URL:node.url,CAIRN_CHAIN:'SN_MAIN',
    CAIRN_NETWORK_FILE:input({chain:'SN_MAIN',tokens:TOKENS.map(t=>({symbol:t.symbol,decimals:t.decimals,address:hex64(t.address)}))},`network-${id}.json`),
    CAIRN_DATA:data,CAIRN_EXPLORER_URL:EXPLORER,CAIRN_POLL_MS:'100',CAIRN_TG_TIMEOUT:'1',CAIRN_RPC_RPS:'100',CAIRN_RPC_TIMEOUT_MS:'500',
    NODE_OPTIONS:`--import=${TRAP}`,CAIRN_TRAP_LOG:trap,...env};
  w.run=async(args=['tick'],extra={})=>{
    check(DEADLINE-Date.now()>1000,'Round 2 checks exhausted their 280-second budget');
    const r=await cli(args,{env:{...w.env,...extra},timeoutMs:Math.min(12000,DEADLINE-Date.now())});w.runs.push(r);return r;
  };
  w.tick=async(extra={})=>{
    const r=await w.run(['tick'],extra);check(r.code===0,`tick failed (${r.code ?? r.signal}): ${r.err.slice(-600)}`);
    check(r.out.trim().split('\n').length===1&&r.out.trim(),'tick must print one JSON line');
    const s=JSON.parse(r.out);check(Number.isInteger(s.alerts)&&s.alerts>=0&&Number.isInteger(s.cursor)&&s.cursor>=0,`tick needs alerts and cursor counts: ${r.out}`);return s;
  };
  w.dm=()=>{
    const uid=++users,u=tg.user(uid,`PRIVATE-NAME-${uid}`,{username:`PRIVATE-USER-${uid}`}),chat=tg.dm(u);
    w.people.push(u);return {u,chat};
  };
  w.say=(p,text,extra={})=>tg.say(p.chat,p.u,text,extra);
  w.text=p=>tg.to(p.chat.id).map(m=>m.text).join('\n');
  w.command=async(p,text,extra={})=>{const n=tg.to(p.chat.id).length;w.say(p,text,extra);await w.tick();return tg.to(p.chat.id).slice(n);};
  w.export=async(p)=>{
    const ms=await w.command(p,'/export'); let value;
    try { value=JSON.parse(ms.map(m=>m.text).join('')); } catch { throw new Error(`/export is not a JSON reply: ${ms.map(m=>m.text).join('').slice(0,300)}`); }
    check(value.chat_id===p.chat.id,'export must identify its chat');
    for(const k of ['watches','whales','minimums','tracks','muted'])check(value[k]!==undefined,`export missing ${k}`);
    return value;
  };
  w.alerts=(p,t)=>tg.to(p.chat.id).filter(m=>linksOf(m.html).some(u=>u===`${EXPLORER}/tx/${hex64(t.hash)}`||u===`${EXPLORER}/tx/${felt(t.hash)}`));
  w.start=()=>{
    const child=spawn(process.execPath,['cairn.mjs','run'],{cwd:ROOT,detached:true,env:{PATH:process.env.PATH,HOME:ws.home,TMPDIR:ws.scratch,LANG:'C.UTF-8',TZ:'UTC',...w.env},stdio:['ignore','pipe','pipe']});
    const rec={out:'',err:''};child.stdout.on('data',d=>rec.out+=d);child.stderr.on('data',d=>rec.err+=d);w.runs.push(rec);
    live.add(child.pid); const exited=new Promise(resolve=>child.once('close',()=>{live.delete(child.pid);resolve();}));
    const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};const s={child,kill,exited};w.children.push(s);return s;
  };
  return w;
}
function safety(w) {
  check(w.node.violations.length===0,`RPC violations: ${w.node.violations.join('; ')}`);
  check(w.tg.violations.length===0,`Telegram violations: ${w.tg.violations.join('; ')}`);
  const saved=bytes(w.data),logs=w.runs.map(r=>`${r.out}\n${r.err}`).join('\n');
  for(const secret of [TOKEN,TOKEN.split(':')[1],RPC_SECRET]){
    check(!saved.includes(secret)&&!logs.includes(secret),`a configured secret leaked to files or output`);
  }
  for (const u of w.people) for(const value of [u.first_name,u.username])check(!saved.includes(value),'a user name or username was persisted');
  check(!w.tg.requests.some(r=>r.body.includes(RPC_SECRET)),'RPC secret was sent to Telegram');
  check(!w.node.requests.some(r=>r.body.includes(TOKEN.split(':')[1])),'Telegram secret was sent to the node');
  if(existsSync(w.trap))for(const line of readFileSync(w.trap,'utf8').split('\n').filter(Boolean)){
    const x=JSON.parse(line);if(x.kind==='loaded')continue;
    check([`127.0.0.1:${w.tg.port}`,`127.0.0.1:${w.node.port}`].includes(x.dest),`unexpected network destination ${x.dest}`);
  }
}
async function scenario(fn,env={}) {
  const w=await world(env);
  try { await fn(w); safety(w); }
  finally {for(const s of w.children)s.kill();await Promise.all(w.children.map(s=>s.exited));await Promise.all([w.tg.close(),w.node.close()]);}
}
const watch=async(w,p,address=A,label='Vault')=>{
  const r=await w.command(p,`/watch ${hex64(address)} ${label}`);
  check(r.some(m=>m.text.trim()),'watch needs a response');
  const e=await w.export(p);check(e.watches.some(x=>eq(x.address,address)),`watch ${felt(address)} not stored`);
};
const assertOne=(w,p,t)=>{const ms=w.alerts(p,t);check(ms.length===1,`expected one alert for ${felt(t.hash)}, got ${ms.length}`);return ms[0];};
const absent=(w,p,t)=>check(w.alerts(p,t).length===0,`unexpected alert for ${felt(t.hash)}`);
const tests=[];
function spec(name,fn,env) { tests.push({name,fn,env}); }

spec('registers Round 2 commands, update types and tick counters',w=> (async()=>{
  const p=w.dm();await w.command(p,'/help');
  const names=['watch','unwatch','list','whale','unwhale','min','mute','unmute','track','export','forget'];
  const cmds=w.tg.callsOf('setMyCommands').flatMap(c=>c.params.commands.map(x=>x.command));
  for(const n of names){check(cmds.includes(n),`missing /${n} in command menu`);check(w.text(p).includes(`/${n}`),`help omits /${n}`);}
  const polls=w.tg.callsOf('getUpdates');for(const n of ['callback_query','my_chat_member'])check(polls.some(c=>c.params.allowed_updates?.includes(n)),`getUpdates excludes ${n}`);
})());

spec('watches survive restarts, escape labels and can be removed by address or label',async w=>{
  const p=w.dm(),label='<x>&Vault';await watch(w,p,A,label);await watch(w,p,B,'Spare');
  let e=await w.export(p);check(e.watches.length===2&&e.watches.some(x=>x.label===label),'watch labels were lost or altered');
  const list=await w.command(p,'/list');check(list.some(m=>m.text.includes(label)),'list must show the literal escaped label');
  await w.command(p,`/unwatch ${label}`);e=await w.export(p);check(e.watches.length===1&&eq(e.watches[0].address,B),'unwatch by label failed');
  await w.command(p,`/unwatch ${hex64(B)}`);check((await w.export(p)).watches.length===0,'unwatch by address failed');
});

spec('honours the configured watch cap without consuming slots on duplicates',async w=>{
  const p=w.dm();await watch(w,p,A);await watch(w,p,A);await watch(w,p,B);
  const r=await w.command(p,`/watch ${hex64(C)}`);check(r.some(m=>m.text.trim()),'watch cap refusal must include a reason');
  check((await w.export(p)).watches.length===2,'configured watch cap exceeded');
},{CAIRN_MAX_WATCHES:'2'});

spec('the default watch cap is 20 and labels longer than 32 characters are refused',async w=>{
  const p=w.dm();w.say(p,`/watch ${hex64(A)} ${'x'.repeat(33)}`);await w.tick();check((await w.export(p)).watches.length===0,'33-character label was accepted');
  for(let i=0;i<21;i++)w.say(p,`/watch ${hex64(feltOf(`cap ${i}`))} W${i}`);
  await w.tick();check((await w.export(p)).watches.length===20,'default watch cap must be 20');
});

spec('whale thresholds cap at five, update in place and validate exact decimal amounts',async w=>{
  const p=w.dm();for(const t of TOKENS.slice(0,5))w.say(p,`/whale ${t.symbol} 1`);await w.tick();
  let e=await w.export(p);check(e.whales.length===5,'five whale thresholds must be accepted');
  await w.command(p,'/whale SIX 1');check((await w.export(p)).whales.length===5,'sixth whale threshold was accepted');
  await w.command(p,'/whale USDC 2.000001');check((await w.export(p)).whales.length===5,'updating a threshold consumes another slot');
  const valid=JSON.stringify((await w.export(p)).whales);
  for(const value of ['-1','NaN','1e6','0.0000001',(1n<<256n).toString()]){
    const r=await w.command(p,`/whale USDC ${value}`);check(r.some(m=>m.text.trim()),`bad amount ${value} must have a refusal reason`);check(JSON.stringify((await w.export(p)).whales)===valid,`invalid amount ${value} changed the threshold`);
  }
  await w.command(p,'/unwhale ETH');check((await w.export(p)).whales.length===4,'unwhale failed');
});

spec('invalid addresses and track hashes leave subscriptions unchanged',async w=>{
  const p=w.dm();await watch(w,p,A);
  for(const v of ['0x0','0xzz',felt(P)]) for(const cmd of ['watch','track','mute']){
    const r=await w.command(p,`/${cmd} ${v}`);check(r.some(m=>m.text.trim()),`/${cmd} ${v} must be refused with a reason`);
  }
  const e=await w.export(p);check(e.watches.length===1&&e.tracks.length===0&&e.muted.length===0,'invalid input altered subscriptions');
});

spec('group settings require an administrator while list and Round 1 lookups remain public',async w=>{
  const owner=w.dm(),member=w.dm(),chat=w.tg.group(-1009001,'Fixture group');owner.chat=chat;member.chat=chat;
  w.tg.members.set(`${chat.id}:${owner.u.id}`,'administrator');await watch(w,owner,A);
  const commands=[`watch ${hex64(B)}`,`unwatch ${hex64(A)}`,'whale STRK 1','unwhale STRK','min STRK 1',`mute ${hex64(STRK.address)}`,`unmute ${hex64(STRK.address)}`,`track ${hex64(feltOf('private track'))}`,'export','forget'];
  for(const cmd of commands){const r=await w.command(member,`/${cmd}`);check(/admin/i.test(r.map(m=>m.text).join('')),`member /${cmd} needs an admin refusal`);}
  const list=await w.command(member,'/list');check(list.some(m=>m.text.includes('Vault')),'members cannot read /list');
  const balance=await w.command(member,`/balance ${hex64(A)}`);check(balance.some(m=>/STRK/.test(m.text)),'Round 1 balance was blocked for a member');
  const e=await w.export(owner);check(e.watches.length===1&&eq(e.watches[0].address,A)&&e.whales.length===0&&e.tracks.length===0&&e.muted.length===0,'a member changed group settings');
});

spec('creator and anonymous group administrators can configure watches',async w=>{
  const p=w.dm(),chat=w.tg.group(-1009002,'Anonymous admins');p.chat=chat;
  w.tg.members.set(`${chat.id}:${p.u.id}`,'creator');await watch(w,p,A);
  w.tg.members.set(`${chat.id}:${p.u.id}`,'member');await w.command(p,`/watch ${hex64(B)} Anonymous`,{sender_chat:chat});
  check((await w.command(p,'/list')).some(m=>m.text.includes('Anonymous')),'anonymous group administrator was refused');
  await w.command(p,`/watch ${hex64(C)} Forged`,{sender_chat:{...chat,id:-999}});
  check(!(await w.command(p,'/list')).some(m=>m.text.includes('Forged')),'unrelated sender_chat was treated as an administrator');
});

spec('rate limits use message.date, notify once and recover after 60 seconds',async w=>{
  const p=w.dm();for(let i=0;i<13;i++)w.say(p,'/list',{date:T0+i});await w.tick();
  const ms=w.tg.to(p.chat.id);check(ms.length===11,`10 responses and one slowdown notice expected, got ${ms.length}`);
  check(/slow|rate|60|limit|many|wait|pause/i.test(ms.at(-1).text),'missing slow-down explanation');
  const other=w.dm();check((await w.command(other,'/list',{date:T0+14})).length===1,'one user throttled a different user');
  check((await w.command(p,'/list',{date:T0+73})).length===1,'rate window did not expire using message.date');
});

spec('Remove callbacks are short, acknowledged and cannot be used from a different chat',async w=>{
  const p=w.dm(),q=w.dm();await watch(w,p,A);const listed=(await w.command(p,'/list')).find(m=>m.params.reply_markup?.inline_keyboard?.length);
  check(listed,'/list lacks Remove buttons');const b=listed.params.reply_markup.inline_keyboard.flat().find(b=>/remove/i.test(b.text));
  check(b&&Buffer.byteLength(b.callback_data)<=64&&!b.callback_data.includes(hex64(A)),'Remove callback must hold a short server id');
  w.tg.say(q.chat,q.u,'/list');await w.tick();
  const query=(id,person)=>({callback_query:{id,from:person.u,data:b.callback_data,message:{message_id:listed.message_id,chat:person.chat,date:T0+100}}});
  w.tg.push(query('wrong-chat',q));await w.tick();check((await w.export(p)).watches.length===1,'cross-chat callback removed a watch');
  w.tg.push(query('valid-remove',p));await w.tick();check((await w.export(p)).watches.length===0,'Remove callback did not remove its watch');
  for(const id of ['wrong-chat','valid-remove'])check(w.tg.callsOf('answerCallbackQuery').filter(c=>c.params.callback_query_id===id).length===1,`callback ${id} was not acknowledged exactly once`);
  check(w.tg.callsOf('editMessageText').some(c=>c.params.message_id===listed.message_id),'Remove must update the list message');
});

spec('group Remove callbacks recheck the clicking user administrator status',async w=>{
  const p=w.dm(),q=w.dm();p.chat=w.tg.group(-1009003,'Callback admins');q.chat=p.chat;
  w.tg.members.set(`${p.chat.id}:${p.u.id}`,'administrator');await watch(w,p,A);const listed=(await w.command(p,'/list')).find(m=>m.params.reply_markup?.inline_keyboard?.length);
  check(listed,'missing list buttons');const data=listed.params.reply_markup.inline_keyboard[0][0].callback_data;
  w.tg.push({callback_query:{id:'member-remove',from:q.u,data,message:{chat:p.chat,message_id:listed.message_id,date:T0+100}}});await w.tick();
  check((await w.export(p)).watches.length===1,'member bypassed admin checks with a callback');
  check(w.tg.callsOf('answerCallbackQuery').some(c=>c.params.callback_query_id==='member-remove'),'refused callback was not answered');
});

spec('private pasted addresses and hashes offer working Watch and Track buttons',async w=>{
  const p=w.dm(),t=transaction(w,[]);const rs=await w.command(p,hex64(A));const m=rs.find(m=>m.params.reply_markup?.inline_keyboard?.flat().some(b=>/watch/i.test(b.text)));
  check(m&&/STRK/.test(m.text),'pasted address lacks balance and Watch button');const data=m.params.reply_markup.inline_keyboard.flat().find(b=>/watch/i.test(b.text)).callback_data;
  w.tg.push({callback_query:{id:'paste-watch',from:p.u,data,message:{chat:p.chat,message_id:m.message_id,date:T0+100}}});await w.tick();check((await w.export(p)).watches.length===1,'Watch button did not subscribe');
  const tx=await w.command(p,hex64(t.hash));const tm=tx.find(m=>m.params.reply_markup?.inline_keyboard?.flat().some(b=>/track/i.test(b.text)));
  check(tm,'pasted hash lacks Track button');
  w.tg.push({callback_query:{id:'paste-track',from:p.u,data:tm.params.reply_markup.inline_keyboard.flat().find(b=>/track/i.test(b.text)).callback_data,message:{chat:p.chat,message_id:tm.message_id,date:T0+110}}});await w.tick();
  check(w.alerts(p,t).some(m=>/L2/.test(m.text)),'Track button did not produce transaction tracking');
});

spec('first startup and a newly created watch never backfill old events',async w=>{
  const p=w.dm();const old=transaction(w,[event(STRK,A,C,E18)]);await watch(w,p,A);absent(w,p,old);
  advance(w);const next=transaction(w,[event(STRK,A,C,2n*E18)]);await w.tick();assertOne(w,p,next);absent(w,p,old);
  advance(w);const before=transaction(w,[event(STRK,B,C,3n*E18)]);await watch(w,p,B);absent(w,p,before);
  advance(w);const after=transaction(w,[event(STRK,B,C,4n*E18)]);await w.tick();assertOne(w,p,after);
});

spec('one chain-wide filter pages all events and bounds each pass by CAIRN_MAX_BLOCKS',async w=>{
  const p=w.dm();await watch(w,p,A);advance(w,7);
  const ts=[];for(let i=0;i<12;i++)ts.push(transaction(w,[event(STRK,A,C,E18*BigInt(i+1))],{block:HEAD+1+i%3}));
  const start=w.node.callsOf('starknet_getEvents').length;
  await w.tick();await w.tick();await w.tick();
  for(const t of ts)assertOne(w,p,t);
  const calls=w.node.callsOf('starknet_getEvents').slice(start);check(calls.length>=5,'continuation pages were not consumed');
  const ranges=new Map();for(const c of calls){const f=c.params.filter;check(f.address===undefined,'scanner must not filter by token address');check(f.chunk_size===1000,'scanner chunk_size must be 1000');
    check(f.keys?.length===1&&f.keys[0]?.length===2&&f.keys[0].some(x=>eq(x,SEL.Transfer))&&f.keys[0].some(x=>eq(x,SEL.Approval)),'scanner must use one OR filter for Transfer and Approval');
    const from=f.from_block.block_number,to=f.to_block.block_number;check(to-from+1<=3,'scan exceeded CAIRN_MAX_BLOCKS');const key=`${from}:${to}`;const v=ranges.get(key)??[];v.push(f.continuation_token);ranges.set(key,v);
  }
  check([...ranges.values()].every(v=>v.filter(x=>x===undefined).length===1),'same range was scanned more than once outside pagination');
},{CAIRN_MAX_BLOCKS:'3'});

spec('the default catch-up limit is 500 blocks and later passes finish the backlog',async w=>{
  const p=w.dm();await watch(w,p,A);advance(w,503);const t=transaction(w,[event(STRK,A,C,E18)]);
  await w.tick();await w.tick();assertOne(w,p,t);
  const ranges=w.node.callsOf('starknet_getEvents').map(c=>c.params.filter);check(ranges.some(f=>f.from_block.block_number===HEAD+1&&f.to_block.block_number===HEAD+500),'default first range must contain 500 blocks');
  check(ranges.every(f=>f.to_block.block_number-f.from_block.block_number+1<=500),'default range exceeds 500 blocks');
});

spec('modern and legacy transfers aggregate by transaction with exact u256 amounts and directions',async w=>{
  const p=w.dm();await watch(w,p,A,'<x>&Vault');await watch(w,p,B,'Spare');advance(w);
  const huge=(1n<<128n)+7n,t=transaction(w,[event(STRK,A,B,125n*E18/100n),event(WBTC,C,A,2100000001n),event(BIG,B,C,huge)]);
  await w.tick();const m=assertOne(w,p,t);check(amount(m.text,'1.25','STRK')&&amount(m.text,'21.00000001','WBTC')&&amount(m.text,huge.toString(),'BIG'),'transfer amounts were rounded or decoded incorrectly');
  check(/between/i.test(m.text)&&/\bin\b/i.test(m.text)&&/\bout\b/i.test(m.text),'missing transfer directions');
  check(m.text.includes('<x>&Vault')&&m.text.includes('Spare'),'matching labels must be shown literally');
  check(m.text.includes(String(w.node.head.number))&&/2026-10-20/.test(m.text),'alert lacks block and UTC time');
  const links=linksOf(m.html);for(const a of [A,B,C])check(links.some(u=>u.endsWith(hex64(a))||u.endsWith(felt(a))),'alert lacks a counterparty link');
});

spec('identical events at different receipt indexes remain distinct and transactions stay in chain order',async w=>{
  const p=w.dm();await watch(w,p,A);advance(w);const ev=event(STRK,A,C,7n*E18);
  const first=transaction(w,[ev,{...ev}]),second=transaction(w,[event(STRK,C,A,8n*E18)]);await w.tick();
  const a=assertOne(w,p,first),b=assertOne(w,p,second);check((norm(a.text).match(/7 STRK/g)??[]).length===2,'identical events with distinct indexes were collapsed');
  check(w.tg.to(p.chat.id).indexOf(a)<w.tg.to(p.chat.id).indexOf(b),'transactions were delivered out of order');
  await w.tick();assertOne(w,p,first);assertOne(w,p,second);
});

spec('tokens outside the registry decode short strings and ByteArrays and are plainly unverified',async w=>{
  const p=w.dm();await watch(w,p,A);advance(w);const t=transaction(w,[event(OTHER,A,C,1234567n),event(SPOOF,C,A,2000000n),event(BYTE,A,C,123n)]);
  await w.tick();const m=assertOne(w,p,t);check(amount(m.text,'1.234567','OUTSIDE')&&amount(m.text,'2','USDC'),'unknown-token amounts incorrect');
  check((m.text.match(/unverified/gi)??[]).length>=3,'every unknown token must be identified as unverified');
  check(m.html.includes('<code>USDC</code>')&&m.text.includes(BYTE.symbol.slice(0,11)),'unknown symbols must be escaped, truncated and in code');
  check(!/<a\b[^>]*>\s*(USDC|OUTSIDE|&lt;x&gt;)/i.test(m.html),'an unverified symbol must never become a link');
  for(const tok of [OTHER,SPOOF,BYTE])check(linksOf(m.html).some(u=>u.endsWith(hex64(tok.address))||u.endsWith(felt(tok.address))),'unknown token contract link missing');
});

spec('invalid metadata and NFT-shaped events are ignored without hiding valid ERC-20 events',async w=>{
  const p=w.dm();await watch(w,p,A);const nft=makeToken('NFT',0),bad=makeToken('BAD',37),missing=makeToken('MISSING',0);
  w.node.contract(nft.address,{calls:{}});register(w,bad);
  advance(w);const t=transaction(w,[event(nft,A,C,5n,'Transfer','legacy'),event(bad,A,C,7n),event(missing,A,C,8n),
    {from_address:felt(OTHER.address),keys:[felt(SEL.Transfer),felt(A),felt(C),'0x1','0x0'],data:[]},event(STRK,A,C,9n*E18)]);
  await w.tick();const m=assertOne(w,p,t);check(amount(m.text,'9','STRK'),'valid ERC-20 transfer was lost');check(!/NFT|BAD|MISSING|OUTSIDE/.test(m.text),'invalid token or NFT was alerted');
});

spec('token metadata is cached across restarts and refreshed after seven days of chain time',async w=>{
  const p=w.dm();await watch(w,p,A);
  const metadata=()=>w.node.callsOf('starknet_call').filter(c=>eq(c.params.request.contract_address,OTHER.address)&&[SEL.symbol,SEL.decimals].some(s=>eq(s,c.params.request.entry_point_selector))).length;
  advance(w);const a=transaction(w,[event(OTHER,A,C,1000000n)]);await w.tick();assertOne(w,p,a);const before=metadata();check(before>=2,'metadata not read');
  advance(w);const b=transaction(w,[event(OTHER,A,C,2000000n)]);await w.tick();assertOne(w,p,b);check(metadata()===before,'metadata was not reused across restarts');
  w.node.head.timestamp+=604801;advance(w);w.node.head.timestamp+=604801;
  const c=transaction(w,[event(OTHER,A,C,3000000n)]);await w.tick();assertOne(w,p,c);check(metadata()>before,'metadata was not refreshed after seven chain days');
});

spec('zero transfers and the final STRK sequencer fee are suppressed but other transfers remain',async w=>{
  const p=w.dm();await watch(w,p,A);advance(w);
  const noise=transaction(w,[event(STRK,A,C,0n),event(STRK,A,w.node.sequencer,9n)],{fee:9n});
  const real=transaction(w,[event(STRK,A,w.node.sequencer,10n),event(STRK,A,C,2n*E18)],{fee:9n});
  const notSender=transaction(w,[event(STRK,A,w.node.sequencer,9n)],{fee:9n,sender:B});
  await w.tick();absent(w,p,noise);const m=assertOne(w,p,real);check(amount(m.text,'2','STRK')&&amount(m.text,'0.00000000000000001','STRK'),'non-fee transfers were incorrectly suppressed');assertOne(w,p,notSender);
});

spec('watch minimums and mutes are chat-local and unmute restores alerts',async w=>{
  const p=w.dm(),q=w.dm();await watch(w,p,A);await watch(w,q,A);await w.command(p,'/min STRK 2');
  advance(w);const small=transaction(w,[event(STRK,A,C,E18)]),edge=transaction(w,[event(STRK,A,C,2n*E18)]);await w.tick();absent(w,p,small);assertOne(w,q,small);assertOne(w,p,edge);
  await w.command(p,`/mute ${hex64(STRK.address)}`);advance(w);const muted=transaction(w,[event(STRK,A,C,3n*E18)]);await w.tick();absent(w,p,muted);assertOne(w,q,muted);
  await w.command(p,`/unmute ${hex64(STRK.address)}`);advance(w);const resumed=transaction(w,[event(STRK,A,C,4n*E18)]);await w.tick();assertOne(w,p,resumed);
});

spec('whales accept token addresses, include threshold equality and label mints and burns',async w=>{
  const p=w.dm();await w.command(p,`/whale ${hex64(OTHER.address)} 2`);check((await w.export(p)).whales.length===1,'whale token address was not accepted');advance(w);
  const low=transaction(w,[event(OTHER,C,B,1999999n)]),mint=transaction(w,[event(OTHER,0n,C,2000000n)]),burn=transaction(w,[event(OTHER,C,0n,3000000n)]);
  await w.tick();absent(w,p,low);check(/mint/i.test(assertOne(w,p,mint).text),'mint not labelled');check(/burn/i.test(assertOne(w,p,burn).text),'burn not labelled');
  await w.command(p,`/unwhale ${hex64(OTHER.address)}`);advance(w);const stopped=transaction(w,[event(OTHER,C,B,4000000n)]);await w.tick();absent(w,p,stopped);
});

spec('modern and legacy approvals show the owner, spender and unlimited boundary',async w=>{
  const p=w.dm();await watch(w,p,A);advance(w);const unlimited=(1n<<128n)-1n;
  const t=transaction(w,[event(OTHER,A,C,1234567n,'Approval'),event(WBTC,A,B,unlimited,'Approval','legacy'),event(OTHER,C,A,9n,'Approval')]);
  await w.tick();const m=assertOne(w,p,t);check(/approval/i.test(m.text)&&/spender/i.test(m.text)&&/unlimited/i.test(m.text)&&m.text.includes('1.234567'),'approval fields or unlimited boundary missing');
  check((m.text.match(/Approval/gi)??[]).length===2,'an approval where only the spender is watched must not alert');
});

spec('balance accepts any token and includes nonzero tokens seen after a watch began',async w=>{
  const p=w.dm();await watch(w,p,A);advance(w);transaction(w,[event(OTHER,C,A,1000000n)]);await w.tick();
  const one=await w.command(p,`/balance ${hex64(A)} ${hex64(OTHER.address)}`);check(amount(one.map(m=>m.text).join('\n'),'123.456789','OUTSIDE'),'explicit token balance is wrong');
  const all=await w.command(p,`/balance ${hex64(A)}`);check(amount(all.map(m=>m.text).join('\n'),'123.456789','OUTSIDE'),'seen unknown token is missing from watched wallet balance');
  const known=await w.command(p,`/balance ${hex64(A)} USDC`);check(amount(known.map(m=>m.text).join('\n'),'123.456789','USDC'),'symbol token balance is wrong');
});

spec('tracks emit L2 then L1 exactly once and report escaped reverts',async w=>{
  const p=w.dm(),t=transaction(w,[]);await w.command(p,`/track ${hex64(t.hash)}`);
  const stages=()=>w.alerts(p,t).filter(m=>/L[12]|revert/i.test(m.text));check(stages().filter(m=>/L2/.test(m.text)).length===1,'L2 accepted notification missing');
  check(stages()[0].text.includes('SUCCEEDED')&&/fee/i.test(stages()[0].text),'L2 notification lacks execution and fee');
  await w.tick();check(stages().length===1,'L2 stage repeated');w.node.tx({...t,finality:'ACCEPTED_ON_L1'});await w.tick();check(stages().length===2&&/L1/.test(stages()[1].text),'L1 stage missing or out of order');
  await w.tick();check(stages().length===2,'completed track repeated');
  const rev=transaction(w,[],{execution:'REVERTED',revert:'Bad <x>& reason'});await w.command(p,`/track ${hex64(rev.hash)}`);
  check(w.alerts(p,rev).some(m=>/revert/i.test(m.text)&&m.text.includes('Bad <x>& reason')),'revert reason was not escaped and shown');
});

spec('tracks cap at ten and unknown hashes expire at 600 seconds of chain time',async w=>{
  const p=w.dm(),hashes=Array.from({length:11},(_,i)=>feltOf(`unknown track ${i}`));for(const h of hashes)w.say(p,`/track ${hex64(h)}`);await w.tick();
  check((await w.export(p)).tracks.length===10,'track cap must be ten');
  w.node.head.timestamp+=599;await w.tick();check((await w.export(p)).tracks.length===10,'track expired before 600 seconds');
  w.node.head.timestamp+=1;await w.tick();check((await w.export(p)).tracks.length===0,'track did not expire at 600 seconds');
  check((w.text(p).match(/not found/gi)??[]).length===10,'each unknown track needs one not-found notification');
});

spec('export is complete and forget removes chat data without affecting other chats',async w=>{
  const p=w.dm(),q=w.dm();await watch(w,p,A,'ERASE-THIS-LABEL-792');await watch(w,q,B,'KEEP-THIS-LABEL');
  w.say(p,'/whale USDC 2');w.say(p,'/min STRK 1');w.say(p,`/mute ${hex64(OTHER.address)}`);w.say(p,`/track ${hex64(feltOf('forget track'))}`);await w.tick();
  const e=await w.export(p);check(e.watches.length===1&&e.whales.length===1&&Object.keys(e.minimums).length===1&&e.tracks.length===1&&e.muted.length===1,'export omitted a setting');
  await w.command(p,'/forget');check(!bytes(w.data).includes('ERASE-THIS-LABEL-792'),'forget left a private watch label in storage');
  const gone=await w.export(p);for(const k of ['watches','whales','minimums','tracks','muted'])check(Object.keys(gone[k]).length===0,`forget left ${k}`);
  check((await w.export(q)).watches.length===1,'forget erased another chat');
  advance(w);const a=transaction(w,[event(STRK,A,C,E18)]),b=transaction(w,[event(STRK,B,C,E18)]);await w.tick();absent(w,p,a);assertOne(w,q,b);
});

spec('Telegram migration moves subscriptions and retries the alert to the new chat id',async w=>{
  const p=w.dm();p.chat=w.tg.group(-1009010,'Old group');w.tg.members.set(`${p.chat.id}:${p.u.id}`,'administrator');await watch(w,p,A);
  const q={u:p.u,chat:w.tg.group(-1009011,'Migrated group')};w.tg.members.set(`${q.chat.id}:${q.u.id}`,'administrator');w.say(q,'/list');await w.tick();
  w.tg.fail('sendMessage',{chat:p.chat.id,code:400,description:'migrated',parameters:{migrate_to_chat_id:q.chat.id}});
  advance(w);const t=transaction(w,[event(STRK,A,C,E18)]);await w.tick();absent(w,p,t);assertOne(w,q,t);
  check((await w.export(q)).watches.some(x=>eq(x.address,A)),'migration lost subscriptions');advance(w);const next=transaction(w,[event(STRK,A,C,2n*E18)]);await w.tick();assertOne(w,q,next);absent(w,p,next);
});

spec('403 pauses a chat and a new message resumes its pending alerts',async w=>{
  const p=w.dm();await watch(w,p,A);w.tg.blocked.add(p.chat.id);advance(w);const t=transaction(w,[event(STRK,A,C,E18)]);await w.tick();absent(w,p,t);
  const attempts=w.tg.callsOf('sendMessage').filter(c=>c.params.chat_id===p.chat.id).length;await w.tick();check(w.tg.callsOf('sendMessage').filter(c=>c.params.chat_id===p.chat.id).length===attempts,'paused chat kept attempting sends');
  w.tg.blocked.delete(p.chat.id);await w.command(p,'/list');assertOne(w,p,t);await w.tick();assertOne(w,p,t);
});

spec('membership left or kicked pauses alerts until the bot is re-added',async w=>{
  const p=w.dm();await watch(w,p,A);w.tg.push({my_chat_member:{chat:p.chat,from:p.u,date:T0,new_chat_member:{user:ME,status:'kicked'}}});await w.tick();
  advance(w);const t=transaction(w,[event(STRK,A,C,E18)]);await w.tick();absent(w,p,t);
  w.tg.push({my_chat_member:{chat:p.chat,from:p.u,date:T0+10,new_chat_member:{user:ME,status:'member'}}});await w.tick();assertOne(w,p,t);
});

spec('a kill before Telegram acceptance retains pending alerts for restart',async w=>{
  const p=w.dm();await watch(w,p,A);advance(w);const t=transaction(w,[event(STRK,A,C,E18)]);
  let held=false,release;w.tg.holdSend=async()=>{held=true;await new Promise(r=>release=r);};const child=w.start();
  try {await until(()=>held,'bot never attempted the pending alert');child.kill();await child.exited;}
  finally {release?.();}
  absent(w,p,t);await w.tick();assertOne(w,p,t);await w.tick();assertOne(w,p,t);
});

spec('confirmed alerts survive a kill and restart without being sent again',async w=>{
  const p=w.dm();await watch(w,p,A);advance(w);const t=transaction(w,[event(STRK,A,C,E18)]);const s=await w.tick();assertOne(w,p,t);check(s.alerts>=1,'tick must count alert deliveries');
  // A later command is a black-box barrier: the previous tick returned, so confirmation was persisted.
  const child=w.start();await until(()=>w.tg.holding,'bot never reached polling barrier');child.kill();await child.exited;
  await w.tick();assertOne(w,p,t);advance(w);const next=transaction(w,[event(STRK,A,C,2n*E18)]);await w.tick();assertOne(w,p,next);assertOne(w,p,t);
});

spec('a failed continuation page preserves the cursor and retries the entire range',async w=>{
  const p=w.dm();await watch(w,p,A);advance(w);const ts=[];for(let i=0;i<8;i++)ts.push(transaction(w,[event(STRK,A,C,BigInt(i+1)*E18)]));
  w.node.fail({when:c=>c.method==='starknet_getEvents'&&c.params.filter?.continuation_token!==undefined,http:503,times:50});
  const s=await w.tick();check(s.cursor===HEAD,'failed paging advanced the durable cursor');for(const t of ts)absent(w,p,t);
  w.node.clearFailures();await w.tick();for(const t of ts)assertOne(w,p,t);await w.tick();for(const t of ts)assertOne(w,p,t);
});

spec('invalid continuation tokens restart safely without duplicating the earlier page',async w=>{
  const p=w.dm();await watch(w,p,A);advance(w);const ts=[];for(let i=0;i<8;i++)ts.push(transaction(w,[event(STRK,A,C,BigInt(i+1)*E18)]));
  w.node.fail({when:c=>c.method==='starknet_getEvents'&&c.params.filter?.continuation_token!==undefined,rpcError:{code:33,message:'Invalid continuation token'}});
  await w.tick();await w.tick();for(const t of ts)assertOne(w,p,t);
});

spec('Round 2 numeric configuration is validated before contacting either API',async w=>{
  const p=w.dm();await watch(w,p,A);
  for(const [key,value]of [['CAIRN_MAX_BLOCKS','0'],['CAIRN_MAX_BLOCKS','10001'],['CAIRN_MAX_BLOCKS','1.5'],['CAIRN_MAX_WATCHES','0'],['CAIRN_MAX_WATCHES','201'],['CAIRN_MAX_WATCHES','abc']]){
    const before=w.tg.requests.length+w.node.requests.length,r=await w.run(['tick'],{[key]:value});
    check(r.code===2&&r.out===''&&r.err.includes(key),`invalid ${key}=${value} must exit 2 with a reason`);check(w.tg.requests.length+w.node.requests.length===before,'invalid config contacted APIs');
  }
});

for (const t of tests) await test(t.name,()=>scenario(t.fn,t.env));
done();
