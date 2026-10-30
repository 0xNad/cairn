import './style.css';
import { createStore, StandardConnect, StandardDisconnect, StandardEvents, StarknetWalletApi } from '@starknet-io/get-starknet-core';
import { CHAIN, TOKENS, address, felt, token, input, units, format, validateBundle } from './lib/core.mjs';

const $ = id => document.getElementById(id), short = a => a.slice(0,7) + '…' + a.slice(-5);
let expectedOwner = null;
try { const p=new URLSearchParams(location.search); if(p.has('owner'))expectedOwner=address(p.get('owner')); } catch { /* Invalid link cannot authorize a wallet. */ }
function showView(name) {
  for(const view of ['trade','activity','help']) $('view-'+view).hidden=view!==name;
  for(const tab of document.querySelectorAll('nav [data-view]')) { if(tab.dataset.view===name)tab.setAttribute('aria-current','page');else tab.removeAttribute('aria-current'); }
}
for(const tab of document.querySelectorAll('[data-view]'))tab.onclick=()=>showView(tab.dataset.view);
const store = createStore({ eip1193Adapters: [] }); // Discover Starknet wallets; never auto-install a MetaMask Snap.
let wallet = null, owner = null, walletOff = null, balances = new Map(), deployed = true, bundle = null, busy = false, signing = false, epoch = 0, timer = null, serviceReady = false;
const KEY = 'cairn-trades-v1';
let history = [];
try { history = JSON.parse(localStorage.getItem(KEY) ?? '[]').filter(x => {
  try { return x && typeof x.id === 'string' && x.id.length <= 100 && address(x.owner) && (!x.hash || address(x.hash))
    && typeof x.amount === 'string' && x.amount.length <= 100 && token(x.sell) && token(x.buy) && Number.isSafeInteger(x.at)
    && typeof x.label === 'string' && x.label.length <= 250; } catch { return false; }
}).slice(0,20); } catch { /* private mode / corrupt history */ }
for (const h of history) if (h.state === 'awaiting_wallet') { h.state = 'unknown'; h.label = 'Wallet result unknown — check your wallet before trading again'; }
function save() { try { localStorage.setItem(KEY, JSON.stringify(history.slice(0,20))); } catch { /* trading does not depend on browser storage */ } renderHistory(); }
function notice(text, kind = '') { $('notice').textContent = text; $('notice').className = kind; }
async function api(action, body = {}) {
  const r = await fetch('/api/' + action, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
  const data = await r.json(); if (!r.ok) throw new Error(data.error ?? 'Trading service unavailable.'); return data;
}
function values() { return { sell: $('sell-token').value, buy: $('buy-token').value, amount: $('amount').value, owner, slippageBps: Number($('slippage').value) }; }
function unresolved() { return history.some(h => h.owner === owner && ['unknown','awaiting_wallet'].includes(h.state)); }
function button() {
  $('quote-button').disabled = busy || signing || (!serviceReady && !!owner);
  $('quote-button').textContent = busy ? 'Getting your quote…' : signing ? 'Waiting for your wallet…' : !owner ? 'Connect wallet ↗' : !serviceReady ? 'Trading temporarily unavailable' : 'Review trade →';
}
function invalidate(message) {
  epoch++; bundle = null; clearInterval(timer); timer = null;
  $('review').hidden = true; $('trade-form').hidden = false; $('receive-amount').textContent = '0.00';
  $('sell-usd').textContent = 'Exact input'; $('buy-usd').textContent = 'Quote after connecting';
  if (message) notice(message); button();
}
function balanceLabel() {
  for(const side of ['sell','buy']) { const t=token($(side+'-token').value); $(side+'-mark').textContent=({STRK:'✦',ETH:'♦',USDC:'$', 'USDC.e':'$',USDT:'₮',WBTC:'₿'})[t.symbol]; $(side+'-mark').dataset.token=t.symbol; }
  const t = token($('sell-token').value), b = balances.get(t.symbol);
  $('balance-label').textContent = !owner ? 'Balance —' : b === null || b === undefined ? 'Balance unavailable' : `Balance: ${format(b,t.decimals,6)} ${t.symbol}`;
}
async function loadAccount() {
  if (!owner) return; const who = owner;
  try { const a = await api('account', {owner:who}); if (owner !== who) return; deployed = a.deployed; balances = new Map(a.balances.map(b => [b.symbol,b.amount])); balanceLabel(); if (!deployed) notice('Activate this account in your wallet before trading.','error'); }
  catch { if (owner === who) notice('Balance check unavailable. Your wallet will validate funds and network fees.'); }
}
function renderWallets() {
  const list = $('wallet-list'); list.replaceChildren();
  for (const w of store.getWallets()) {
    const b = document.createElement('button'); b.className = 'wallet-choice'; b.textContent = w.name; b.onclick = () => connect(w); list.append(b);
  }
  $('wallet-empty').hidden = store.getWallets().length !== 0;
}
store.subscribe(renderWallets);
async function connect(w) {
  if (signing) return; $('wallet-error').textContent = '';
  try {
    const result = await w.features[StandardConnect].connect();
    if (!result.accounts.length) throw new Error('Wallet connection was cancelled.');
    const request = w.features[StarknetWalletApi].request;
    const chain = await request({type:'wallet_requestChainId'});
    if (felt(chain) !== CHAIN) throw new Error('Switch your wallet to Starknet mainnet, then connect again.');
    const nextOwner=address(result.accounts[0].address);
    if(expectedOwner && nextOwner!==expectedOwner)throw new Error('Connect the wallet used for your Telegram quote: '+short(expectedOwner)+'.');
    walletOff?.(); wallet = w; owner = nextOwner; balances = new Map();
    walletOff = w.features[StandardEvents].on('change', () => {
      if (signing) notice('Wallet changed during signing. Check the wallet and transaction result before another trade.','error');
      owner = null; wallet = null; balances = new Map(); $('connect').textContent = 'Connect wallet ↗'; invalidate('Wallet changed. Reconnect and get a fresh quote.'); balanceLabel();
    });
    $('connect').textContent = short(owner) + ' · Disconnect'; $('wallet-dialog').close();
    invalidate(unresolved() ? 'An earlier wallet result is unknown. Check the activity below before trading again.' : 'Wallet connected. Choose your tokens and amount.');
    await loadAccount(); balanceLabel(); renderHistory();
  } catch (e) { $('wallet-error').textContent = e.message || 'Could not connect your wallet.'; }
}
async function walletButton() {
  if (signing) return;
  if (wallet) { walletOff?.(); await wallet.features[StandardDisconnect].disconnect(); wallet = null; owner = null; balances = new Map(); $('connect').textContent = 'Connect wallet ↗'; invalidate('Wallet disconnected.'); balanceLabel(); return; }
  renderWallets(); $('wallet-dialog').showModal();
}
$('connect').onclick = walletButton;
$('close-wallets').onclick = () => $('wallet-dialog').close();
$('refresh-wallets').onclick = () => { store._refreshInjectedWallets(); renderWallets(); };
$('braavos-mobile').href = 'https://link.braavos.app/dapp/' + location.host;
for (const id of ['sell-token','buy-token']) {
  for (const t of TOKENS) { const o = document.createElement('option'); o.value = t.symbol; o.textContent = t.symbol; $(id).append(o); }
  $(id).onchange = () => { invalidate(); balanceLabel(); };
}
$('sell-token').value = 'USDC'; $('buy-token').value = 'STRK';
try {
  const p = new URLSearchParams(location.search);
  for (const [param,id] of [['sell','sell-token'],['buy','buy-token']]) if (p.has(param)) $(id).value = token(p.get(param)).symbol;
  if (p.has('amount')) { units(p.get('amount'),token($('sell-token').value).decimals); $('amount').value = p.get('amount'); }
  if (p.get('mode') === 'sell') { $('sell-tab').setAttribute('aria-pressed','true'); $('buy-tab').setAttribute('aria-pressed','false'); }
} catch { notice('That trade link was invalid. Choose your tokens and amount.','error'); }
$('amount').oninput = () => invalidate(); $('slippage').onchange = () => invalidate();
$('reverse').onclick = () => { const a = $('sell-token').value; $('sell-token').value = $('buy-token').value; $('buy-token').value = a; $('amount').value = ''; invalidate(); balanceLabel(); };
for (const mode of ['buy','sell']) $(mode+'-tab').onclick = () => {
  if ($(mode+'-tab').getAttribute('aria-pressed') === 'true') return;
  $('buy-tab').setAttribute('aria-pressed',String(mode==='buy')); $('sell-tab').setAttribute('aria-pressed',String(mode==='sell'));
  const a = $('sell-token').value; $('sell-token').value = $('buy-token').value; $('buy-token').value = a; $('amount').value = ''; invalidate(); balanceLabel();
};
for (const b of document.querySelectorAll('[data-percent]')) b.onclick = () => {
  const t = token($('sell-token').value), balance = balances.get(t.symbol);
  if (balance === undefined || balance === null) return notice('Connect your wallet and wait for its balance.');
  if (t.symbol === 'STRK' && b.dataset.percent === '100') return notice('Keep some STRK for network fees. Enter the amount to sell manually.');
  $('amount').value = format(BigInt(balance)*BigInt(b.dataset.percent)/100n,t.decimals); invalidate();
};
function detail(label,value,target='review-details') { const row=document.createElement('div'), dt=document.createElement('dt'), dd=document.createElement('dd'); dt.textContent=label; dd.textContent=value; row.append(dt,dd); $(target).append(row); }
function showReview(b) {
  $('receive-amount').textContent = format(b.buyAmount,b.buy.decimals,8);
  $('review-details').replaceChildren(); $('route-details').replaceChildren();
  $('review-pay').textContent=format(b.amount,b.sell.decimals)+' '+b.sell.symbol;
  $('review-receive').textContent=format(b.buyAmount,b.buy.decimals,8)+' '+b.buy.symbol;
  detail('Minimum received',format(b.minimumReceived,b.buy.decimals)+' '+b.buy.symbol);
  detail('Slippage',(b.slippageBps/100)+'%','route-details'); detail('Route',b.routes.join(' → ') || 'AVNU','route-details');
  detail('Cairn trading fee','0','route-details');
  if (b.fee) { const t=TOKENS.find(t=>t.address===b.fee.token); detail('AVNU fee (included)',t ? format(b.fee.avnuAmount,t.decimals)+' '+t.symbol : 'Included in quoted output'); }
  detail('Network fee (estimate)',b.gasEstimate ? format(b.gasEstimate,18,8)+' STRK · final fee in wallet' : 'Shown by your wallet');
  detail('Recipient',short(b.owner));
  if (b.priceImpactBps !== null) detail('Price impact',(Math.abs(b.priceImpactBps)/100).toFixed(2)+'%');
  $('accept-impact').checked=false; $('impact-warning').hidden = !(Math.abs(b.priceImpactBps ?? 0)>100);
  $('trade-form').hidden=true; $('review').hidden=false;
  const tick = () => { const seconds=Math.max(0,Math.floor((b.expiresAt-Date.now())/1000)); $('quote-timer').textContent=seconds ? `Quote: ${seconds}s` : 'Quote expired'; $('confirm').disabled=signing || !seconds || (!$('impact-warning').hidden && !$('accept-impact').checked); if (!seconds && !signing) $('confirm').textContent='Quote expired — go back to refresh'; };
  $('confirm').textContent='Confirm in wallet ↗'; tick(); clearInterval(timer); timer=setInterval(tick,500); $('review').scrollIntoView({behavior:'smooth',block:'nearest'});
}
$('trade-form').onsubmit = async event => {
  event.preventDefault(); if (!owner) return walletButton(); if (busy || signing) return;
  if (unresolved()) return notice('Check the unresolved wallet result in your activity before starting another trade.','error');
  if (!deployed) return notice('Activate this account in your wallet first.','error');
  const request=values(); let e;
  try { e=input(request); const b=balances.get(e.sell.symbol); if (b!==null && b!==undefined && BigInt(b)<BigInt(e.amount)) throw new Error('Not enough '+e.sell.symbol+' for this trade.'); }
  catch(error) { return notice(error.message,'error'); }
  const version=++epoch; busy=true; button(); notice('Finding a route and checking the transaction…');
  try { const b=await api('quote',request); if (epoch!==version || owner!==e.owner) return; validateBundle(b,request); bundle=b; showReview(b); notice('Review the exact amounts, minimum received and fees.'); }
  catch(error) { if (epoch===version) notice(error.message,'error'); }
  finally { busy=false; button(); }
};
$('cancel-review').onclick=()=> { if (!signing) invalidate('Edit your trade, then get a fresh quote.'); };
$('confirm').onclick=async()=> {
  if (!bundle || !wallet || signing || unresolved()) return;
  if (!$('impact-warning').hidden && !$('accept-impact').checked) return;
  const b=bundle,w=wallet; let record;
  try {
    const calls=validateBundle(b,values());
    signing=true; $('confirm').disabled=true; button();
    const request=w.features[StarknetWalletApi].request;
    const [accounts,chain]=await Promise.all([request({type:'wallet_requestAccounts',params:{silent_mode:true}}),request({type:'wallet_requestChainId'})]);
    if (felt(chain)!==CHAIN || address(accounts[0])!==b.owner || wallet!==w || owner!==b.owner) throw new Error('Wallet account or network changed. Get a new quote.');
    validateBundle(b,values());
    record={id:crypto.randomUUID(),owner:b.owner,sell:b.sell.symbol,buy:b.buy.symbol,amount:format(b.amount,b.sell.decimals),minimumReceived:b.minimumReceived,slippageBps:b.slippageBps,at:Date.now(),state:'awaiting_wallet',label:'Waiting for wallet approval',hash:null};
    history.unshift(record); history=history.slice(0,20); save(); notice('Review and approve the swap in your wallet.');
    const result=await request({type:'wallet_addInvokeTransaction',params:{calls:calls.map(c=>({contract_address:c.contractAddress,entry_point:c.entrypoint,calldata:c.calldata}))}});
    record.hash=address(result.transaction_hash); record.state='pending'; record.label='Submitted — waiting for confirmation'; save();
    notice('Transaction submitted. Follow its status in Activity.','success');
    invalidate(); showView('activity'); poll(record); await loadAccount();
  } catch(error) {
    if (record) {
      if ([4001,113].includes(error.code)) { record.state='cancelled'; record.label='Cancelled in wallet'; }
      else { record.state='unknown'; record.label='Wallet result unknown — check your wallet before another trade'; }
      save();
    }
    if(record?.state==='unknown')showView('activity');
    invalidate(); notice(record?.state==='unknown' ? record.label : error.message || 'Wallet request failed. Get a fresh quote.','error');
  } finally { signing=false; button(); }
};
async function poll(record, attempt=0) {
  if (!record.hash || !history.includes(record)) return;
  try { const result=await api('receipt',{hash:record.hash,owner:record.owner,sell:record.sell,buy:record.buy,amount:record.amount,slippageBps:record.slippageBps,minimumReceived:record.minimumReceived}); record.state=result.state; record.label=result.label; record.finality=result.finality; record.actualReceived=result.actualReceived; save();
    if (['confirmed','settled','reverted','mismatch'].includes(result.state)) { await loadAccount(); return; }
  } catch { record.label='Status unavailable — check your wallet before retrying'; save(); }
  if (attempt<24) setTimeout(()=>poll(record,attempt+1),5000);
}
function renderHistory() {
  $('activity-count').hidden=history.length===0; $('activity-count').textContent=history.length; $('clear-history').hidden=history.length===0;
  $('empty-history').hidden=history.length>0; const list=$('history-list'); list.replaceChildren();
  for (const h of history) {
    const row=document.createElement('div'); row.className='trade-row'; const text=document.createElement('div');
    const title=document.createElement('strong'); title.textContent=`${h.amount} ${h.sell} → ${h.buy}`; const status=document.createElement('small'); status.textContent=h.label;
    const meta=document.createElement('small'); meta.textContent=`${short(h.owner)} · ${new Date(h.at).toLocaleString()}`; text.append(title,status,meta); row.append(text);
    const actions=document.createElement('div');
    if (h.hash) { const a=document.createElement('a'); a.href='https://voyager.online/tx/'+address(h.hash); a.target='_blank'; a.rel='noopener noreferrer'; a.textContent='View transaction ↗'; actions.append(a); const refresh=document.createElement('button'); refresh.className='text-button'; refresh.textContent='Refresh status'; refresh.onclick=()=>poll(h,24); actions.append(document.createElement('br'),refresh); }
    else if (h.state==='unknown') { const a=document.createElement('a'); a.href='https://voyager.online/contract/'+address(h.owner); a.target='_blank'; a.rel='noopener noreferrer'; a.textContent='Check wallet activity ↗'; actions.append(a); const done=document.createElement('button'); done.textContent="I've checked my wallet"; done.className='text-button'; done.onclick=()=>{h.state='acknowledged';h.label='Wallet checked manually — transaction outcome not verified here';save();notice('Get a fresh quote only if the earlier trade did not execute.');}; actions.append(document.createElement('br'),done); }
    row.append(actions); list.append(row);
  }
}
$('clear-history').onclick=()=>{ if(signing) return; if(history.some(h=>['unknown','awaiting_wallet','pending'].includes(h.state))) return notice('Resolve pending or unknown wallet results before clearing history.','error'); history=[];save(); };
renderHistory();
for (const h of history) if (h.hash && ['pending','unknown'].includes(h.state)) poll(h);
api('config').then(c=>{if(felt(c.chainId)!==CHAIN)throw new Error('Wrong trading network.');serviceReady=true;$('release').textContent='Starknet · '+String(c.version).slice(0,10);button();}).catch(()=>{$('release').textContent='Trading service temporarily unavailable';notice('Trading is temporarily unavailable. No transaction has been submitted.','error');button();});
balanceLabel();
