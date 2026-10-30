# Cairn trading inside Telegram

Post-competition custodial trading extension. Users create a dedicated wallet in the Cairn private chat, back up its key, fund its Starknet address, activate its account, then buy, sell and withdraw with inline buttons. The bot signs only after an explicit, user-bound confirmation. No browser wallet or Mini App is needed for this flow.

The ordinary website remains an optional, separate wallet-connected client. Telegram's blockchain Mini App rules restrict those apps to TON; ordinary bots without a Mini App are exempt. This implementation uses ordinary messages and callbacks, not a Mini App.

## Product flow

`/start` opens a compact home menu. Create wallet → back up key → deposit STRK → Activate → Buy/Sell → choose payment token, receive token and amount → review → Confirm. Position buttons start a sell flow; Withdraw asks for token, amount and a Starknet destination before another confirmation. Activity reconciles existing transactions, and confirmed/reverted results are delivered through the bot's durable delivery ledger.

Five commands appear in Telegram: start, trade, price, list, help. Existing command aliases remain compatible. In a trading-enabled instance, advanced monitoring settings and privacy are separate help panels. Pasting a supported token opens its trade setup; public addresses and hashes retain lookup behavior. Trading wallets are available only in private chats whose chat id equals the authenticated Telegram sender id.

Initial supported assets: STRK, ETH, native USDC, USDC.e, USDT and WBTC. This does not claim Banana Gun's memecoin coverage, sniping, limit orders or copy trading. Slippage is0.5%, Cairn trading fee0; AVNU fees and a maximum STRK network fee are shown before confirmation. No trade, deposit or withdrawal is initiated by a coding agent on a public chain.

## Keys and authority

Fresh Starknet-curve keys come from cryptographic randomness. The wallet address is computed with the pinned OpenZeppelin account v0.17.0 class `0x540d7f5ec7ecf317e68d48564934cb99259781b1ee3cedbbc37ec5337f8e688`, verified declared on mainnet. Creation itself is off-chain and free; deployment requires STRK and a separate confirmation.

The optional custody engine uses pinned Starknet.js10.8.0 in its own dependency directory. The original monitoring process needs no dependencies when custody is disabled. AES-256-GCM encrypts each key using fresh nonces and owner/address-bound associated data. Wallets and signed transactions live in private SQLite; the32-byte master key is a separate private file. Directory mode700; files600; symlink, owner and hard-link checks fail closed. Losing either database or master key is a recovery incident, never a reason to silently generate replacement keys.

This is local software custody, not a hardware-backed vault, MPC or independent security audit. The master key and encrypted database reside on the same host; compromise of that host/user can compromise wallets. The Telegram account is the user's trading authority. Keys are never placed in ordinary exports, logs or transaction-result messages. Back up key requires a short-lived, single-use owner-bound Reveal button. It deliberately reveals the key in the requesting user's Telegram private chat; that chat is not an end-to-end encrypted secret channel. The user is warned to save privately and tap Hide key. There is no claim of automatic deletion or one-time delivery across Telegram/server failures. Importing an existing primary-wallet key is not supported.

`/forget` removes monitoring settings, not a trading wallet or its recovery records. The privacy panel makes this distinction. Never delete a custody wallet merely because a chat unsubscribed from alerts.

## Transaction safety and recovery

Quotes come from the shared AVNU adapter. Both preparation and confirmation validate chain, pinned exchange implementation, token/amount/spender/recipient/minimum and routing calldata. Exact approval and swap are one invocation. The fee reservation includes STRK spent by the trade or withdrawal; the configured absolute network-fee ceiling defaults to5STRK. Signed resource bounds are checked against the reviewed cap.

Review intents are immutable, owned by a Telegram user and expire within30 seconds (or earlier with their quote). A database claim and unique in-flight index prevent duplicate confirmations or concurrent nonce use. Cancel/Home invalidates unsigned reviews. The signed invoke payload and locally computed hash are encrypted and durably saved before broadcasting. A timeout keeps that hash and blocks new transactions until reconciled; it never resubmits with a new nonce. A deployment's lost response is reconciled against the computed account address. A signing-stage crash fails closed and requires operator reconciliation; do not manually clear it until nonce/chain history has been checked.

Successful swaps require an AVNU event matching the reviewed input, token pair, recipient and minimum output. L2 confirmation is not Ethereum L1 finality. Activity can refresh an existing transaction. Terminal results enqueue into the original durable bot ledger; a separate acknowledged key prevents repeated result notifications after restart or the monitoring ledger's normal retention period.

## Run and operate

Node24.15.0 or compatible Node24:

```sh
npm ci --ignore-scripts --prefix custody
npm test --prefix custody
```

Set `CAIRN_CUSTODY=1` and the existing HTTPS `CAIRN_TRADING_URL` in the private Cairn env file. The bot stores custody under `CAIRN_DATA/custody`, separately from monitoring state. Restart with the existing installer after installing custody dependencies in the production checkout. No key exists for a user until they explicitly confirm wallet creation.

Before accepting funds, stop the bot and make a private, encrypted backup of both `custody/master.key` and `custody/vault.db` together. Never put either in Git, shared reports, support messages or normal logs. Restore both as a pair with their private permissions; preserve the monitoring state as well. Test restoration in an isolated directory without starting a second Telegram poller or enabling public-chain submission. Exported user keys are an additional recovery route. Preserve the Starknet address and account class with each key: Starknet accounts are contracts, and recovery must use this OpenZeppelin account address rather than assuming another wallet type derives the same address.

Emergency pause: stop the bot or disable custody and restart. Disabling it stops wallet access and new signing; it does not recover funds or remove already submitted transactions. Restore custody after investigation so users can withdraw. Never delete the vault or replace its master key as a repair. Do not change chain/account/router pins without fresh review.

## Evidence and limits

Unit tests cover encryption at rest, associated-data binding, restart recovery, missing-key failure, user-bound one-time confirmations, fee changes, wrong chain, lost broadcast response and duplicate prevention. Native UI tests cover wallet creation disclosure, group/other-user rejection and button-based trade setup.

The local devnet test creates an account, mints dummy funds, deploys the account, withdraws and executes an AVNU swap against a mainnet fork, verifying its receipt. Writes are constrained to localhost; public RPC access is read-only. Devnet0.10.1 needs a test-only adapter normalizing compressed legacy Cairo0 programs from the upstream0.10.3 RPC. Production code does not depend on this adapter or alter live RPC responses.

A funded owner trade on actual mainnet remains user-run acceptance. Successful tests, deployment and a healthy bot do not substitute for that acceptance or an independent custody security review.

Sources: [Banana Gun's published bot flow](https://blog.bananagun.io/blog/telegram-trading-bot-first-trade), [wallet creation/trading guide](https://blog.bananagun.io/blog/trade-solana-on-telegram), [Telegram blockchain rules](https://core.telegram.org/bots/blockchain-guidelines), [Starknet.js account creation](https://starknet-js.com/docs/10.8.0/guides/account/create_account/).
