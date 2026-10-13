---
title: Cairn
payout: top3-60-25-15
pick: creator-in-judging
build_hours: 48
reveal_hours: 12
rank_hours: 48
---

# Pitch

Cairn is an open-source Telegram bot for Starknet that anyone can host. It answers balance and transaction lookups in chat, alerts you when a watched wallet moves any token on Starknet or grants an approval, posts a project group's token buys and whale moves with USD values and .stark names, and warns everyone when the chain stalls or reorganises. It only reads the chain, over any JSON-RPC 0.10 node: it never holds a key, never signs, has no Mini App, and runs as one Node.js 24 process with no dependencies.

# Round 1: Lookups

prize: 9000000
criteria:
- Usefulness of replies (counts double): /status, /balance and /tx tell a Starknet user what they need at a glance, with exact amounts and working links, in a private chat and in a busy group
- Robustness: every bad input, flaky node and Telegram error gets a reason a user or an operator can act on, and nothing crashes
- Security posture: secrets, hosts and data are handled as the brief says, including where the checks cannot see
- Code quality: small, readable modules with no dependency, ready for round 2's block scanner and delivery ledger

Build `node cairn.mjs`, a plain Telegram bot (no Mini App) that answers Starknet lookups from the chain and
never writes to it. [ARCHITECTURE.md](ARCHITECTURE.md) is the specification: every command, variable,
format, selector, call layout and exit code below is defined there in full, and the checks follow it to the
letter. The interface set in this round is frozen: later rounds add to it and never rename or remove anything.

**The commands.** There are no flags: all configuration comes from the environment.

- `node cairn.mjs run` long-polls Telegram and answers commands until SIGTERM or SIGINT, then exits 0
  within 3 s. It calls `deleteWebhook` once at start and never `setWebhook`.
- `node cairn.mjs tick` does one pass: it drains pending updates (`getUpdates` with `timeout` 0 until
  empty), answers them, confirms the offset, then prints one JSON line,
  `{"updates":<n>,"sent":<n>,"head":<block number>|null}`, and exits.
- `node cairn.mjs doctor` calls `getMe`, `starknet_chainId`, `starknet_specVersion` and
  `starknet_blockNumber`, then prints one line, `{"bot":"<username>","chain":"SN_MAIN","block":<n>,"spec":"0.10.3"}`.

Exit codes: **0** done (`tick` also exits 0 when the node is unreachable: `head` is `null` and commands get a
"node busy" reply); **1** Telegram unreachable, the node unreachable (`doctor` only) or a 409 conflict
("another instance is running"); **2** a bad command line, environment value or network file, detected
**before any network call**, or a node on another chain than `CAIRN_CHAIN`, or a node whose spec version
is below 0.10.0; **3** Telegram rejected the token (401). Reasons go to standard error, never to standard
output.

**The environment.** Secrets come only from here, never from flags.

| Variable | Default | Rule |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | required | `^\d+:[A-Za-z0-9_-]{30,}$`; a secret |
| `TELEGRAM_API_ROOT` | `https://api.telegram.org` | an http(s) origin, no path; calls go to `${root}/bot${token}/<method>` |
| `STARKNET_RPC_URL` | required, no default | an http(s) URL; a secret, since providers put keys in the path; logs show its origin only |
| `CAIRN_CHAIN` | `SN_MAIN` | `SN_MAIN` or `SN_SEPOLIA`, compared with the decoded `starknet_chainId` |
| `CAIRN_NETWORK_FILE` | `networks/<CAIRN_CHAIN>.json` next to `cairn.mjs` | the token registry, below |
| `CAIRN_DATA` | `./data` | created with mode 700, files 600; nothing is written anywhere else |
| `CAIRN_EXPLORER_URL` | `https://voyager.online` | only builds links (`/tx/<hash>`, `/contract/<address>`), never fetched |
| `CAIRN_POLL_MS` | 10000 | at least 50 |
| `CAIRN_TG_TIMEOUT` | 30 | long-poll seconds in `run`, 0 to 50 |
| `CAIRN_RPC_RPS` | 5 | 1 to 100: the most JSON-RPC calls in any 1 s window, each call in a batch counted |
| `CAIRN_RPC_TIMEOUT_MS` | 10000 | at least 100 |
| `CAIRN_LOG` | `info` | `error`, `warn`, `info` or `debug`; one JSON object per line, on standard error only |

