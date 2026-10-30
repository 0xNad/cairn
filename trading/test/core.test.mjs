import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHAIN, EXCHANGE_CLASS, input, units, minReceived, validateBundle, validateCalls, tradeStatus } from '../lib/core.mjs';
const q = JSON.parse(readFileSync(new URL('./fixtures/quote.json', import.meta.url)))[0];
const build = JSON.parse(readFileSync(new URL('./fixtures/build.json', import.meta.url)));
export const request = { sell:'ETH', buy:'STRK', amount:'0.001', owner:'0x1', slippageBps:50 };
export function fixture() { return { ...input(request), ...structuredClone(build), version:1, exchangeClass:EXCHANGE_CLASS, buyAmount:BigInt(q.buyAmount).toString(), minimumReceived:minReceived(q.buyAmount,50).toString(), createdAt:1000, expiresAt:31000 }; }

test('exact decimal arithmetic preserves wei, large amounts and six decimal tokens',()=>{
  assert.equal(units('0.000000000000000001',18),1n);
  assert.equal(units('123456789123456789.123456',6),123456789123456789123456n);
  for(const bad of ['1e18','-1','1,000','0','NaN','Infinity','1.0000001','01']) assert.throws(()=>units(bad,6));
  assert.equal(minReceived(101n,50),100n,'matches AVNU build integer floor, not SDK helper ceiling');
});
test('captured real quote/build validates against reviewed exact-input trade',()=>{
  assert.equal(validateBundle(fixture(),request,2000).length,2);
});
test('changed quote identity, expiry, output and bounds are rejected',()=>{
  for(const [key,value] of [['owner','0x2'],['chainId','0x1'],['exchangeClass','0x2'],['amount','2'],['slippageBps',100],['expiresAt',1001],['minimumReceived','1'],['buyAmount','0']]) {
    const b=fixture(); b[key]=value; assert.throws(()=>validateBundle(b,request,2000),key);
  }
  for(const v of [0,10000,1000000,-1,NaN]) assert.throws(()=>input({...request,slippageBps:v}));
});
test('approval cannot change token, spender, amount, shape or add arbitrary calls',()=>{
  for(const mutate of [b=>b.calls[0].contractAddress='0x2',b=>b.calls[0].calldata[0]='0x2',b=>b.calls[0].calldata[1]='0xffff',b=>b.calls[0].calldata[2]='0x1',b=>b.calls[0].calldata.push('0x0'),b=>b.calls.push(b.calls[1])]) {const b=fixture(); mutate(b); assert.throws(()=>validateBundle(b,request,2000));}
});
test('swap cannot redirect recipient, change fees, method, tokens or minimum output',()=>{
  for(const mutate of [b=>b.calls[1].contractAddress='0x2',b=>b.calls[1].entrypoint='transfer',b=>b.calls[1].calldata[0]='0x2',b=>b.calls[1].calldata[8]='0x2',b=>b.calls[1].calldata[9]='0x1',b=>b.calls[1].calldata[10]='0x2',b=>b.calls[1].calldata[6]='0x0',b=>b.executorAddress='0x2']) {const b=fixture();mutate(b);assert.throws(()=>validateBundle(b,request,2000));}
});
test('AVNU custom Serde supports direct and branch routes and rejects malformed tails',()=>{
  const b=fixture(); const head=b.calls[1].calldata.slice(0,11);
  b.calls[1].calldata=[...head,'0x1',b.sell.address,b.buy.address,'0x6272616e6368','0x123','0xe8d4a51000','0x0','0x1','0x124','0xe8d4a51000','0x0'];
  assert.equal(validateCalls(b,b).length,2);
  for(const tail of [ ['0x0'],['0x1000'],['0x1',b.sell.address,b.buy.address],['0x1',b.sell.address,b.buy.address,'0x123','0xe8d4a51000','0x9'],[...b.calls[1].calldata.slice(11),'0x0'] ]) {
    b.calls[1].calldata=[...head,...tail];assert.throws(()=>validateCalls(b,b));
  }
});
test('status keeps execution and finality separate; a reverted L2 transaction is not success',()=>{
  assert.equal(tradeStatus(null).state,'unknown');
  assert.equal(tradeStatus({execution_status:'SUCCEEDED',finality_status:'PRE_CONFIRMED'}).state,'pending');
  assert.equal(tradeStatus({execution_status:'REVERTED',finality_status:'ACCEPTED_ON_L2'}).state,'reverted');
  assert.equal(tradeStatus({execution_status:'SUCCEEDED',finality_status:'ACCEPTED_ON_L2'}).state,'confirmed');
  assert.equal(tradeStatus({execution_status:'SUCCEEDED',finality_status:'ACCEPTED_ON_L1'}).state,'settled');
});
