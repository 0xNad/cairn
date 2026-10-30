import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createService,createHandler } from '../lib/service.mjs';
import { CHAIN,EXCHANGE_CLASS } from '../lib/core.mjs';
const quote=JSON.parse(readFileSync(new URL('./fixtures/quote.json',import.meta.url)));
const build=JSON.parse(readFileSync(new URL('./fixtures/build.json',import.meta.url)));
const request={sell:'ETH',buy:'STRK',amount:'0.001',owner:'0x1',slippageBps:50};
function setup({mutateQuote,mutateBuild,chain=CHAIN,classHash=EXCHANGE_CLASS,status=200}={}){
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url,options});let data;
    if(url==='https://rpc.test'){
      const body=JSON.parse(options.body);
      assert.ok(['starknet_chainId','starknet_getClassHashAt','starknet_call','starknet_getTransactionReceipt'].includes(body.method),'server never submits a transaction');
      data={result:body.method==='starknet_chainId'?chain:classHash};
    }else if(url.includes('/quotes?')){data=structuredClone(quote);mutateQuote?.(data);}
    else{data=structuredClone(build);mutateBuild?.(data);}
    return new Response(JSON.stringify(data),{status});
  };
  return{service:createService({rpcUrls:['https://rpc.test'],fetcher,now:()=>1000}),calls};
}
test('service builds validated real-format quote with explicit fractional slippage and no fee',async()=>{
 const{service,calls}=setup();const b=await service.quote(request);assert.equal(b.calls.length,2);assert.equal(b.owner,'0x1');assert.equal(b.fee.integratorAmount,'0');
 const body=JSON.parse(calls.find(c=>c.url.endsWith('/build')).options.body);assert.equal(body.slippage,0.005);assert.equal(body.includeApprove,true);
 assert.ok(calls.every(c=>['rpc.test','starknet.api.avnu.fi'].includes(new URL(c.url).host)));
});
test('bad network or changed exchange pauses before querying an aggregator',async()=>{
 for(const cfg of [{chain:'0x1'},{classHash:'0x2'}]){const{service,calls}=setup(cfg);await assert.rejects(service.quote(request),/paused/);assert.equal(calls.length,2);}
});
test('malformed routes, wrong quote, hidden fees and injected build fields fail closed',async()=>{
 for(const cfg of [{mutateQuote:q=>q[0].buyTokenAddress='0x2'},{mutateQuote:q=>q[0].fee.integratorFees='0x1'},{mutateBuild:b=>b.calls[1].calldata[8]='0x2'},{mutateBuild:b=>b.calls.push(b.calls[1])}]) await assert.rejects(setup(cfg).service.quote(request));
 const{service}=setup({mutateBuild:b=>{b.owner='0x2';b.amount='2';b.createdAt=0;}});assert.equal((await service.quote(request)).owner,'0x1','untrusted build metadata cannot override validated inputs');
});
test('network errors and provider errors are sanitized, never expose credentials',async()=>{
 const service=createService({rpcUrls:['https://rpc.test/private-key'],fetcher:async()=>{throw Error('secret-private-key')}});
 await assert.rejects(service.quote(request),e=>!e.message.includes('private-key')&&e.status===503);
});
test('per-instance request budget is bounded and unknown API actions are rejected',async()=>{
 const handle=createHandler({config:async()=>({ok:true})});for(let n=0;n<60;n++) await handle('config',{},'test-client');
 await assert.rejects(handle('config',{},'test-client'),e=>e.status===429);await assert.rejects(handle('execute',{},'other-client'),e=>e.status===404);
});
test('receipt reads bind to the requested hash, distinguish a revert and survive an exchange upgrade',async()=>{
 let wrong=false;
 const service=createService({rpcUrls:['https://rpc.test'],fetcher:async(_,o)=>{
  const {method}=JSON.parse(o.body);
  assert.ok(['starknet_chainId','starknet_getTransactionReceipt'].includes(method));
  return new Response(JSON.stringify({result:method==='starknet_chainId'?CHAIN:{transaction_hash:wrong?'0x2':'0x1',execution_status:'REVERTED',finality_status:'ACCEPTED_ON_L2'}}));
 }});
 assert.equal((await service.receipt({hash:'0x1'})).state,'reverted');wrong=true;
 await assert.rejects(service.receipt({hash:'0x1'}),/does not match/);
});
