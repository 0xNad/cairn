# Cairn trading

Wallet-connected, exact-input Starknet spot swaps. A normal companion website; no Telegram Mini App, server signer, wallet key, custody or automatic trading. The existing monitoring bot remains a dependency-free read-only process. This is a post-competition extension, not a change to the original four frozen rounds.

## User flow

1. Open the website directly or use `/trade`, `/buy STRK 100 USDC`, or `/sell STRK 100 USDC` in the configured Cairn bot. Buy spends 100 USDC; sell spends 100 STRK. Inputs are prefilled, never automatically submitted.
2. Connect a Starknet mainnet wallet. Ready and Braavos can be discovered through wallet-standard or their injected provider. Mobile users can use a wallet dapp browser; an ordinary Telegram in-app browser may not expose a wallet. No wallet is created or funded by Cairn.
3. Select the input token/amount and output token. Supported assets: STRK, ETH, native USDC, USDC.e, USDT and WBTC. Native and bridged USDC are different contracts and are never silently substituted.
4. Review exact input, estimated/minimum received, slippage, route, provider fee, network fee estimate and recipient. Cairn adds no integrator fee. A price impact above 1% requires explicit acknowledgement.
5. Approve in the wallet. One invocation contains the exact input-token approval and AVNU swap. The wallet handles fee estimation, signing, nonce and submission; Cairn's backend cannot submit a transaction.
6. Follow the receipt. Submitted/pre-confirmed is distinct from succeeded on L2, succeeded on L1, reverted and unknown. Reverted transactions may still pay network fees.

## Design contract

`GET /` serves the bundled UI. `POST /api/config`, `/api/account`, `/api/quote`, `/api/receipt` accept bounded JSON; these are the entire backend surface. No generic RPC or arbitrary-URL proxy exists. Quote/build requests go only to AVNU's configured fixed mainnet origin. RPC requests use operator-configured endpoints and only read methods.

The API checks chain ID and a pinned AVNU Exchange implementation class hash before preparing a quote. It verifies both tokens, exact input, exact approval amount/spender, receiver, minimum output, zero integrator fee and full variable-length routing encoding. It permits only `approve` followed by `multi_route_swap`, with at most 4096 felts. The browser independently repeats the shared validation against its current inputs and wallet. Unknown contract versions fail closed until reviewed and updated.

Pinned Exchange: `0x04270219d365d6b017231b52e92b3fb5d7c8378b05e9abc97724537a80e93b0f`.
Observed implementation: `0x210cb6607c5d290d71584040936e0c429618c2d08765e5f7ccb71252595fb1b`, verified through two mainnet RPCs on 30 October 2026.

AVNU's custom `RouteSwapSerde` preserves legacy direct routes without an enum tag; a branch route begins with felt("branch"). Source reviewed at [1171398691fee1600aa456358c6a06c765d75913](https://github.com/avnu-labs/avnu-contracts-v2/blob/1171398691fee1600aa456358c6a06c765d75913/src/models.cairo). A normal Cairo enum decoder would reject valid trades. AVNU build rounds minimum output down using integer arithmetic; the API and browser match the actual built value exactly.

Slippage is stored in basis points internally: default50 (0.5%), offered10/50/100. AVNU receives a fraction (0.005), never50 or100. The quote review expires after at most30 seconds and respects an earlier provider expiry. Input, account or network changes invalidate the review. Once the wallet prompt is open, its transaction cannot be recalled by the website; on-chain minimum received remains the execution bound, not a claimed enforceable timestamp deadline.

An unknown wallet response never triggers a retry. The UI blocks another trade until the user checks wallet activity. Known hashes remain in local history and can be refreshed after reload; L2 success is not described as Ethereum finality. A successful receipt is called a confirmed swap only when its AVNU event matches the reviewed owner, tokens, exact input, recipient and minimum output; an unrelated successful transaction is shown as unverified. Browser storage is convenience/recovery evidence, not a guarantee of global idempotency across other apps/devices. There is no background signing, session key, DCA, limit order, bridge, leverage or custody service.

## Privacy and operation

The bot's optional `CAIRN_TRADING_URL` is an HTTPS URL without a query/fragment. It only generates ordinary links, with token/amount inputs and no Telegram identity or signing authority. No Telegram user session is used. With the variable unset, original commands and network behavior are unchanged. The bot does not contact the trading backend.

The web service receives the wallet address to build quotes/read balances, and passes it to AVNU/RPC. No Telegram identity is linked. History stays in browser localStorage; clearing it does not remove public transactions or ordinary hosting-provider access logs. Never put keys or seed phrases in any configuration, URL, API body or log.

Environment: `CAIRN_TRADING_RPC_URLS` is an optional comma-separated server-only read RPC list; the default is PublicNode. `CAIRN_RELEASE` optionally identifies a local release; Vercel uses its Git metadata when available. There are no required paid services, WalletConnect project credentials or new smart contracts. Do not publish private RPC URLs to the browser bundle.

```sh
cd trading
npm ci --ignore-scripts
npm test
npm run build
npm run dev             # built app at http://127.0.0.1:8487
```

Vercel deploys this directory as a separate Vite project with Node API functions. Keep deployment protection off for its intended public production URL; do not remove protection on unrelated projects. Service failures do not stop the Mac-hosted monitoring bot. To disable new bot links, remove `CAIRN_TRADING_URL` and restart Cairn; to pause web trading, disable/roll back only the trading project. Existing approvals/transactions remain on-chain.

Request limiting is bounded per function instance, not a distributed anti-abuse guarantee. Monitor hosting usage, 429/503 rates, provider availability and unknown submissions. No paid capacity increase or fee sponsorship is enabled automatically. A browser/hosting compromise can still mislead users; wallet review, pinned dependencies, CSP and constrained calldata reduce risk but are not an independent security audit.

## Verification and release meaning

Automated checks cover exact arithmetic, captured real AVNU responses, adversarial field changes, spender/amount/recipient checks, custom routing serialization, quote expiry, chain/implementation changes, sanitized failures, request budgets and bot URL semantics. Browser QA uses an explicitly simulated wallet and receipt, with real read-only quote/build APIs. Those tests cannot prove a real wallet signature or a funded trade.

The owner explicitly reserved live testing. A real wallet's approval, submission and matching successful receipt remain the owner's release acceptance step. Do not report them as already completed. Physical mobile-wallet handoff is also a distinct manual check. No real trade is performed by the coding agent.

## Sources

- [AVNU quote API](https://docs.avnu.fi/api/swap/get-quotes)
- [AVNU build API](https://docs.avnu.fi/api/swap/build-swap)
- [AVNU contract source](https://github.com/avnu-labs/avnu-contracts-v2)
- [Starknet transaction lifecycle](https://docs.starknet.io/learn/protocol/transactions)
- [Starknet wallet discovery](https://github.com/starknet-io/get-starknet)
- [Telegram blockchain guidelines](https://core.telegram.org/bots/blockchain-guidelines): regular bots without a Mini App are exempt from the Mini App blockchain restrictions. The companion is not registered as a Telegram Mini App and does not load its SDK.
