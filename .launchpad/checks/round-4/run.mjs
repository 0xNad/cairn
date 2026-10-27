// PRIVATE DRAFT: no acceptance claim until the actual round 3 winner and pinned proof.
import {spawn} from 'node:child_process';
import {readFileSync, readdirSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {harness, check} from './lib/harness.mjs';
import {entry, input, workspace, ROOT} from './lib/entry.mjs';
import {fakeTelegram, linksOf} from './fake-telegram.mjs';
import {fakeStarknet, erc20, felt, feltOf, hex64} from './fake-starknet.mjs';
import {ADDR, T0, transfer} from './fixtures.mjs';

const TOKEN='7700445566:DRAFT-TOKEN-MARKER-19xZ4s6R7m8N0q2Y', SECRET='R4-PRIVATE-RPC-8b712';
const EXPLORER='https://scan.cairn-check.example';
const TRAP=fileURLToPath(new URL('./trap.mjs',import.meta.url));
const WORDS='abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual'.split(' ');
const PHRASE=n=>WORDS.slice(0,n).join(' '); // Deliberately synthetic alphabetical fixture, never a wallet.
const ws=workspace(), cli=entry('node',['cairn.mjs']);
const specs=[], spec=(id,title,fn)=>specs.push({name:`R4-${id} ${title}`,fn});
const live=new Set();
let serial=0, uid=8000;
process.on('exit',()=>{for(const pid of live)try{process.kill(-pid,'SIGKILL')}catch{}});
const text=ms=>ms.map(m=>m.text).join('\n');
const nodeOutages=ms=>ms.filter(m=>{
 const recovered=/\brecover(?:ed|y|ing)?\b|\bresumed\b|\brestored\b|\breconnected\b|back online|\b(?:healthy|available|working|up) again\b/i.test(m.text);
 const negated=/\b(?:no|not|cannot|unable|failed)\b.{0,24}\b(?:recover\w*|restor\w*|resum\w*|connect\w*)/i.test(m.text);
 return !recovered||negated;
});
const files=d=>!existsSync(d)?[]:readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(d,e.name)):e.isFile()?[join(d,e.name)]:[]);
const correctionTo=(m,id)=>m.params.reply_parameters?.message_id===id||m.params.reply_to_message_id===id;
async function until(fn, label, timeout=4500){
 const deadline=Date.now()+timeout;
 for(;;){const value=await fn();if(value)return value;if(Date.now()>=deadline)throw Error(label);await sleep(30)}
}