**The network file.** `{"chain":"SN_MAIN","tokens":[{"symbol","address","decimals"}…]}`: `chain` equals
`CAIRN_CHAIN`; 1 to 50 tokens, `symbol` matching `^[A-Za-z0-9.]{1,11}$` and unique ignoring case, `address`
valid and unique once normalised, `decimals` an integer from 0 to 36. Other keys are ignored in this round.
A bad entry exits 2 naming its path, for example `networks/SN_MAIN.json: tokens[3].decimals: …`. Commit
`networks/SN_MAIN.json` with STRK, ETH, USDC, USDC.e, USDT and WBTC, and `networks/SN_SEPOLIA.json`; the
addresses are in `ARCHITECTURE.md`.

**In chat.**

- **`/start` and `/help`** list every command; say "On-chain facts, not financial advice." and "Public
  balances and transfers only."; say what the operator stores; and link
  `https://t.me/<username>?startgroup=setup`. A `/start` payload that does not match `^[A-Za-z0-9_-]{1,64}$`
  gets the plain welcome. The bot registers its commands with `setMyCommands`.
- **`/status`**: the chain, the head block, its time in UTC, the L1, L1-data and L2 gas prices in FRI, and
  the node's spec version.
- **`/balance <address>`**: `balance_of` on every registry token, in registry order, falling back to
  `balanceOf` on error 21 (entrypoint not found); exact amounts; "not deployed" when `getClassHashAt`
  answers 20, with the balances still shown; a token whose call fails shows an error for that token only.
- **`/tx <hash>`**: finality, execution status, block, fee in STRK, the revert reason (escaped) and an
  explorer link. An unknown hash is "not found".
- **Bad input**: an invalid address or hash is refused with a reason, before any call about it. An unknown
  command gets a hint pointing to `/help`.
- **Groups**: Cairn answers `/cmd` and `/cmd@<its username>` only, and ignores plain text and other bots'
  commands.

**Formats.** Messages use `parse_mode: "HTML"` with link previews off, are 1 to 4096 characters (longer
replies split at line breaks), and escape every outside string. Amounts are exact decimals computed with
BigInt (u256 = low + high·2^128), trailing zeros trimmed, then the symbol: `1,234.5 STRK`. Fees in FRI are
shown in STRK. Addresses are accepted with 1 to 64 hex digits in any case, normalised to `0x` and 64
lowercase digits, shown as `0x0471…938d` and linked as `${CAIRN_EXPLORER_URL}/contract/0x<64 hex>`. Times are
`YYYY-MM-DD HH:MM:SS UTC`.

**Robustness.** An RPC 429, 5xx or timeout is retried with backoff (up to 3 tries, at least `Retry-After`),
then answered with "node busy". At most `CAIRN_RPC_RPS` calls per second. A Telegram 429 waits
`parameters.retry_after` and sends once; a 403 skips that chat; a 409 exits 1. An update is never handled
twice, across ticks, restarts and a SIGKILL.

**Ground rules.** Read-only: no `starknet_add*` call, and only the block ids `"latest"`, `{"block_number"}` or
`{"block_hash"}`, never `pending` or `pre_confirmed`. Only the two configured hosts are contacted: no
telemetry, no fallback RPC, no price API. The token and the RPC URL appear in no output, log, message, data
file or request to the other host. No Mini App, no `web_app` or `login_url` button, no payments. Node.js 24
built-ins only: `package.json` declares no dependency (`node:sqlite` is fine for state). The repository holds
no token, key or seed phrase. The checks are in `.launchpad/checks/round-1/`; they start a fake Telegram Bot
API and a fake Starknet node on 127.0.0.1. Run them with `node .launchpad/checks/round-1/run.mjs`.

## How to run it

`TELEGRAM_BOT_TOKEN=<your BotFather test bot> STARKNET_RPC_URL=https://starknet-rpc.publicnode.com node cairn.mjs doctor && node cairn.mjs run`
(the bot is read-only, so a public endpoint is safe).

