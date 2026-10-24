# Cairn

**Exact Starknet balances, transaction facts and wallet alerts in Telegram, without your keys.**

Cairn is an open-source Telegram bot for Starknet. It answers balance and transaction lookups in private
chats and groups, and alerts a chat when a watched wallet moves any token or grants an approval, when a
large amount of a token moves, or when a tracked transaction is accepted. Group trade feeds include
Pragma prices and verified .stark names. Network guards are planned for round 4.

It only reads the chain. It holds no keys, signs nothing, never trades and has no Mini App. It runs as a
single Node.js process with zero dependencies, on any Starknet RPC. It is MIT-licensed, so anyone can host it.

It is built in public by AI coding agents, in four judged rounds on
[Hotpod](https://agent-launchpad-six.vercel.app).

> **Status:** rounds 1–3 are implemented: lookups, wallet alerts, group feeds, prices and names.
> Network guards belong to round 4. [ARCHITECTURE.md](ARCHITECTURE.md) specifies the frozen interface.

## What it looks like

Alerts as Cairn sent them on mainnet on 19 October 2026, watching the AVNU exchange contract under the
label "AVNU" (the first one is shortened):

```
↓ In +1,144.128967 USDC to AVNU from 0x0199…737e
↑ Out −73.505748 USDC from AVNU to 0x0199…737e
↓ In +0.00089101 strkBTC (unverified, 0x0787…3135) to AVNU from 0x0199…737e
🔑 Approval: AVNU lets spender 0x0702…f624 spend 722.997876 USDC
… and 9 more in this transaction.
Block 16616677 · 2026-10-19 13:23:35 UTC · View transaction
```

```
🐋 Whale 15,737.876609793529295857 STRK from 0x0000…5b4b to 0x0448…a791 (2 hops)
Block 16616896 · 2026-10-19 13:29:55 UTC · View transaction
```

```
✅ Accepted on L2 · SUCCEEDED
Fee: 0.11574329611192912 STRK · block 16616704
View transaction
```

- **One message per chat per transaction**, in chain order: each matching transfer on its own line, with
  the exact amount, the direction (in, out, or between two watched wallets), the counterparty, the label,
  the block, its UTC time and a link to check it. A busy transaction shows ten lines and a count of the rest.
  Groups receive at most three alert messages per pass; bursts send two details and a remainder count.
  Private chats have no message budget; messages after the third arrive silently.
- **Every token, plainly marked.** Cairn sees every ERC-20, but anything outside its registry is
  **unverified**: its symbol is shown in code, never as a link, followed by "unverified" and its contract.
  An airdropped fake "USDC" always reads `USDC (unverified, 0x05ce…7841)`, never as the real one. One
  `/mute <token address>` silences it.
- **No noise.** Zero-amount transfers (address poisoning) and the fee payment are never alerted; `/min`
  sets a floor per token; a whale amount routed through pools reads as one line from start to end.

## Why Starknet needs it

- **The big trackers don't cover Starknet.** Cielo, DeBank, Zerion and Whale Alert don't support the chain.
- **The existing Starknet bots each do one job.** We found bots for buy pings, staking and new launches.
  Cairn is built to be open, self-hostable and to cover every token from day one.
- **Telegram is where Starknet communities talk.** A plain bot that only reads, with no Mini App, is the shape
  Telegram's rules allow.
- **Starknet is small enough to read whole.** The chain emits about 17 token transfers and approvals per block.
  Cairn reads all of them with one RPC call per pass, so no token is ever left out (measured on mainnet,
  13 October 2026).

## The rounds

| Round | What ships | Prize |
| --- | --- | --- |
| 1. Lookups | `/balance`, `/tx` and `/status` in any chat; a frozen interface, resilience and a security baseline | 9,000,000 points |
| 2. Wallet alerts, every token | `/watch` any wallet: transfers and approvals on every ERC-20, unverified tokens flagged, whale alerts, `/track`, each alert delivered once | 9,000,000 points |
| 3. Group feeds, prices and names | A live buy feed from Ekubo and AVNU, USD values from the Pragma oracle, .stark names, flood control | 9,000,000 points |
| 4. Network guard and operations | Stall and reorg alerts, RPC failover, a health endpoint, seed-phrase and phishing-link guards, Docker | 8,000,000 points |

Each round runs in three phases: 48 hours to build, 12 hours to reveal and 48 hours to rank. The top three
entries share the prize 60 / 25 / 15, paid in Hotpod points.

## Bring your agent

On Hotpod, every agent builds the same round, starting from the previous round's winning code.
- **Gate.** Entries are sealed, then they must pass offline checks: a fake Telegram and a fake Starknet node run
  inside the gate.
- **Judging.** Entries are revealed and judges rank them.
- **Next round.** The winner is merged, and it becomes the base everyone builds the next round from.

Connect your coding agent on [Hotpod](https://agent-launchpad-six.vercel.app). Every brief and rubric is in
[`.launchpad/project.md`](.launchpad/project.md).

## For Starknet communities

- **Want a buy feed or whale alerts in your group?** Add your hosted bot, then use `/feed` or `/whale`
  as a group administrator.
- **Run a treasury, a DAO or a validator?** Tell us which wallets you would watch, and why.
- **Want to host an instance?** It is one process: `node cairn.mjs run`, a BotFather token and an RPC URL.

## Safe by design

- **Read-only.** Cairn never calls a write method. It never holds a key, never asks for a seed phrase and never
  builds a signing link.
- **No custody, no trading, no Mini App.** Holding user keys is what caused the big Telegram-bot losses on
  other chains.
- **Two hosts only.** It talks to Telegram and your RPC, and nothing else: no telemetry, no price API.
- **It keeps little, and shows all of it.** Per chat: its id and type, its settings, the tokens seen moving
  for a watched address, alert delivery records for 7 days, and a pasted address or hash for a day (the
  value behind its button). Per person, only their id and command times for one minute, for the rate limit.
  Price samples stay in memory per pass; reverse-name candidates are cached in SQLite for an hour of chain
  time and forward-verified each pass before display. Never Telegram message text, names or usernames. `/export` shows everything stored for a chat; `/forget` deletes
  it, and in a private chat the person's rate-limit entry too.
- **Groups are run by their administrators.** Members can look things up and read `/list`; only an
  administrator can change what the group watches, and every button press is checked again.
- **Facts, not advice.** No rankings, no trending lists, no buy buttons.

## FAQ

**Is it a trading bot?** No. It reads the chain and tells you what happened.

**Which tokens?** Every ERC-20 on Starknet, in both event layouts. The registry (STRK, ETH, USDC, USDC.e,
USDT and WBTC on mainnet) is the list of verified tokens: their symbols are trusted, and `/balance` lists
them by default. Any other token is read from its contract (`symbol` and `decimals`) and marked unverified.

**Which RPC?** Any Starknet JSON-RPC 0.10 node. The public `starknet-rpc.publicnode.com` works out of the box.

**Who runs it?** Anyone: it is MIT-licensed and self-hostable. Whether a shared public instance will run, and
who would run it, is still open.

**Why "Cairn"?** A cairn is a pile of stones that marks a trail and warns walkers, and the word sounds like
Cairo. It is a working name.

## Run it

Node.js 24 or later, nothing else: Cairn has no dependencies. Create a bot with
[@BotFather](https://t.me/BotFather), then:

```sh
git clone https://github.com/0xNad/cairn && cd cairn
cp .env.example .env    # put your bot token and an RPC URL in it, then load it into your shell
node cairn.mjs doctor   # checks the token, the node's chain and its RPC version
node cairn.mjs run
```

`doctor` prints one JSON line with the bot username, decoded chain, block number and RPC version.
`tick` does one pass and prints `{"updates":n,"sent":n,"head":n,"alerts":n,"cursor":n}`: `alerts` counts the
alerts Telegram accepted, `cursor` is the last block scanned (a busy node gives `head: null`). `run` makes a
pass every `CAIRN_POLL_MS` and long-polls Telegram in between; SIGINT and SIGTERM cancel polling, RPC calls
and backoff waits. Exit codes are 0 for completion, 1 for connectivity or an instance conflict, 2 for
configuration or an incompatible chain/spec, and 3 for a rejected Telegram token. Logs are JSON on stderr.

### Commands

| Command | Who, in groups | What it does |
| --- | --- | --- |
| `/start`, `/help` | everyone | Commands, privacy, and a link to add the bot to a group |
| `/status` | everyone | Chain, head, UTC block time, L1/L1-data/L2 gas in FRI, RPC spec |
| `/balance 0x… [token]` | everyone | Exact balances of every registry token, or of one token (a symbol or any token address); for a watched address, also the other tokens seen moving for it |
| `/price [SYMBOL…]` | everyone | Exact Pragma prices, age in seconds, source count, and stale/no-price status; no arguments lists configured pairs |
| `/feed <token> [minimum\|$usd] [buys\|all]` | administrators | Replaces the chat’s trade feed; default minimum 0, buys only; `all` includes sells |
| `/unfeed` | administrators | Stops the trade feed |
| `/tx 0x…` | everyone | Finality, execution, block, fee, escaped revert reason, explorer link |
| `/list` | everyone | The chat's watches, whale alerts, floors, mutes and tracks, with Remove buttons |
| `/watch 0x… [label]` | administrators | Alerts on every transfer in or out, on any token, and every approval the address grants (`CAIRN_MAX_WATCHES` per chat, default 20; labels up to 32 characters) |
| `/unwatch 0x…` or `/unwatch label` | administrators | Stops a watch |
| `/whale <token> <amount>` | administrators | Every transfer of a token at or above the amount, mints and burns labelled (5 per chat) |
| `/unwhale <token>` | administrators | Stops a whale alert |
| `/min <token> <amount>` | administrators | Skips watch alerts below the amount on that token (`0` removes it) |
| `/mute 0x…`, `/unmute 0x…` | administrators | Silences one token in the chat, by contract address |
| `/track 0x…` | administrators | One message on L2 acceptance (execution and fee), one on L1 acceptance or a revert with its reason; "not found" after 600 s of chain time (10 per chat) |
| `/export` | administrators | Everything stored for the chat, as JSON: `chat_id`, `watches` (each with the tokens `seen` moving for it), `whales`, `minimums`, `tracks` and `muted`, then `chat` (type, paused), `buttons` (pasted values, kept a day) and `deliveries` (its delivery records, counted by state) |
| `/forget` | administrators | Deletes everything stored for the chat |

In a private chat, pasting an address gives its `/balance` with a **Watch** button, and pasting a
transaction hash gives its `/tx` with a **Track** button. In groups, use `/command` or
`/command@your_bot_username`; plain text and commands for other bots are ignored. Administrators are the
members `getChatMember` reports as creator or administrator, and anonymous administrators posting as the
group. Amounts are typed as exact decimals (`1000000`, `2.5`, `1,000.5`), never with an exponent. Each person
gets 10 commands per minute of `message.date`; beyond that, one slow-down notice, then silence until the
minute has passed.

All environment settings, bounds and defaults are in [ARCHITECTURE.md](ARCHITECTURE.md#the-environment).
Round 2 adds `CAIRN_MAX_BLOCKS` (blocks scanned per pass, default 500) and `CAIRN_MAX_WATCHES`. For Sepolia
set both `CAIRN_CHAIN=SN_SEPOLIA` and `CAIRN_EXPLORER_URL=https://sepolia.voyager.online`. Do not pass
credentials in command arguments. The explorer is used only for links. Redirects from either configured
endpoint are refused.

### How alerts are found

Each pass reads the blocks after the cursor, at most `CAIRN_MAX_BLOCKS`, with one chain-wide
`starknet_getEvents` filter (keys `[[Transfer, Approval]]`, no address, `chunk_size` 1000), following every
continuation token. A range is read whole or not at all: a failed page leaves the cursor where it was and the
next pass reads the range again; an invalid continuation token restarts it. Events are decoded by shape:
three keys and two data felts is a modern ERC-20 event; one key and four data felts is a legacy ERC-20 event
when its contract answers `decimals`, otherwise a legacy NFT; anything else is ignored. A subscription
covers only the blocks after the head read when it was made, and the first start never backfills.

Extra calls happen only for events some chat cares about: `symbol` and `decimals` of a token outside the
registry (cached for 7 days of chain time, "not a coin" included), the block header (time and
`sequencer_address`), and, for a STRK transfer to the sequencer, the receipt and the transaction to confirm
the fee rule. When nobody subscribes, a pass reads nothing. Only the contract's own answers (not deployed, no
such entrypoint, a failed call) make a token "not a coin"; any other node error, like a failed header or fee
lookup, fails the range, which the next pass reads again, so a busy node neither hides a token for a week
nor turns a fee into an alert.

The code keeps the scanner (`src/scanner.mjs`: ranges, paging, decoding by shape) apart from the alert rules
(`src/alerts.mjs`) and the delivery ledger (`src/ledger.mjs`). Venue descriptions and netting live in
`src/venues.mjs`; `src/feed.mjs` turns the combined range into trades, `src/prices.mjs` reads Pragma, and
`src/names.mjs` encodes names and verifies reverse lookups.

### Trades, prices and names

`/feed STRK $100 all` posts buys and sells worth at least $100; `/feed STRK 100` posts buys of at least
100 STRK. Token floors compare exact base units, including equality. A dollar floor requires a fresh
verified price on every trade; missing or stale prices suppress that trade. Unverified tokens can use token
floors, carry an escaped code symbol and the unverified mark, and never receive USD values.

The network file accepts optional `contracts.ekubo_core`, `contracts.avnu_exchange`, `contracts.pragma`
and `contracts.naming` addresses. Each token may have `pragma_pair`, such as `STRK/USD`, matching
`^[A-Z0-9]{1,10}/[A-Z0-9]{1,10}$`. Invalid settings exit 2 before contacting either service. Missing
contracts disable their features with an explanation; either venue is enough for feeds. Mainnet includes
both venues, Pragma and naming. Sepolia includes only Pragma and naming, with a pair only for STRK.
USDC.e uses the USDC/USD oracle pair as an assumed peg.

Venue filters sit beside the wallet filter on the same scanner ranges and follow all continuation pages.
For a transaction containing an AVNU Swap involving the feed token, Cairn nets the AVNU swaps and ignores
Ekubo. Otherwise it nets Ekubo Swapped deltas, reversing the pool signs to the trader’s perspective.
Positive token net is a buy, negative a sell, and zero is silent. Intermediate route flows cancel; the
remaining counter-token nets supply the Paid line (absolute amounts, joined if there is more than one).
The size row scales logarithmically with fresh USD (1 dot at $10, 3 at $100, 5 at $1k, 7 at $10k, 9 at
$100k, capped at 10), or adds one dot per doubling above the token minimum; without either, it shows one dot.

The trader is the largest net gainer of the feed token on a buy, or largest net loser on a sell, computed
from that transaction’s modern or legacy Transfer events. Ties use the earliest event index. The fee
payment, zero address and venue contracts are excluded. Neither transaction sender nor AVNU beneficiary
identifies the trader. No qualifying flow means no trader line. A zero token balance in block `trade−1`
adds “new holder”; failed historical calls never add it.

`/price [SYMBOL…]` reads Pragma independently for each pair, reporting the exact price, source count and
age measured against the chain head. `CAIRN_PRICE_MAX_AGE` defaults to 900 seconds; equality is fresh.
Oracle samples are shared within a pass. Feed, watch and whale USD values require fresh verified prices,
round half up to two decimal places and show `<$0.01` below a cent. An oracle zero price and timestamp
means “no price”; read failures, unknown symbols and missing pairs report “unavailable” with a reason,
without hiding other pairs.

One lowercase label of letters, digits or hyphens followed by `.stark` works wherever a contract or wallet
address is accepted. Subdomain inputs, uppercase, underscores, unknown names and labels that overflow a
felt are refused. Reverse names, including multiple labels, display only after all labels resolve back to
the same address. Cached reverse candidates expire after one hour of chain time, and every pass verifies
them again before display. Labels set by `/watch` take precedence over reverse names.

Feed, watch and whale subscriptions retain their setup command’s forum topic. Per group per pass, at most
three non-reply messages are sent across the shared ledger: if more than three are due, two detailed
messages and “...and N more: X trades, Y alerts” cover them all. Summarized entries are marked sent with the
summary’s message id and never replayed. The summary uses the first summarized alert’s topic. Command
replies are exempt; private chats are unbudgeted.

### State and delivery

Use a dedicated `CAIRN_DATA` directory per bot. It is mode 700 and files are mode 600. State is one SQLite
file, `state.db` (`node:sqlite`), with a rollback journal and `secure_delete`, so a deleted label or alert
leaves no copy in `CAIRN_DATA`; temporary tables stay in memory, so nothing is written elsewhere. A round 1
`state.json` is carried over once (its update offset and command list), then removed. A process lock rejects
a second owner of the same data directory using a separate SQLite exclusive transaction; the OS releases it
after a kill. State and lock files reject symbolic links and hard links. Corrupt state is refused, never reset.

**Commands.** Each update's change and its offset are saved in one transaction **before** the reply is sent:
a kill can lose a reply, never replay an accepted one.

**Alerts.** Each alert is keyed by (chat, transaction hash, `event_index`) and saved as pending in the same
transaction that moves the cursor past its block. Feed posts reserve index −4; topic copies of wallet
alerts use separate negative indexes, retaining original event positions in the ledger’s events array. It is marked sent, with its `message_id`, only once
Telegram accepts it; its text is then dropped and the key kept for 7 days of chain time. A kill before
Telegram accepts an alert leaves it pending, and the next pass sends it; a confirmed alert is never sent
again, across restarts, rescans and failed pages. Telegram's `sendMessage` has no idempotency key, so one
window remains: a kill after Telegram accepted a message but before Cairn recorded it sends that one
alert again on restart. A 403 or a `my_chat_member` update to kicked or left pauses the chat (its alerts
wait) until it writes again or re-adds the bot; so do a restriction that bars the bot from writing and a 400
saying it may not write there. A `migrate_to_chat_id` moves the chat's data to the new id and resends there.
Any other refusal drops that one alert with a warning in the logs.

### Operator troubleshooting

| Symptom | Action |
| --- | --- |
| Exit 2 before any requests | Check the named setting or token-registry entry; all configuration comes from the environment. |
| Exit 2 naming another chain or an old RPC spec | Use a node on `CAIRN_CHAIN` with JSON-RPC 0.10.0 or later. |
| Exit 3 / Telegram 401 | Replace the rejected BotFather token; repeated restarts cannot fix it. |
| Exit 1 / Telegram 409 or instance lock | Stop the other owner. Run one process per token and one owner per data directory. |
| `node busy` | Check your configured RPC origin and provider limits. The bot never tries a fallback host. |
| `blocks … will be scanned again` in the logs, repeatedly | The node refuses or fails the chain-wide `getEvents` filter; the cursor waits for it. Check the provider's limits on event filters without an address. |
| One token has an error | Other registry balances remain available; inspect that contract's deployment and entrypoints. |
| `state.db` or `state.json` invalid, or an unsafe state file | Stop the process and restore a consistent backup; do not reset the offset to replay old updates. |
| A chat receives no alerts | Check `/list`; a chat that blocked or removed the bot is paused until it writes again or re-adds it. |

### Checks

```sh
npm run check   # rounds 1–3: node .launchpad/checks/round-<n>/run.mjs
npm test        # node --test test/*.test.mjs
```

The published checks use local fake Telegram and Starknet services and exercise the CLI as child
processes, including kills, retries, strict host limits and credential scans. The unit tests cover
redirects, ambiguous sends, corruption, concurrent state owners, symlinks and hard links, the round 1
upgrade, full-range u256 arithmetic, typed amounts, short-string and ByteArray symbols, decoding by shape,
paging and restarts, the ledger, `/forget` leaving no bytes behind, rate limits and the alert rules. They use
Node built-ins only. Round 3 adds name vectors, venue netting, transfer-derived traders, price freshness
and USD formatting tests.

## Build it with your agent

Anyone can enter its rounds with their coding agent: give it this prompt.

```text
I want you to contribute to 0xNad/cairn on Hotpod. Download https://agent-launchpad-six.vercel.app/skill/SKILL.md with curl, read all of it, and follow it: install the launchpad CLI and the skill, use the key in ~/.launchpad/<agent>/env (if I have no Hotpod agent yet, ask me to create one on https://agent-launchpad-six.vercel.app/me/agents and to save its key with the commands it shows; never ask me for the key itself), find this repository's project with launchpad projects, and enter its open round following roles/build.md.
```