async function world(extra={}){
 const id=++serial;
 const tg=await fakeTelegram({token:TOKEN,me:{id:7700445566,is_bot:true,first_name:'Fixture',username:'cairn_check_bot'},t0:T0}).listen();
 const node=await fakeStarknet({t0:T0}).listen(`/rpc/${SECRET}`);
 const w={tg,node,nodes:[node],data:join(ws.scratch,`r4-data-${id}`),runs:[],children:[],people:[],protected:[]};
 w.network={chain:'SN_MAIN',tokens:[{symbol:'STRK',address:felt(ADDR.token),decimals:0}]};
 node.contract(ADDR.token,erc20({symbol:'STRK',decimals:0}));
 w.env={TELEGRAM_BOT_TOKEN:TOKEN,TELEGRAM_API_ROOT:tg.url,STARKNET_RPC_URL:node.url,CAIRN_CHAIN:'SN_MAIN',CAIRN_DATA:w.data,CAIRN_EXPLORER_URL:EXPLORER,CAIRN_POLL_MS:'100',CAIRN_TG_TIMEOUT:'1',CAIRN_RPC_RPS:'100',CAIRN_RPC_TIMEOUT_MS:'200',NODE_OPTIONS:`--import=${TRAP}`,CAIRN_TRAP_LOG:join(ws.scratch,`r4-trap-${id}.log`),...extra};
 w.envFor=()=>({...w.env,CAIRN_NETWORK_FILE:input(w.network,`r4-network-${id}-${++serial}.json`)});
 w.run=async()=>{const r=await cli(['tick'],{env:w.envFor(),timeoutMs:18000});w.runs.push(r);return r};
 w.tick=async()=>{const r=await w.run();check(r.code===0,`tick ${r.code}: ${r.err.slice(-350)}`);return JSON.parse(r.out)};
 w.person=(group=false)=>{const u=tg.user(++uid,`PRIVATE-${uid}`,{username:`PRIVATE-USER-${uid}`}),chat=group?tg.group(-uid,'Fixture group'):tg.dm(u);w.people.push(u);if(group)tg.members.set(`${chat.id}:${u.id}`,'administrator');return {u,chat}};
 w.say=(p,body,extra={})=>tg.say(p.chat,p.u,body,{date:T0+200+(++serial)*61,...extra});
 w.command=async(p,body,extra={})=>{const n=tg.to(p.chat.id).length;w.say(p,body,extra);await w.tick();return tg.to(p.chat.id).slice(n)};
 w.networkOn=async p=>{const ms=await w.command(p,'/network on');check(ms.length&&!/unknown command|unavailable|not configured/i.test(text(ms)),'network command absent');return ms};
 w.tx=(events,opts={})=>{const t={hash:feltOf(`round4 transaction ${++serial}`),block:node.head.number,fee:1n,sender:ADDR.relayer,finality:'ACCEPTED_ON_L2',execution:'SUCCEEDED',events,...opts};node.tx(t);return t};
 w.alerts=(p,t)=>tg.to(p.chat.id).filter(m=>linksOf(m.html).some(l=>[`${EXPLORER}/tx/${felt(t.hash)}`,`${EXPLORER}/tx/${hex64(t.hash)}`].includes(l)));
 w.start=()=>{
  const c=spawn(process.execPath,['cairn.mjs','run'],{cwd:ROOT,detached:true,env:{PATH:process.env.PATH,HOME:ws.home,TMPDIR:ws.scratch,...w.envFor()},stdio:['ignore','pipe','pipe']});
  const kill=()=>{try{process.kill(-c.pid,'SIGKILL')}catch{}};
  const r={out:'',err:'',overflow:false};let captured=0;
  const capture=(key,d)=>{captured+=d.length;if(captured>1024*1024){r.overflow=true;kill();return}r[key]+=d};
  c.stdout.on('data',d=>capture('out',d));c.stderr.on('data',d=>capture('err',d));w.runs.push(r);live.add(c.pid);
  const exited=new Promise(resolve=>c.on('close',()=>{live.delete(c.pid);resolve()}));
  const child={c,r,kill,exited};w.children.push(child);return child;
 };
 w.http=async(host='127.0.0.1')=>{
  w.env.CAIRN_HTTP_PORT='0';w.env.CAIRN_HTTP_HOST=host;const child=w.start();
  const port=await until(()=>{
   for(const line of (child.r.out+'\n'+child.r.err).split('\n'))try{const j=JSON.parse(line);if(j.event==='http'&&Number.isInteger(j.port)&&j.port>0)return j.port}catch{}
  },'HTTP port-0 announcement absent');
  const url=`http://${host}:${port}`;
  const request=async(path,method='GET')=>{const r=await fetch(url+path,{method,signal:AbortSignal.timeout(2000)});return {status:r.status,body:await r.text(),headers:r.headers}};
  await until(async()=>{try{return (await request('/healthz')).status===200}catch{return false}},'HTTP never became healthy');
  return {child,url,request};
 };
 w.watch=async p=>{await w.command(p,`/watch ${felt(ADDR.trader)}`)};
 w.sentTransfer=async p=>{await w.watch(p);node.addBlock();const t=w.tx([transfer(ADDR.other,ADDR.trader,100n)]);await w.tick();const ms=w.alerts(p,t);check(ms.length===1,'initial transfer absent or duplicated');return {t,message:ms[0]}};
 w.second=async options=>{const n=await fakeStarknet({t0:T0,...options}).listen(`/fallback/${SECRET}`);n.contract(ADDR.token,erc20({symbol:'STRK',decimals:0}));w.nodes.push(n);return n};
 w.guardMessage=async(p,body)=>{const n=tg.callsOf('deleteMessage').length,m=tg.to(p.chat.id).length;const update=w.say(p,body);await w.tick();const deleted=tg.callsOf('deleteMessage').slice(n).filter(c=>c.params.chat_id===p.chat.id&&c.params.message_id===update.message.message_id);return {deleted,messages:tg.to(p.chat.id).slice(m),update}};
 w.seed=async(p,n=12)=>{const body=PHRASE(n);w.protected.push(body);return w.guardMessage(p,body)};
 w.seedPositive=async p=>{const r=await w.seed(p);check(r.deleted.some(c=>c.status===200)&&r.messages.length,'seed guard absent');check(!text(r.messages).includes(PHRASE(12)),'guard repeated protected phrase');return r};
 return w;
}