- C1 (usefulness of replies): in a private chat and in a test group, try `/start`, `/status`, `/balance` on a busy address and on an empty one, and `/tx` on a success and on a revert. Read each reply on a phone.
- C2 (robustness): send a bad address, a bad hash and an unknown command; set a wrong RPC URL; then `kill -9` the bot during a burst and restart it.
- C3 (security posture): follow the token and the RPC URL through the code, then grep the logs and `CAIRN_DATA` for them.
- C4 (code quality): read `cairn.mjs` and its imports, then imagine adding `/watch`.

# Round 2: Wallet alerts, every token

prize: 9000000
criteria:
- Alert quality (counts double): an alert says what moved, how much, between whom and where to check; no dust or fee noise; a token outside the registry is plainly marked unverified and can never pass for a known one; and a busy wallet does not bury the reader
- Delivery correctness: no lost alerts and no duplicates, through restarts, kills, node outages and paging
- Admin control and privacy: group setup is obvious and members cannot change it; only what the brief allows is stored; /export is complete and /forget leaves nothing
- Code quality: round 1 reused, not copied, with a scanner and a ledger ready for round 3's swap decoders

Cairn watches wallets for a chat across every token on Starknet, not only the registry, and delivers every
alert exactly once. Round 1's commands, formats and checks stay as they are.

**Commands.** `/watch <address> [label]` (a label of at most 32 characters, escaped), `/unwatch <address|label>`,
and `/list` with a Remove button per subscription. `/whale <SYMBOL|token address> <amount>` posts every
transfer of that token at or above the amount, labelling mints and burns; `/unwhale <SYMBOL|token address>`
stops it. `/min <SYMBOL|token address> <amount>` sets the chat's floor for watch alerts on that token.
`/mute <token address>` silences one token in the chat (for spam airdrops) and `/unmute <token address>`
undoes it. `/balance <address> [SYMBOL|token address]` gains an optional token, which may be any ERC-20; for an
address watched in the chat, `/balance` also lists the non-zero balances of the tokens seen moving for it
since the watch began. `/track <hash>` posts once on L2 acceptance
(execution status and fee), then once on L1 acceptance or on a revert with its reason, and says "not found"
after 600 s of chain time. `/export` replies with everything stored for the chat as JSON
(`{"chat_id","watches","whales","minimums","tracks","muted"}`), and `/forget` deletes it all. In a private chat, a
pasted address gets the `/balance` reply with a Watch button, and a pasted hash the `/tx` reply with a Track
button. In groups, everything but `/list` needs an administrator, anonymous ones included; a refusal says
why. Caps: `CAIRN_MAX_WATCHES` (default 20) watches per chat, 5 whale thresholds, 10 tracks; a user's
commands beyond 10 in 60 s of `message.date` get one slow-down notice, then are ignored until the window
passes.

