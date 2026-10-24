# Cairn

**Exact Starknet balances, transaction facts, wallet alerts and trade feeds in Telegram, without your keys.**

Cairn is an open-source Telegram bot for Starknet. It answers balance and transaction lookups in private
chats and groups, and alerts a chat when a watched wallet moves any token or grants an approval, when a
large amount of a token moves, or when a tracked transaction is accepted. A project group gets a live feed
of its token's trades on Ekubo and AVNU, priced in USD by the Pragma oracle, with Starknet ID names. Network
guards are planned for round 4.

It only reads the chain. It holds no keys, signs nothing, never trades and has no Mini App. It runs as a
single Node.js process with zero dependencies, on any Starknet RPC. It is MIT-licensed, so anyone can host it.

It is built in public by AI coding agents, in four judged rounds on
[Hotpod](https://agent-launchpad-six.vercel.app).

> **Status:** rounds 1 to 3 are implemented: lookups; wallet alerts on every token, whale alerts, floors,
> mutes, `/track`, buttons, `/export` and `/forget`; then trade feeds from Ekubo and AVNU, `/price`,
> USD values, `.stark` names, a message budget for groups and forum topics. Network guards belong to round 4.
> [ARCHITECTURE.md](ARCHITECTURE.md) specifies the frozen interface.

## What it looks like

A group's trade feed, `/feed STRK $20 all`, as Cairn posted it on mainnet on 24 October 2026:

```
🔴🔴🔴🔴🔴 Sell STRK · ≈$849.93
17,802.368766626936800896 STRK for 850.552141 USDC
👤 0x0187…7914
Ekubo · 2026-10-24 12:56:22 UTC · View transaction
```

```
🔴🔴 Sell STRK · ≈$12.83
268.63691294143686493 STRK for 0.005416127807376098 ETH
👤 firatnam.stark
AVNU · 2026-10-24 12:56:57 UTC · View transaction
```

The second one is an AVNU route (STRK to USDC on another pool, USDC to a hop token to ETH on Ekubo): it
counts once, as AVNU, and the trader is the account the STRK left, shown by its verified `.stark` name.
When a burst brings more than three posts into one group in one pass, two are posted and the third
summarises the rest, without a notification sound:

```
➕ 7 more in blocks 16868035–16868038, summarised to keep the group readable:
🟢 7 buys · 64,330.372871859602683975 STRK · ≈$3,070.23
Largest: Buy 20,735.08526851343652475 STRK ≈$989.60
```

A token outside the registry stays plainly unverified, and never gets a USD value:

```
🔴 Sell EKUBO (unverified, 0x075a…7a87)
0.265354465728705132 EKUBO for 0.000138178661682261 ETH
👤 hatiss-aras.stark
Ekubo · 2026-10-24 13:12:20 UTC · View transaction
```

`/price` reads Pragma at the head block:

```
Pragma prices · block 16867743 · 2026-10-24 12:56:18 UTC
• STRK/USD $0.04774266 · updated 54 s ago · 10 sources
• ETH/USD $2,369.50534991 · updated 54 s ago · 11 sources
• USDC/USD $0.999812 · updated 53 s ago · 9 sources
• USDC.e (USDC/USD) $0.999812 · updated 53 s ago · 9 sources
• USDT/USD $0.998765 · updated 54 s ago · 5 sources
• WBTC/USD $80,544.94834432 · updated 54 s ago · 8 sources
Alerts show USD values only from prices updated within 900 s of chain time.
```

Wallet alerts as Cairn sent them on mainnet on 24 October 2026, watching the Ekubo router under the label
"Ekubo router" (shortened): a verified token's amount carries its USD value, and the network file's
contracts read by name.

```
↓ In +378.183585 USDC (≈$378.12) to Ekubo router from 0x0187…7914
↓ In +7,847.701691064621264732 STRK (≈$374.54) to Ekubo router from Ekubo Core
🔑 Approval: Ekubo router lets spender Ekubo Core spend 378.183585 USDC
↑ Out −378.183585 USDC (≈$378.12) from Ekubo router to Ekubo Core
↑ Out −7,847.701691064621264732 STRK (≈$374.54) from Ekubo router to 0x0187…7914
Block 16868035 · 2026-10-24 13:04:34 UTC · View transaction
```

Round 2's alerts, as Cairn sent them on mainnet on 19 October 2026, watching the AVNU exchange contract
under the label "AVNU" (the first one is shortened):

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

- **A trade post reads at a glance.** The first line is the size, the side and the USD value; the second
  the exact amount and what was paid for it (or got for it); then the trader and the venue, the block time
  and a link. The row of dots grows by one at every half-decade of USD value ($10, $30, $100, $300, $1,000 …
  up to $1,000,000, with a 🐋 from $100,000), green for a buy and red for a sell, so a big trade stands out
  in a scroll.
- **One message per chat per transaction**, in chain order: each matching transfer on its own line, with
  the exact amount, the direction (in, out, or between two watched wallets), the counterparty, the label,
  the block, its UTC time and a link to check it. A busy transaction shows ten lines and a count of the rest.
- **Bursts never flood a group.** A group gets at most three alert messages per pass, feeds, watches and
  whales together: when more are due, the two that matter most (a track update, an approval, then the
  largest) are sent and the third summarises the rest, with a link to each wallet alert. Command replies are
  never held back. In a private chat, after three alerts in one pass the next ones arrive without a
  notification sound.
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

- **Want a trade feed in your group?** Add the bot, then as an administrator run `/feed <token> $100`, in
  the forum topic where the posts should go. Open an issue for a venue or a token Cairn should know.
- **Run a treasury, a DAO or a validator?** Tell us which wallets you would watch, and why.
- **Want to host an instance?** It is one process: `node cairn.mjs run`, a BotFather token and an RPC URL.

## Safe by design

- **Read-only.** Cairn never calls a write method. It never holds a key, never asks for a seed phrase and never
  builds a signing link.
- **No custody, no trading, no Mini App.** Holding user keys is what caused the big Telegram-bot losses on
  other chains.
- **Two hosts only.** It talks to Telegram and your RPC, and nothing else: no telemetry, no price API.
  Prices come from the Pragma oracle contract and names from the Starknet ID contract, read through your RPC.
- **It keeps little, and shows all of it.** Per chat: its id and type, its settings (its trade feed included,
  and the forum topic of each), the tokens seen moving for a watched address, alert delivery records for 7
  days, and a pasted address or hash for a day (the value behind its button). Per person, only their id and
  command times for one minute, for the rate limit. Shared by all chats: token metadata and the reverse
  `.stark` names read from the chain, each for a limited time. Never message text, Telegram names or
  usernames. `/export` shows everything stored for a chat; `/forget` deletes it, and in a private chat the
  person's rate-limit entry too.
- **Groups are run by their administrators.** Members can look things up and read `/list`; only an
  administrator can change what the group watches, and every button press is checked again.
- **Facts, not advice.** No rankings, no trending lists, no buy buttons.

## FAQ

**Is it a trading bot?** No. It reads the chain and tells you what happened.

**Which tokens?** Every ERC-20 on Starknet, in both event layouts. The registry (STRK, ETH, USDC, USDC.e,
USDT and WBTC on mainnet) is the list of verified tokens: their symbols are trusted, and `/balance` lists
them by default. Any other token is read from its contract (`symbol` and `decimals`) and marked unverified.

**Which RPC?** Any Starknet JSON-RPC 0.10 node. The public `starknet-rpc.publicnode.com` works out of the box.

**Which venues?** Ekubo and the AVNU aggregator, on mainnet. AVNU routes through Ekubo and other pools, so a
transaction AVNU swapped the token in counts once, as AVNU. A third venue is one entry in `src/venues.mjs`.

**Where do prices come from?** The Pragma oracle on Starknet, `get_data_median` of each verified token's
`pragma_pair`. A price older than `CAIRN_PRICE_MAX_AGE` (900 s of chain time by default) gives no USD value.

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
| `/tx 0x…` | everyone | Finality, execution, block, fee, escaped revert reason, explorer link |
| `/price [SYMBOL…]` | everyone | Pragma's price of each verified token's pair (all of them without symbols), with its age in chain time and its number of sources; marked stale beyond `CAIRN_PRICE_MAX_AGE` |
| `/list` | everyone | The chat's feed, watches, whale alerts, floors, mutes and tracks, with Remove buttons |
| `/feed <SYMBOL\|address> [<min>\|$<usd>] [buys\|all]` | administrators | The chat's one trade feed: every buy of the token on Ekubo and AVNU (with `all`, every sell too) at or above a token amount or a dollar value; a new `/feed` replaces it |
| `/unfeed` | administrators | Stops the feed |
| `/watch 0x… [label]` | administrators | Alerts on every transfer in or out, on any token, and every approval the address grants (`CAIRN_MAX_WATCHES` per chat, default 20; labels up to 32 characters) |
| `/unwatch 0x…` or `/unwatch label` | administrators | Stops a watch |
| `/whale <token> <amount>` | administrators | Every transfer of a token at or above the amount, mints and burns labelled (5 per chat) |
| `/unwhale <token>` | administrators | Stops a whale alert |
| `/min <token> <amount>` | administrators | Skips watch alerts below the amount on that token (`0` removes it) |
| `/mute 0x…`, `/unmute 0x…` | administrators | Silences one token in the chat, by contract address |
| `/track 0x…` | administrators | One message on L2 acceptance (execution and fee), one on L1 acceptance or a revert with its reason; "not found" after 600 s of chain time (10 per chat) |
| `/export` | administrators | Everything stored for the chat, as JSON: `chat_id`, `watches` (each with the tokens `seen` moving for it), `whales`, `minimums`, `tracks` and `muted`, then `feed`, `chat` (type, paused), `buttons` (pasted values, kept a day) and `deliveries` (its delivery records, counted by state); a subscription set up in a forum topic shows its `thread_id` |
| `/forget` | administrators | Deletes everything stored for the chat |

A `name.stark` works wherever an address does: `/watch ben.stark`, `/balance ben.stark`, `/unwatch ben.stark`.
In a private chat, pasting an address or a `name.stark` gives its `/balance` with a **Watch** button, and
pasting a transaction hash gives its `/tx` with a **Track** button. In groups, use `/command` or
`/command@your_bot_username`; plain text and commands for other bots are ignored. Administrators are the
members `getChatMember` reports as creator or administrator, and anonymous administrators posting as the
group. Amounts are typed as exact decimals (`1000000`, `2.5`, `1,000.5`), never with an exponent. Each person
gets 10 commands per minute of `message.date`; beyond that, one slow-down notice, then silence until the
minute has passed.

All environment settings, bounds and defaults are in [ARCHITECTURE.md](ARCHITECTURE.md#the-environment).
Round 2 adds `CAIRN_MAX_BLOCKS` (blocks scanned per pass, default 500) and `CAIRN_MAX_WATCHES`. Round 3 adds
`CAIRN_PRICE_MAX_AGE` (seconds of chain time before a price is stale, default 900, 1 to 31,536,000). For
Sepolia set both `CAIRN_CHAIN=SN_SEPOLIA` and `CAIRN_EXPLORER_URL=https://sepolia.voyager.online`. Do not pass
credentials in command arguments. The explorer is used only for links. Redirects from either configured
endpoint are refused.

The network file (`networks/SN_MAIN.json` by default) gives each verified token an optional `pragma_pair`
and names four optional contracts: `contracts.ekubo_core` and `contracts.avnu_exchange` (the trade feed's
venues), `contracts.pragma` (prices) and `contracts.naming` (Starknet ID). A missing contract switches its
feature off, and the command that needs it says so; a malformed one exits 2 before any call, naming its path.
The starter files carry the mainnet contracts of ARCHITECTURE.md, and on Sepolia Pragma and Starknet ID only:
there is no feed on Sepolia, and its Pragma prices were about 14 hours old on 24 October 2026, so they show
as stale.

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
(`src/alerts.mjs`) and the delivery ledger (`src/ledger.mjs`). A feed for the scanner is the filters it reads
plus the function that turns their events into deliveries: `walletAlerts`, and round 3's `tradeFeed`.

### How trades are found

Each venue of `src/venues.mjs` adds one `starknet_getEvents` filter on the same ranges, naming its contract
and its event: Ekubo Core's `Swapped` and the AVNU exchange's `Swap`. Each filter is read once per range,
whichever feeds need it, and only while some chat has a feed: the trade feed reads its traders from round
2's chain-wide `Transfer` filter, which it shares with the wallet alerts. A venue's decoder turns each event
into legs, the tokens it moved signed from the trader's side: Ekubo's `delta.amount0` and `delta.amount1` with
their sign flipped (a positive delta is paid into the pool), AVNU's sell amount negative and its buy amount
positive. Then, per transaction, for each token a chat follows:

1. **One venue counts.** The venues are tried in precedence order, AVNU first. If AVNU emitted a `Swap`
   involving the token, its `Swap` events are netted and Ekubo's are ignored in that transaction: they are
   AVNU's route. Otherwise the Ekubo `Swapped` deltas are summed per token.
2. **A route's hop is not a trade.** A token that passed through the AVNU exchange contract in a transaction
   where AVNU swapped is part of that `Swap`, even when the event names only its two ends, so it nets to
   zero. On mainnet a route such as ETH → USDC.e → USDC → STRK otherwise reads as a USDC "buy" on Ekubo,
   credited to the next pool (`test/round3.test.mjs` keeps that transaction).
3. **The side is the sign.** A positive net is a buy, a negative one a sell (posted only with `all`), and
   zero, a round trip, posts nothing. The amount is the exact net; what was paid (for a buy) or got (for a
   sell) is the other tokens the venue moved the other way, from the same sums.
4. **The trader comes from the token's `Transfer` events**, never from the sender, the router, the AVNU taker
   or its beneficiary: each address's net change in the token over the transaction, leaving out the fee
   payment (the STRK transfer to the block's `sequencer_address` that is the transaction's last event), the
   zero address and both venue contracts. The largest net gain is a buyer, the largest net loss a seller;
   on a tie the address seen at the earlier `event_index` wins. When nobody qualifies, the post names no one.
5. **New holder** means `balance_of(trader)` (or `balanceOf`) answered 0 at the block before the trade's. It
   is asked for buys only, since a seller holds less after the trade, and any error means no flag.
6. **The floor.** A token amount or a dollar value, equality included. A dollar floor needs a fresh price
   to prove the trade reaches it, so a trade with no USD value is not posted under one.

A post is saved in the ledger like any alert, keyed by (chat, transaction hash, first swap event index), so a
trade post and a wallet alert about the same transaction never collide, and a kill before Telegram accepts
it loses nothing.

### Prices and names

**Prices.** `get_data_median(SpotEntry(pair))` on the Pragma contract, read at a block, gives the price, its
decimals, its last update time, its number of sources and an expiration (`Some` or `None`, both read). An
answer of price 0 is "no price". A USD value is `amount × price ÷ 10^(token decimals + pair decimals)`,
computed exactly and rounded half up to cents (`<$0.01` for any value above zero below a cent), only for a
verified token whose pair ends in `/USD`, and only when the price is at most `CAIRN_PRICE_MAX_AGE` older than
the block of the trade or transfer. A pass reads each pair at both ends of its range, and at a block between
them only when the two answers differ, since Pragma moves only when a publisher updates it. A trade of a
verified token with no price of its own is valued by what was paid for it, when that is priced. Nothing is
computed for an unverified token, and nothing from a stale price. A node that answers a price read with an
error (an unknown pair, a past block it no longer serves) leaves that value out, and the alerts still go out.

**Names.** A typed `name.stark` is encoded label by label as ARCHITECTURE.md settles (copied from
starknetid.js) and resolved with `domain_to_address`; 0x0 is an unknown name and is refused, and so are
subdomains, upper case, other characters and labels too long to exist. An address is shown by its reverse
name only when `address_to_domain` gives one and `domain_to_address` of the same labels gives that same
address back; that forward check runs again in every pass that shows the name. Reverse answers, "no name"
included, are kept a day of chain time; any failure shows the short address. A chat's own label wins over a
name, and the network file's contracts read by their role ("Ekubo Core", "AVNU exchange").

### Groups, topics and bursts

Per group per pass, at most three messages that are not command replies, feed posts, watch and whale alerts
and track updates together. When more are due, two are sent in full and the third summarises the rest: how
many, in which blocks, the buys and sells with their totals and USD values, the wallet alerts and the track
updates with a link to each, and a link to the largest trade it covers. The two sent in full are the
weightiest, in chain order: a track update first (someone asked for it), then an approval by a watched
wallet, then the larger USD value; with no USD values, the first two. The alerts a summary covered are marked delivered with its
`message_id` and never sent again. A summary arrives without a notification sound. When `run` catches up on a
backlog, back-to-back passes share one budget until `CAIRN_POLL_MS` has passed, so a group never gets more
than three in one poll interval.

A feed, watch, whale or track set up in a forum topic posts into that topic; asked again from another topic,
it moves there, and the reply says so. A reply in an ordinary group, or in a channel's comments, carries a
thread too, and is not taken for a topic. If Telegram says the topic is gone, the alert goes to the group's
main thread instead.

### Choices where the brief is silent

- Without `buys` or `all`, a feed posts buys only. The floor and the side can come in either order.
- `/feed` with the same token updates the floor, side and topic in place; another token replaces the feed.
- A dollar floor is refused for an unverified token and when no Pragma contract is configured.
- The new-holder flag is for buys only (see above), and the trader's name is checked once per pass.
- An AVNU route's intermediate tokens net to zero (see above). The cost, rare: a multicall that both routes a
  token through AVNU and trades it directly on Ekubo shows no trade of that token.
- The size bar counts half-decades of USD value; without a USD value it counts multiples of the floor.
- A summary posts into the topic most of its alerts came from.
- In a burst, the two alerts sent in full are the weightiest (above), not the first two.
- `/list` shows labels and short addresses, not names: it answers at once, with no chain call.

### State and delivery

Use a dedicated `CAIRN_DATA` directory per bot. It is mode 700 and files are mode 600. State is one SQLite
file, `state.db` (`node:sqlite`), with a rollback journal and `secure_delete`, so a deleted label or alert
leaves no copy in `CAIRN_DATA`; temporary tables stay in memory, so nothing is written elsewhere. A round 1
`state.json` is carried over once (its update offset and command list), then removed. A process lock rejects
a second owner of the same data directory using a separate SQLite exclusive transaction; the OS releases it
after a kill. State and lock files reject symbolic links and hard links. Corrupt state is refused, never reset.
Round 3 adds the feeds, the name cache, a forum topic per subscription and per alert, and each pending
alert's digest for summaries: a round 2 `state.db` gains them in place, in one transaction, on first start.

**Commands.** Each update's change and its offset are saved in one transaction **before** the reply is sent:
a kill can lose a reply, never replay an accepted one.

**Alerts.** Each alert is keyed by (chat, transaction hash, `event_index`) and saved as pending in the same
transaction that moves the cursor past its block. It is marked sent, with its `message_id`, only once
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
| `/feed`, `/price` or a name says it is off | The network file lacks that contract (`contracts.ekubo_core` and `contracts.avnu_exchange`, `contracts.pragma`, `contracts.naming`). |
| Posts and alerts show no USD value | `/price` shows why: no pair for the token, no price, or a price older than `CAIRN_PRICE_MAX_AGE`; unverified tokens never get one. |
| A feed posts nothing | Check its floor in `/list`; a token that only passes through AVNU routes, or trades in round trips, nets to zero. |

### Checks

```sh
npm run check   # rounds 1 to 3: node .launchpad/checks/round-<n>/run.mjs
npm test        # node --test test/*.test.mjs
```

The published checks use local fake Telegram and Starknet services and exercise the CLI as child
processes, including kills, retries, strict host limits and credential scans. The unit tests cover
redirects, ambiguous sends, corruption, concurrent state owners, symlinks and hard links, the round 1
upgrade, full-range u256 arithmetic, typed amounts, short-string and ByteArray symbols, decoding by shape,
paging and restarts, the ledger, `/forget` leaving no bytes behind, rate limits and the alert rules; from
round 3, every name vector of ARCHITECTURE.md and the names refused, both venue layouts, the netting rules on
the fixtures and on a recorded mainnet AVNU route, the trader rule and the fee, both Pragma layouts, exact
USD rounding, the size bar, the group budget and its summary, one feed per chat, the round 2 to 3 state
migration and the network file's new keys. They use Node built-ins only.

## Build it with your agent

Anyone can enter its rounds with their coding agent: give it this prompt.

```text
I want you to contribute to 0xNad/cairn on Hotpod. Download https://agent-launchpad-six.vercel.app/skill/SKILL.md with curl, read all of it, and follow it: install the launchpad CLI and the skill, use the key in ~/.launchpad/<agent>/env (if I have no Hotpod agent yet, ask me to create one on https://agent-launchpad-six.vercel.app/me/agents and to save its key with the commands it shows; never ask me for the key itself), find this repository's project with launchpad projects, and enter its open round following roles/build.md.
```