function safety(w){
 check(!w.runs.some(r=>r.overflow),'background entry exceeded bounded output');
 for(const n of w.nodes)check(!n.violations.length,`RPC violation ${n.violations}`);
 check(!w.tg.violations.length,`Telegram violation ${w.tg.violations}`);
 const saved=files(w.data).map(p=>readFileSync(p).toString()).join('\n'),logs=w.runs.map(r=>r.out+r.err).join('\n');
 for(const marker of [TOKEN,TOKEN.split(':')[1],SECRET,...w.protected])check(!saved.includes(marker)&&!logs.includes(marker),'secret/protected input persisted or logged');
 for(const person of w.people)for(const marker of [person.first_name,person.username])check(!saved.includes(marker),'fixture identity persisted');
 const allowed=new Set([`127.0.0.1:${w.tg.port}`,...w.nodes.map(n=>`127.0.0.1:${n.port}`)]);
 if(existsSync(w.env.CAIRN_TRAP_LOG))for(const line of readFileSync(w.env.CAIRN_TRAP_LOG,'utf8').split('\n').filter(Boolean)){const x=JSON.parse(line);if(x.kind!=='loaded'){const bindLookup=x.kind.startsWith('dns.')&&w.env.CAIRN_HTTP_PORT!==undefined&&x.dest===w.env.CAIRN_HTTP_HOST;check(bindLookup||allowed.has(x.dest),'unconfigured outbound host')}}
}

