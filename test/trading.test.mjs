import {test} from 'node:test';
import assert from 'node:assert/strict';
import {answer,COMMANDS,commandsFor} from '../src/commands.mjs';
import {loadConfig} from '../src/config.mjs';
const context={config:{tradingUrl:'https://cairn.example/'},clean:x=>x,username:'cairn_bot'};
test('trading is optional and preserves the original registered command list',()=>{
 assert.equal(commandsFor({}),COMMANDS);assert.equal(commandsFor(context.config).length,COMMANDS.length+3);
});
test('buy/sell links encode exact-input semantics without a Telegram identity',async()=>{
 for(const[name,arg,sell,buy]of[['buy','STRK 100 USDC','USDC','STRK'],['sell','STRK 100 USDC','STRK','USDC']]){
  const lines=await answer({name,argument:arg},context);const href=lines.at(-1).match(/href="([^"]+)/)[1].replaceAll('&amp;','&');const u=new URL(href);
  assert.equal(u.searchParams.get('sell'),sell);assert.equal(u.searchParams.get('buy'),buy);assert.equal(u.searchParams.get('amount'),'100');assert.ok(!u.searchParams.has('chat_id'));
 }
});
test('bot trade links reject markup and ambiguous decimal amounts',async()=>{
 for(const argument of ['STRK <script> USDC','STRK 1e3 USDC','STRK -1 USDC','STRK 0 USDC','STRK 1 USDC extra']){
  const lines=await answer({name:'buy',argument},context);assert.ok(!lines.join('').includes('<a href='));
 }
});
test('HTTP trading endpoints are not allowed in bot configuration',()=>{
 assert.throws(()=>loadConfig(['tick'],{TELEGRAM_BOT_TOKEN:'123456:'+('a'.repeat(35)),STARKNET_RPC_URL:'https://rpc.example/',CAIRN_DATA:process.cwd(),CAIRN_TRADING_URL:'http://evil.example'}),/CAIRN_TRADING_URL/);
});
