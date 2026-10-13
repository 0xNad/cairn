// The sn_keccak selectors ARCHITECTURE.md lists ("Selectors"): node:crypto has no keccak, and nothing in
// Cairn hashes. Compare them with what a node returns as numbers: nodes may drop leading zeros.
export const SEL = Object.freeze({
  Transfer: 0x0099cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9n,
  Approval: 0x0134692b230b9e1ffa39098904722134159652b09c5bc41d88d6698779d228ffn,
  balance_of: 0x035a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33n,
  balanceOf: 0x02e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76en,
  decimals: 0x004c4fb1ab068f6039d5780c68dd0fa2f8742cceb3426d19667778ca7f3518a9n,
  symbol: 0x0216b05c387bab9ac31918a3e61672f4618601f3c598a2f3f2710f37053e1ea4n,
  total_supply: 0x01557182e4359a1f0c6301278e8f5b35a776ab58d39892581e357578fb287836n,
  totalSupply: 0x0080aa9fdbfaf9615e4afc7f5f722e265daca5ccc655360fa5ccacf9c267936dn,
});