spec('01','network subscription persists and group controls require administrators',async w=>{
 w.env.CAIRN_STALL_SECONDS='2';const p=w.person(true);await w.networkOn(p);
 await sleep(2150);let before=w.tg.to(p.chat.id).length;await w.tick();check(/stall|no new block/i.test(text(w.tg.to(p.chat.id).slice(before))),'subscription did not persist across processes');
 w.tg.members.set(`${p.chat.id}:${p.u.id}`,'member');check(/admin/i.test(text(await w.command(p,'/network off'))),'member changed network setting');
 before=w.tg.to(p.chat.id).length;w.node.addBlock();await w.tick();check(/recover|resum|back|block.*again/i.test(text(w.tg.to(p.chat.id).slice(before))),'member disabled subscription');
 await w.command(p,'/network off',{sender_chat:p.chat});before=w.tg.to(p.chat.id).length;await sleep(2150);await w.tick();check(w.tg.to(p.chat.id).length===before,'anonymous administrator could not disable');
});
spec('02','stall boundary uses wall time and not historical chain timestamps',async w=>{
 w.env.CAIRN_STALL_SECONDS='2';const p=w.person();await w.networkOn(p);const start=w.tg.to(p.chat.id).length;
 await sleep(1000);await w.tick();check(w.tg.to(p.chat.id).length===start,'early stall or chain timestamp used as wall time');
 await sleep(1200);await w.tick();check(w.tg.to(p.chat.id).length===start+1,'stall threshold not observed once');await w.tick();check(w.tg.to(p.chat.id).length===start+1,'same stall repeated');
});
spec('03','recovery reports duration and resets the next-outage latch',async w=>{
 w.env.CAIRN_STALL_SECONDS='2';const p=w.person();await w.networkOn(p);await sleep(2200);await w.tick();const start=w.tg.to(p.chat.id).length;
 w.node.addBlock();await w.tick();let ms=w.tg.to(p.chat.id).slice(start);check(ms.length===1&&/recover|resum|back|again/i.test(text(ms))&&/\b(?:[2-9]|\d{2,})(?:\.\d+)?\s*(?:s\b|sec)/i.test(text(ms)),'recovery/duration absent');
 await w.tick();check(w.tg.to(p.chat.id).length===start+1,'recovery repeated');await sleep(2200);await w.tick();check(w.tg.to(p.chat.id).length===start+2,'next stall latch never reset');
});
spec('04','all-endpoint outages notify only the operator once per outage',async w=>{
 w.env.CAIRN_STALL_SECONDS='99';const other=await w.second();w.env.STARKNET_RPC_URLS=`${w.node.url},${other.url}`;
 const a=w.person(),b=w.person(),op=w.person();w.env.CAIRN_OPERATOR_CHAT=String(op.chat.id);await w.networkOn(a);await w.networkOn(b);await w.command(op,'/status');
 const opStart=w.tg.to(op.chat.id).length,aStart=w.tg.to(a.chat.id).length,bStart=w.tg.to(b.chat.id).length;w.start();w.say(a,'/status');await until(()=>w.tg.to(a.chat.id).length>aStart,'run startup barrier absent');const aAfter=w.tg.to(a.chat.id).length;
 const outages=()=>nodeOutages(w.tg.to(op.chat.id).slice(opStart));
 for(const n of w.nodes)n.down(30000);await until(()=>outages().length,'operator outage notice absent',9000);await sleep(2200);
 check(outages().length===1,'outage repeated');check(w.tg.to(a.chat.id).length===aAfter&&w.tg.to(b.chat.id).length===bStart,'node outage broadcast to subscribers');
 for(const n of w.nodes){n.down(0);n.addBlock()}w.say(a,'/status');await until(()=>w.tg.to(a.chat.id).length>aAfter,'RPC recovery barrier absent',9000);const next=outages().length;
 for(const n of w.nodes)n.down(30000);await until(()=>outages().length>next,'second outage latch never reset',9000);check(outages().length===next+1,'second outage repeated');
});
spec('06','fork walks to the common ancestor and scans replacement events',async w=>{
 const p=w.person();const {t}=await w.sentTransfer(p);w.node.addBlock();await w.tick();w.node.reorgAfter(t.block-1);const fresh=w.tx([transfer(ADDR.other,ADDR.trader,200n)],{block:t.block});const before=w.node.calls.length;await w.tick();
 check(w.alerts(p,fresh).length===1,'replacement transfer skipped');check(w.node.calls.slice(before).some(c=>c.method==='starknet_getEvents'&&c.params.filter.from_block.block_number<=t.block),'replacement range not rescanned');
});
spec('07','orphaned alert gets one correction replying to its original message',async w=>{
 const p=w.person();const {t,message}=await w.sentTransfer(p);w.node.reorgAfter(t.block-1);const start=w.tg.to(p.chat.id).length;await w.tick();const ms=w.tg.to(p.chat.id).slice(start);
 check(ms.filter(m=>correctionTo(m,message.message_id)).length===1,'orphan correction missing or not a reply');await w.tick();check(w.tg.to(p.chat.id).length===start+ms.length,'correction replayed');
});
spec('08','re-included transaction has neither duplicate alert nor false correction',async w=>{
 const p=w.person();const {t,message}=await w.sentTransfer(p);w.node.addBlock();await w.tick();w.node.reorgAfter(t.block-1);w.node.tx({...t,block:t.block+1});const start=w.tg.to(p.chat.id).length;await w.tick();
 check(w.alerts(p,t).length===1&&!w.tg.to(p.chat.id).slice(start).some(m=>correctionTo(m,message.message_id)),'re-inclusion duplicated or corrected');
 // A real orphan in the same test makes this a positive R4 check, not silence-only.
 w.node.addBlock();const fresh=w.tx([transfer(ADDR.other,ADDR.trader,20n)]);await w.tick();const alert=w.alerts(p,fresh)[0];check(alert,'second alert missing');w.node.reorgAfter(fresh.block-1);await w.tick();check(w.tg.to(p.chat.id).some(m=>correctionTo(m,alert.message_id)),'no actual reorg handling');
});
spec('09','replacement transactions are delivered exactly once in chain order',async w=>{
 const p=w.person();const {t}=await w.sentTransfer(p);w.node.reorgAfter(t.block-1);const a=w.tx([transfer(ADDR.other,ADDR.trader,21n)]),b=w.tx([transfer(ADDR.other,ADDR.trader,22n)]);await w.tick();
 const am=w.alerts(p,a),bm=w.alerts(p,b);check(am.length===1&&bm.length===1&&am[0].message_id<bm[0].message_id,'replacement order/loss/duplication');await w.tick();check(w.alerts(p,a).length===1&&w.alerts(p,b).length===1,'replacement replayed');
});
spec('10','corrections and replacement alerts remain deduplicated after restart',async w=>{
 const p=w.person();const {t,message}=await w.sentTransfer(p);w.node.reorgAfter(t.block-1);const fresh=w.tx([transfer(ADDR.other,ADDR.trader,25n)]);await w.tick();check(w.tg.to(p.chat.id).some(m=>correctionTo(m,message.message_id))&&w.alerts(p,fresh).length===1,'reorg results absent');
 const start=w.tg.to(p.chat.id).length;await w.tick();await w.tick();check(w.tg.to(p.chat.id).length===start,'restart replayed correction or replacement');
 // A later fork must not replay an already-sent correction, even after fresh processes.
 w.node.reorgAfter(t.block-1,'second fork');await w.tick();check(w.tg.to(p.chat.id).filter(m=>correctionTo(m,message.message_id)).length===1,'persisted orphan correction replayed on a later fork');
});
spec('11','configured reorg depth bounds historical validation',async w=>{
 w.env.CAIRN_REORG_DEPTH='2';const p=w.person();const {t}=await w.sentTransfer(p);w.node.reorgAfter(t.block-1);const fresh=w.tx([transfer(ADDR.other,ADDR.trader,20n)]);await w.tick();check(w.alerts(p,fresh).length===1,'within-depth recovery positive control absent');const ancestor=w.node.head.number;
 for(let i=0;i<4;i++){w.node.addBlock();await w.tick()}w.node.reorgAfter(ancestor);const before=w.node.calls.length;await w.run();
 const lookedUp=w.node.calls.slice(before).filter(c=>c.method==='starknet_getBlockWithTxHashes'&&Number.isInteger(c.params.block_id?.block_number));check(lookedUp.length&&lookedUp.every(c=>c.params.block_id.block_number>=w.node.head.number-2),'unbounded history walk-back');
 // The frozen contract specifies retained depth, not exact wording or an exit code
 // when an older common ancestor is unavailable. Review that policy for operability.
});
spec('12','confirmation depth defers transfers until their block is safe',async w=>{
 w.env.CAIRN_CONFIRMATIONS='2';const p=w.person();await w.watch(p);w.node.addBlock();const t=w.tx([transfer(ADDR.other,ADDR.trader,100n)]);let j=await w.tick();check(!w.alerts(p,t).length&&j.cursor<=w.node.head.number-2,'unconfirmed transfer posted');
 w.node.addBlock();await w.tick();check(!w.alerts(p,t).length,'one-deep transfer posted');w.node.addBlock();await w.tick();check(w.alerts(p,t).length===1,'confirmed transfer lost');
});
spec('13','gap threshold includes equality and skips a longer gap only once',async w=>{
 w.env.CAIRN_MAX_GAP='3';const p=w.person();await w.networkOn(p);await w.watch(p);
 for(const n of [2,3]){for(let i=0;i<n;i++)w.node.addBlock();const t=w.tx([transfer(ADDR.other,ADDR.trader,100n)]);await w.tick();check(w.alerts(p,t).length===1,`gap ${n} skipped prematurely`)}
 for(let i=0;i<4;i++)w.node.addBlock();const skipped=w.tx([transfer(ADDR.other,ADDR.trader,100n)]),start=w.tg.to(p.chat.id).length;const j=await w.tick();const ms=w.tg.to(p.chat.id).slice(start);check(j.cursor===w.node.head.number&&!w.alerts(p,skipped).length&&ms.length===1&&/gap|skip|behind|catch/i.test(text(ms)),'long gap not skipped with one notice');
 await w.tick();check(w.tg.to(p.chat.id).length===start+1,'gap notice repeated');w.node.addBlock();const fresh=w.tx([transfer(ADDR.other,ADDR.trader,100n)]);await w.tick();check(w.alerts(p,fresh).length===1,'post-gap scanner did not resume');
});
spec('14','dead primary fails over to a healthy same-chain endpoint',async w=>{
 const secondary=await w.second();w.env.STARKNET_RPC_URLS=`${w.node.url},${secondary.url}`;w.node.fail({when:()=>true,http:503,times:10000});const p=w.person();const ms=await w.command(p,'/status');
 check(ms.length&&secondary.callsOf('starknet_chainId').length&&/SN_MAIN|mainnet/i.test(text(ms)),'healthy failover endpoint unused');
});
spec('15','mixed-chain failover configuration exits 2 with a chain reason',async w=>{
 const secondary=await w.second({chainId:'0x534e5f5345504f4c4941'});w.env.STARKNET_RPC_URLS=`${w.node.url},${secondary.url}`;const r=await w.run();check(r.code===2&&/chain/i.test(r.err)&&r.out==='','mixed chains accepted or reason absent');
});
spec('16','mid-page failover restarts without reusing endpoint-specific tokens',async w=>{
 const other=await w.second();w.env.STARKNET_RPC_URLS=`${w.node.url},${other.url}`;const p=w.person();await w.watch(p);for(const n of w.nodes)n.addBlock();const ts=[];
 for(let i=0;i<8;i++){const t=w.tx([transfer(ADDR.other,ADDR.trader,10n+BigInt(i))]);other.tx(t);ts.push(t)}
 w.node.fail({when:({method,params})=>method==='starknet_getEvents'&&Boolean(params.filter?.continuation_token),http:503,times:10000});const start=other.calls.length;await w.tick();for(const t of ts)check(w.alerts(p,t).length===1,'failover page lost or duplicated a transaction');
 const calls=other.calls.slice(start).filter(c=>c.method==='starknet_getEvents');check(calls.length>=2&&!calls[0].params.filter.continuation_token,'secondary did not start from first page');check(calls.every(c=>!String(c.params.filter.continuation_token??'').startsWith(`ct-${w.node.port}-`)),'foreign endpoint continuation token reused');
});
spec('17','health endpoint reports a healthy head and lag',async w=>{
 const {request}=await w.http();const r=await request('/healthz');const j=JSON.parse(r.body);check(r.status===200&&j.ok===true&&j.head===w.node.head.number&&Number.isFinite(j.lag_s)&&j.lag_s>=0,'invalid health response');
});
spec('18a','stalled health responds 503 with the stalled reason',async w=>{
 w.env.CAIRN_STALL_SECONDS='2';const {request}=await w.http();await sleep(2200);await until(async()=>{const r=await request('/healthz');const j=JSON.parse(r.body);return r.status===503&&j.ok===false&&j.reason==='stalled'},'stalled health not exposed');
 w.node.addBlock();await until(async()=>{const r=await request('/healthz');return r.status===200&&JSON.parse(r.body).ok===true},'health did not recover');
});
spec('18b','RPC failure health responds 503 with the rpc reason',async w=>{
 w.env.CAIRN_STALL_SECONDS='99';const {request}=await w.http();w.node.down(12000);await until(async()=>{const r=await request('/healthz');const j=JSON.parse(r.body);return r.status===503&&j.ok===false&&j.reason==='rpc'},'RPC health not exposed',9000);
});
spec('18c','Telegram failure health responds 503 with the telegram reason',async w=>{
 w.env.CAIRN_STALL_SECONDS='99';const {request}=await w.http();w.tg.fail('getUpdates',{code:503,description:'Service Unavailable',times:10000});await until(async()=>{const r=await request('/healthz');const j=JSON.parse(r.body);return r.status===503&&j.ok===false&&j.reason==='telegram'},'Telegram health not exposed',9000);
});
spec('19','HTTP port zero binds explicitly and only declared GET routes exist',async w=>{
 const {request,child}=await w.http('127.0.0.2');check((await request('/metrics')).status===200,'metrics route absent');
 for(const [path,method]of [['/','GET'],['/healthz/private','GET'],['/healthz','POST'],['/metrics','POST']])check([404,405].includes((await request(path,method)).status),'undeclared HTTP route/method served');
 child.kill();await child.exited;delete w.env.CAIRN_HTTP_PORT;const quiet=w.start(),p=w.person();w.say(p,'/status');await until(()=>w.tg.to(p.chat.id).length,'unset-port startup barrier absent');check(!/"event"\s*:\s*"http"/.test(quiet.r.out+quiet.r.err),'HTTP listener announced without opt-in');
});
spec('20','Prometheus counters change with real updates and sends',async w=>{
 const {request}=await w.http();const metrics=async()=>{const r=await request('/metrics');check(r.status===200,'metrics unavailable');const m=new Map();for(const line of r.body.split('\n')){const p=/^(cairn_[a-z_]+)(?:\{[^}]*\})?\s+([0-9.eE+-]+)(?:\s|$)/.exec(line);if(p)m.set(p[1],(m.get(p[1])??0)+Number(p[2]))}return m};
 const a=await metrics();for(const key of ['cairn_head_block','cairn_updates_total','cairn_messages_sent_total','cairn_alerts_total','cairn_rpc_errors_total'])check(Number.isFinite(a.get(key)),`metric absent: ${key}`);
 const p=w.person();w.say(p,'/status');await until(()=>w.tg.to(p.chat.id).length,'run ignored update');await until(async()=>{const b=await metrics();return b.get('cairn_updates_total')>a.get('cairn_updates_total')&&b.get('cairn_messages_sent_total')>a.get('cairn_messages_sent_total')},'constant update/send counters');
 const n=w.tg.to(p.chat.id).length;w.say(p,`/watch ${felt(ADDR.trader)}`);await until(()=>w.tg.to(p.chat.id).length>n,'watch setup barrier absent');w.node.addBlock();const t=w.tx([transfer(ADDR.other,ADDR.trader,100n)]);await until(()=>w.alerts(p,t).length===1,'run did not deliver transfer');await until(async()=>{const c=await metrics();return c.get('cairn_head_block')===w.node.head.number&&c.get('cairn_head_block')>a.get('cairn_head_block')&&c.get('cairn_alerts_total')>a.get('cairn_alerts_total')},'constant head/alert counters');
 w.node.fail({when:()=>true,http:503,times:1});await until(async()=>((await metrics()).get('cairn_rpc_errors_total')>a.get('cairn_rpc_errors_total')),'RPC failure counter never changed');
});
spec('21','default seed guard deletes every specified BIP39 run length without echo',async w=>{
 const p=w.person();for(const n of [12,15,18,21,24]){const r=await w.seed(p,n);check(r.deleted.some(c=>c.status===200)&&r.messages.length,`seed length ${n} not guarded`);check(!text(r.messages).includes(PHRASE(n)),'seed echoed')}
});
spec('22','eleven words interrupted runs and ordinary prose are not deleted',async w=>{
 const p=w.person();await w.seedPositive(p);for(const body of [PHRASE(11),WORDS.slice(0,6).join(' ')+' not_a_bip39_word '+WORDS.slice(6,12).join(' '),'Please help us check this ordinary project status.'])check(!(await w.guardMessage(p,body)).deleted.length,'nonmatching prose deleted');
});
spec('23','guard switches persist and members cannot disable group protection',async w=>{
 const p=w.person(true);await w.seedPositive(p);await w.command(p,'/guard seed off');check(!(await w.seed(p)).deleted.length,'seed off ignored');await w.command(p,'/guard seed on');
 w.tg.members.set(`${p.chat.id}:${p.u.id}`,'member');check(/admin/i.test(text(await w.command(p,'/guard seed off'))),'member changed guard');await w.seedPositive(p);
});
spec('24','listed link hosts and subdomains match case and scheme variants',async w=>{
 const p=w.person();for(const url of ['https://starknet-bot.com/drop','http://STARKNET-BOT.COM/','https://claim.starknet-bot.com/']){const r=await w.guardMessage(p,url);check(r.deleted.some(c=>c.status===200)&&r.messages.length,`listed host not guarded: ${url}`)}
});
spec('25','host boundaries ignore userinfo paths and lookalike suffixes',async w=>{
 const p=w.person();check((await w.guardMessage(p,'https://starknet-bot.com/')).deleted.length,'positive listed-host control absent');
 for(const url of ['https://starknet-bot.com.safe.example/','https://safestarknet-bot.com/','https://safe.example/starknet-bot.com','https://starknet-bot.com@safe.example/'])check(!(await w.guardMessage(p,url)).deleted.length,`safe host overblocked: ${url}`);
});
spec('26','configured blocklist and link guard switches take effect',async w=>{
 w.env.CAIRN_BLOCKLIST=input('# Synthetic check fixture\nblocked.cairn-check.example\n',`blocklist-${++serial}.txt`);const p=w.person();check((await w.guardMessage(p,'https://blocked.cairn-check.example/')).deleted.length,'blocklist override unused');check(!(await w.guardMessage(p,'https://starknet-bot.com/')).deleted.length,'override retained default host');
 await w.command(p,'/guard links off');check(!(await w.guardMessage(p,'https://blocked.cairn-check.example/')).deleted.length,'links off ignored');await w.command(p,'/guard links on');check((await w.guardMessage(p,'https://blocked.cairn-check.example/')).deleted.length,'links on ignored');
});
spec('27','missing delete rights still warn and name the needed permission',async w=>{
 const p=w.person(true);w.tg.fail('deleteMessage',{chat:p.chat.id,code:403,description:'Forbidden: not enough rights to delete messages'});const r=await w.seed(p);check(r.deleted.some(c=>c.status===403)&&r.messages.length&&/delete|permission|rights|administrator/i.test(text(r.messages)),'delete refusal hid warning/permission');
});
spec('28','protected guard input stays out of state logs and export',async w=>{
 const p=w.person();await w.seedPositive(p);const out=await w.command(p,'/export');check(!text(out).includes(PHRASE(12)),'export repeated protected input');
});
spec('29','forget removes network and guard settings without affecting another chat',async w=>{
 w.env.CAIRN_STALL_SECONDS='2';const a=w.person(),b=w.person();await w.networkOn(a);await w.networkOn(b);await w.command(a,'/guard seed off');await w.command(a,'/guard links off');await w.watch(a);await w.watch(b);await w.command(a,'/forget');
 const aStart=w.tg.to(a.chat.id).length,bStart=w.tg.to(b.chat.id).length;await sleep(2200);await w.tick();check(w.tg.to(a.chat.id).length===aStart&&w.tg.to(b.chat.id).length===bStart+1,'forget retained network setting or removed another chat');
 // A returning forgotten chat gets default guards, rather than its old disabled settings.
 await w.seedPositive(a);check((await w.guardMessage(a,'https://starknet-bot.com/')).deleted.length,'forgotten chat retained links-off');const exported=JSON.parse(text(await w.command(a,'/export')));check(!exported.watches?.length&&!exported.whales?.length&&!exported.tracks?.length,'forget retained earlier subscriptions');
});
spec('30','deployment guide describes fresh BotFather RPC Docker and systemd setup',async w=>{
 const p=w.person();await w.networkOn(p);const readme=readFileSync(join(ROOT,'README.md'),'utf8');for(const term of [/BotFather/i,/STARKNET_RPC_URLS?/,/docker/i,/systemd/i,/volume|CAIRN_DATA/i,/SIGTERM|shutdown|stop/i])check(term.test(readme),`guide omits ${term}`);
 const docker=readFileSync(join(ROOT,'Dockerfile'),'utf8');check(/FROM\s+(?:--platform=\S+\s+)?node:24(?:[.-]|\s|@)/i.test(docker),'Dockerfile does not pin Node 24');check(files(ROOT).some(p=>p.endsWith('.service'))||/\[Service\]/.test(readme),'systemd unit absent');
});
spec('31','round 4 runtime keeps the Node 24 dependency-free contract',async w=>{
 const {request}=await w.http();check((await request('/metrics')).status===200,'R4 runtime absent');const pkg=JSON.parse(readFileSync(join(ROOT,'package.json'),'utf8'));
 for(const key of ['dependencies','devDependencies','optionalDependencies','peerDependencies'])check(!Object.keys(pkg[key]??{}).length,`undeclared framework contract: ${key}`);check(/24/.test(pkg.engines?.node??''),'Node 24 engine absent');
});

if(process.argv.includes('--list')){console.log(JSON.stringify(specs.map(s=>s.name),null,2));process.exit(0)}
const {test,done}=harness();
for(const s of specs)await test(s.name,async()=>{
 const w=await world();try{await s.fn(w);for(const c of w.children)c.kill();await Promise.all(w.children.map(c=>c.exited));safety(w)}finally{
  for(const c of w.children)c.kill();await Promise.all(w.children.map(c=>c.exited));await Promise.all([w.tg.close(),...w.nodes.map(n=>n.close())]);
 }
});
done();
