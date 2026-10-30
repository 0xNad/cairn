// Browser QA only. Injected before page load by CDP; never imported by the app or built assets.
(() => {
  const listeners = {};
  window.__walletCalls = [];
  window.__walletMode = 'success';
  window.starknet_cairn_fixture = {
    id: 'cairn-fixture', name: 'Cairn QA wallet (simulated)', version: '1.0.0', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
    on: (name,fn) => { (listeners[name] ??= []).push(fn); },
    off: (name,fn) => { listeners[name] = (listeners[name] ?? []).filter(f=>f!==fn); },
    async request({type,params}) {
      if(type==='wallet_requestAccounts') return ['0x1'];
      if(type==='wallet_requestChainId') return window.__walletMode==='wrong-network' ? '0x534e5f5345504f4c4941' : '0x534e5f4d41494e';
      if(type==='wallet_addInvokeTransaction') {
        window.__walletCalls.push(params);
        if(window.__walletMode==='cancel') { const e=new Error('User refused');e.code=113;throw e; }
        if(window.__walletMode==='unknown') throw new Error('Wallet transport disconnected');
        return {transaction_hash:'0x1234'};
      }
      throw Error('Unsupported QA wallet method');
    },
  };
  window.__walletChange = () => { for(const fn of listeners.accountsChanged ?? []) fn(['0x2']); };
  const original=window.fetch;
  window.fetch=async(url,options)=>{
    if(String(url)==='/api/account') return new Response(JSON.stringify({owner:'0x1',deployed:true,balances:['ETH','STRK','USDC','USDC.e','USDT','WBTC'].map(symbol=>({symbol,amount:'10000000000000000000000000'}))}),{headers:{'content-type':'application/json'}});
    if(String(url)==='/api/receipt') return new Response(JSON.stringify({hash:'0x1234',state:'confirmed',label:'QA simulated confirmation',finality:'ACCEPTED_ON_L2',execution:'SUCCEEDED'}),{headers:{'content-type':'application/json'}});
    return original(url,options);
  };
})();