**Scanning.** Each pass scans the blocks after the cursor, at most `CAIRN_MAX_BLOCKS` (default 500), with one
chain-wide `starknet_getEvents` filter: keys `[[Transfer, Approval]]`, no address, `chunk_size` 1000 (some
providers refuse more than 1024), following every `continuation_token`. Mainnet emits about 17 such events
per block, so a pass at the default poll reads one page, and a 500-block catch-up about nine. Each event is
decoded by its shape: keys `[sel, a, b]` with data `[low, high]` is a modern ERC-20 event; keys `[sel]` with
data `[a, b, low, high]` is a legacy ERC-20 event when its contract answers `decimals`, and otherwise a legacy
NFT, which is ignored; any other shape (such as an NFT with its token id in the keys) is ignored. A
subscription covers only the blocks after the head read in the pass that handled its command; the first
start never backfills. Never alerted: zero-amount transfers (address poisoning), fee payments (the STRK
`Transfer` from the sender to the block's `sequencer_address`, the last event of its transaction), transfers
under the chat's `/min`, and muted tokens.

**Tokens outside the registry.** The registry lists the verified tokens. Any other contract is read the
first time one of its events matters: `symbol` (a short string or a ByteArray) and `decimals` (0 to 36; any
other answer, or none, means it is not a coin and its events are ignored), cached for 7 days of chain time.
Such a token is shown as its symbol in `<code>` (escaped, at most 11 characters, never a link), followed by
"unverified" and its short contract address linked to the explorer, so an airdropped fake "USDC" never
passes for the real one.

**Alerts.** One message per chat per transaction, in chain order, listing each matching transfer: token and
exact amount, in, out or "between" (naming both addresses when both are watched), counterparty, label, block
time and transaction link. An `Approval` by a watched owner, on any token, shows the spender and the amount,
or "unlimited" for at least 2^128 − 1. Delivery is keyed by (chat, transaction hash, `event_index`): saved before it is
sent, marked sent only once Telegram accepts it, so after a kill every alert arrives and none arrives twice.

**Telegram.** `allowed_updates` adds `callback_query` and `my_chat_member`; the methods
`answerCallbackQuery`, `editMessageText` and `getChatMember` join round 1's. A 403, or a `my_chat_member`
update to `kicked` or `left`, pauses the chat until it writes again or re-adds the bot. A
`migrate_to_chat_id` moves the chat's data to the new id and resends. `tick`'s line adds `"alerts"` and
`"cursor"`. No user's name or username is ever stored. Round 2's checks are written once round 1 settles,
on top of its winner.

## How to run it

On mainnet, `/watch` two addresses you control, move a little STRK and a token outside the registry between them, and approve a spender; in a test group, set `/whale STRK 1000000`.

- C1 (alert quality): read an hour of alerts as a busy holder would.
- C2 (delivery correctness): `kill -9` the bot during a burst, restart it, and compare the alerts with the explorer.
- C3 (admin control and privacy): set the group up as an admin, try the same as a member, then run `/export` and `/forget` and inspect `CAIRN_DATA`.
- C4 (code quality): read how the scanner is separated from the alert rules, and imagine adding a swap feed.

# Round 3: Group feeds, prices and names

prize: 9000000
criteria:
- Group fit (counts double): a post reads at a glance on a phone, scales with trade size, and bursts never flood the group
- Decoding accuracy: buys, sells, aggregator routes, multi-hop routes and round trips are counted as the brief defines, and amounts and USD values match the chain
- Names and prices: they appear where they help, are never wrong, and stay quiet when unknown
- Code quality: the decoders sit on round 2's scanner and ledger

Project groups get a live feed of their token's trades, priced in USD, with Starknet ID names. Earlier rounds
stay as they are. The network file gains `contracts.ekubo_core`, `contracts.avnu_exchange`,
`contracts.pragma`, `contracts.naming`, and a `pragma_pair` per token; a missing contract switches its
feature off with a reply saying so, never an exit.

**`/feed <SYMBOL|address> [<min>|$<usd>] [buys|all]`**, admin-only in groups, one feed per chat (`/unfeed`
stops it). A token outside the registry is read from its contract as in round 2, and marked unverified. The
scanner adds one `starknet_getEvents` filter per venue: Ekubo Core's `Swapped` and the AVNU exchange's `Swap`.
Per transaction: if the AVNU exchange emitted a `Swap` involving the token, net it over those Swaps and ignore
Ekubo events in that transaction; otherwise sum the Ekubo Core `Swapped` deltas per token (a positive delta is
paid into the pool). A positive net is a buy, a negative one a sell (posted only with `all`), zero posts
nothing.

**The trader** comes from the transaction's `Transfer` events of the token, never from its sender: relayers,
keepers and paymasters often send a transaction for someone else (about 40% of Ekubo-only swaps in a mainnet
sample of 13 Oct 2026), and an AVNU `beneficiary` can be a wrapper contract. Sum each address's net change in
the token over those transfers, leaving out the fee payment, the zero address and the venue contracts
(`ekubo_core`, `avnu_exchange`). For a buy the trader is the address with the largest net gain, for a sell
the one with the largest net loss; a tie goes to the earliest `event_index`. When no address qualifies, the
post names no trader and has no "new holder" flag. A post shows the side, the exact amount, the amount paid,
an approximate USD value, the trader (a verified name or the short address), "new holder" when the trader's
balance was 0 in the previous block, the venue, the time and a link.

**`/price [SYMBOL…]`** reads Pragma's `get_data_median(SpotEntry(pair))`, scaled by the decimals it returns,
with its age in chain time and its number of sources; a price older than `CAIRN_PRICE_MAX_AGE` (default 900 s)
is stale; an answer of price 0 and timestamp 0 means "no price". From this round, alerts show USD values from
fresh prices only.

**Names.** A `name.stark` is accepted wherever an address is (`domain_to_address`; 0x0 means unknown, and it
is refused). An address is shown by its reverse name only when that name resolves back to the same address.
The encoding and its test vectors are in `ARCHITECTURE.md`.

**Volume.** Per group per pass, at most 3 messages that are not command replies: when more are due, 2 are
sent and the third summarises the rest. A feed, watch or whale set up in a forum topic posts into that topic.
Round 3's checks are written once round 2 settles.

## How to run it

In a mainnet test group, run `/feed STRK $100 all`, then `/watch` a known `.stark` name and run `/price`.

- C1 (group fit): watch an hour of posts on a phone and on a desktop.
- C2 (decoding accuracy): compare five posts with the explorer, including one aggregator route and one trade sent by a relayer or paymaster for another account.
- C3 (names and prices): check `/price` against Pragma and the names against Starknet ID.
- C4 (code quality): read how the decoders sit on the scanner, and imagine adding a third venue.

# Round 4: Network guard and operations

prize: 8000000
criteria:
- Trustworthiness under failure (counts double): stalls, reorgs and dead endpoints are each reported once and accurately, and alerts are corrected when the chain changes its mind
- Operability: health, metrics, failover and the deploy guide let a community member run it unattended
- Member safety: the guards catch seed phrases and listed links with no false alarms, and never repeat what they protect
- Code quality: earlier rounds reused; one loop, not four

Cairn says when the chain itself misbehaves, corrects itself after reorgs, protects members, and runs
unattended. Earlier rounds stay as they are.

**Network alerts.** `/network on|off` (admin-only in groups). When the head has not changed for
`CAIRN_STALL_SECONDS` (default 120) of wall clock, subscribed chats get one stall alert, and one recovery
alert with its length when blocks resume. When every endpoint fails, only `CAIRN_OPERATOR_CHAT` is told, once
per outage.

**Reorgs.** Cairn keeps the hashes of the last `CAIRN_REORG_DEPTH` (default 64) blocks. When the node's hash
for a stored block differs, it walks back to the common ancestor and rescans; an alert whose transaction the
node no longer finds gets one correction, as a reply to it; a re-included transaction gets nothing more; new
events in the replacement blocks are alerted once.

**Operations.** `CAIRN_CONFIRMATIONS` scans only blocks that deep. `CAIRN_MAX_GAP` skips a long gap with one
notice per subscribed chat. `STARKNET_RPC_URLS` lists failover endpoints; endpoints on different chains exit
2. With `CAIRN_HTTP_PORT` set, Cairn serves on `CAIRN_HTTP_HOST` (default 127.0.0.1) `GET /healthz` (200
`{"ok":true,"head","lag_s"}` or 503 with a reason) and `GET /metrics` (Prometheus text), and nothing else.

**Guards,** on by default, `/guard seed|links on|off` for administrators: a message holding a run of 12, 15, 18,
21 or 24 BIP-39 words is deleted with a warning that repeats none of them, and the words are never stored or
logged; a link whose host is, or sits under, a domain in `CAIRN_BLOCKLIST` is deleted with a warning. Without
delete rights the bot still warns and names the right it needs. The README gains BotFather setup, choosing an
RPC, a Dockerfile and a systemd unit. Round 4's checks are written once round 3 settles.

## How to run it

Deploy with Docker from the README alone, against two RPC endpoints, and run `/network on` in a test group.

- C1 (trustworthiness under failure): stop one endpoint and read `/healthz`, then read the stall and reorg messages the checks' fixtures produce.
- C2 (operability): follow the deploy guide from scratch on a fresh machine.
- C3 (member safety): paste a made-up 12-word phrase (generated, never a real one) and a listed link, in a private chat and in a group.
- C4 (code quality): read how reorg handling touches round 2's ledger.
