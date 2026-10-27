// Private fixture builders for future Cairn checks. No application implementation.
import { SEL as BASE, felt, feltOf, u256, shortString } from './fake-starknet.mjs';
export const SELECTORS = {
  ...BASE,
  Swapped: '0x0157717768aca88da4ac4279765f09f4d0151823d573537fbbeb950cdbd9a870',
  Swap: '0x00e316f0d9d2a3affa97de1d99bb2aac0538e2666d0d8545545ead241ef0ccab',
  get_data_median: '0x0024b869ce68dd257b370701ca16e4aaf9c6483ff6805d04ba7661f3a0b6ce59',
  domain_to_address: '0x02e269d930f6d7ab92b15ce8ff9f5e63709391617e3465fff79ba6baf278ce60',
  address_to_domain: '0x038b679fb029cc3f953635ed16ae4123da8214e726943920ba7706a0473e326a',
};
export const ADDR = Object.fromEntries(['token','quote','ekubo','avnu','pragma','naming','trader','other','router','relayer','sequencer'].map(k=>[k,feltOf(`cairn future fixture ${k}`)]));
export const T0 = 1792454400;
const signed = n => [felt(n < 0n ? -n : n), felt(n < 0n ? 1 : 0)];
export function transfer(from, to, value, token = ADDR.token, legacy = false) {
  return {from_address:felt(token),keys:[felt(SELECTORS.Transfer),...(legacy?[]:[felt(from),felt(to)])],data:[...(legacy?[felt(from),felt(to)]:[]),...u256(value).map(felt)]};
}
// Input signs use the pool convention: positive is paid into the pool.
export function ekubo(delta0, delta1, token0=ADDR.token, token1=ADDR.quote) {
  return {from_address:felt(ADDR.ekubo),keys:[SELECTORS.Swapped],data:[
    felt(ADDR.router),felt(token0),felt(token1),'0x0','0x1','0x0',
    '0x1','0x0','0x0','0x0','0x0','0x0',...signed(delta0),...signed(delta1),
    '0x0','0x0','0x0','0x0','0x1',
  ]};
}
export function avnu(sellToken, sellAmount, buyToken, buyAmount) {
  return {from_address:felt(ADDR.avnu),keys:[SELECTORS.Swap],data:[felt(ADDR.router),felt(sellToken),...u256(sellAmount).map(felt),felt(buyToken),...u256(buyAmount).map(felt),felt(ADDR.router)]};
}
// Deliberately literal expected outcomes; these are not computed by an oracle.
// net is the user's token perspective, opposite to Ekubo's pool delta.
export const TRADES = [
  {id:'ekubo-buy-relayed',events:[ekubo(-100n,200n),transfer(ADDR.ekubo,ADDR.trader,100n)],expected:{net:'100',side:'buy',trader:'trader',venue:'Ekubo'}},
  {id:'ekubo-sell',events:[ekubo(100n,-200n),transfer(ADDR.trader,ADDR.ekubo,100n)],expected:{net:'-100',side:'sell',trader:'trader',venue:'Ekubo'}},
  {id:'ekubo-token1-buy',events:[ekubo(200n,-100n,ADDR.quote,ADDR.token),transfer(ADDR.ekubo,ADDR.trader,100n)],expected:{net:'100',side:'buy',trader:'trader',venue:'Ekubo'}},
  {id:'ekubo-multihop',events:[ekubo(-140n,280n),ekubo(40n,-80n),transfer(ADDR.ekubo,ADDR.router,140n),transfer(ADDR.router,ADDR.ekubo,40n),transfer(ADDR.router,ADDR.trader,100n)],expected:{net:'100',side:'buy',trader:'trader',venue:'Ekubo'}},
  {id:'ekubo-roundtrip',events:[ekubo(-100n,200n),ekubo(100n,-200n),transfer(ADDR.ekubo,ADDR.trader,100n),transfer(ADDR.trader,ADDR.ekubo,100n)],expected:{net:'0',side:null,trader:null,venue:'Ekubo'}},
  {id:'avnu-precedence',events:[avnu(ADDR.quote,200n,ADDR.token,100n),ekubo(-100n,200n),transfer(ADDR.ekubo,ADDR.router,100n),transfer(ADDR.router,ADDR.trader,100n)],expected:{net:'100',side:'buy',trader:'trader',venue:'AVNU'}},
  {id:'avnu-sell-u256',events:[avnu(ADDR.token,2n**128n+7n,ADDR.quote,200n),transfer(ADDR.trader,ADDR.avnu,2n**128n+7n)],expected:{net:'-340282366920938463463374607431768211463',side:'sell',trader:'trader',venue:'AVNU'}},
  {id:'avnu-net-multiple',events:[avnu(ADDR.quote,200n,ADDR.token,100n),avnu(ADDR.token,40n,ADDR.quote,80n),transfer(ADDR.avnu,ADDR.trader,100n),transfer(ADDR.trader,ADDR.avnu,40n)],expected:{net:'60',side:'buy',trader:'trader',venue:'AVNU'}},
  {id:'avnu-roundtrip',events:[avnu(ADDR.quote,200n,ADDR.token,100n),avnu(ADDR.token,100n,ADDR.quote,200n),transfer(ADDR.avnu,ADDR.trader,100n),transfer(ADDR.trader,ADDR.avnu,100n)],expected:{net:'0',side:null,trader:null,venue:'AVNU'}},
  {id:'trader-tie',events:[ekubo(-100n,200n),transfer(ADDR.ekubo,ADDR.other,50n),transfer(ADDR.ekubo,ADDR.trader,50n)],expected:{net:'100',side:'buy',trader:'other',venue:'Ekubo'}},
  {id:'trader-largest-net',events:[ekubo(-100n,200n),transfer(ADDR.ekubo,ADDR.other,80n),transfer(ADDR.other,ADDR.trader,60n),transfer(ADDR.ekubo,ADDR.trader,20n)],expected:{net:'100',side:'buy',trader:'trader',venue:'Ekubo'}},
  {id:'no-trader',events:[ekubo(-100n,200n),transfer(ADDR.ekubo,ADDR.avnu,100n)],expected:{net:'100',side:'buy',trader:null,venue:'Ekubo'}},
  {id:'unrelated-avnu',events:[avnu(ADDR.quote,10n,ADDR.other,20n),ekubo(-100n,200n),transfer(ADDR.ekubo,ADDR.trader,100n)],expected:{net:'100',side:'buy',trader:'trader',venue:'Ekubo'}},
  {id:'legacy-transfers',events:[ekubo(-100n,200n),transfer(ADDR.ekubo,ADDR.trader,100n,ADDR.token,true)],expected:{net:'100',side:'buy',trader:'trader',venue:'Ekubo'}},
];
export const NAME_VECTORS = [
  ['a','0x25'],['b','0x1'],['aa','0x57e'],['ab','0x26'],['ba','0x57f'],
  ['ben','0x49ed'],['alpha','0x49f69f6'],['anna','0x1f45fa'],['nadia','0x49ffb09'],
  ['banana','0xb05c1d05'],['cairn','0x1ac06ca'],['starknet','0x1fd32dc5fbc'],
  ['stark','0x14c695c'],['zkorp','0x1ebcc55'],['abc-123','0x14dc38343e'],
  ['a1','0x402'],['1a','0x599'],['0','0x1a'],['-','0x24'],
];
export const PRICES = [
  {id:'fresh',answer:['125000000','8',String(T0),'4','1'],chainNow:T0+60,expected:{usd:'1.25',age:60,usable:true}},
  {id:'fresh-boundary',answer:['125000000','8',String(T0),'4','1'],chainNow:T0+900,expected:{usd:'1.25',age:900,usable:true}},
  {id:'stale-boundary',answer:['125000000','8',String(T0),'4','1'],chainNow:T0+901,expected:{usd:null,age:901,usable:false}},
  {id:'missing',answer:['0','0','0','0','1'],chainNow:T0,expected:{usd:null,age:null,usable:false}},
  {id:'expiration-some',answer:['125000000','8',String(T0),'4','0',String(T0+120)],chainNow:T0+60,expected:{usd:'1.25',age:60,usable:true}},
];
export function installContracts(node,{price=PRICES[0],reverseAddress=ADDR.trader}={}) {
  node.contract(ADDR.pragma,{calls:{[SELECTORS.get_data_median]:([tag,pair])=>{
    if(tag!==0n||pair!==shortString('STRK/USD')) throw new Error('wrong Pragma calldata');
    return price.answer.map(BigInt);
  }}});
  node.contract(ADDR.naming,{calls:{
    [SELECTORS.domain_to_address]:args=>{
      if(args.length===3&&args[0]===1n&&args[1]===0x49edn&&args[2]===0n)return [reverseAddress];
      return [0n];
    },
    [SELECTORS.address_to_domain]:([address,hint])=>address===ADDR.trader&&hint===0n?[1n,0x49edn]:[0n],
  }});
  node.contract(ADDR.token,{calls:{
    [SELECTORS.balance_of]:([owner],block)=>u256(owner===ADDR.trader&&block.number>=4_200_010?100n:0n),
    [SELECTORS.decimals]:()=>[0n],[SELECTORS.symbol]:()=>[shortString('STRK')],
  }});
}
