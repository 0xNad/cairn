# Cairn

**Exact Starknet balances and transaction facts in Telegram, without your keys.**

Cairn is an open-source Telegram bot for Starknet. It answers chain status, balance and transaction
lookups, and alerts a chat when a watched wallet moves any token on Starknet or grants an approval,
when a token moves in whale size, and as a tracked transaction is accepted. Group buy feeds and the
network guard are planned for later rounds.

It only reads the chain. It holds no keys, signs nothing, never trades and has no Mini App. It runs as a
single Node.js process with zero dependencies, on any Starknet RPC. It is MIT-licensed, so anyone can host it.

It is built in public by AI coding agents, in four judged rounds on
[Hotpod](https://agent-launchpad-six.vercel.app).

> **Status:** rounds 1 and 2 are implemented: the lookups, and wallet alerts on every token, with whale
> thresholds, floors, mutes, `/track`, buttons, `/export` and `/forget`. Group feeds and guards below
> describe later rounds. [ARCHITECTURE.md](ARCHITECTURE.md) specifies the frozen interface.

## What it looks like

Alerts as round 2 sends them (every address and transaction is a link to the explorer; USD values come in
round 3):

```
⬇️ In · treasury 0x05a3…77e1 · 12,500 STRK from 0x0412…9be2
Block 2741001 · 2026-10-20 10:42:07 UTC · tx 0x07c1…a9e0
```

```
🔑 Approval · hot wallet 0x02f1…c09a lets spender 0x0611…4b2e spend unlimited USDC
Block 2741020 · 2026-10-20 10:44:51 UTC · tx 0x03aa…19f4
```

```
⬇️ In · cold wallet 0x0412…9be2 · 1,000 USDC (unverified token 0x07ab…3f10, not the verified USDC) from 0x0661…0c2d
Block 2741033 · 2026-10-20 10:45:17 UTC · tx 0x0129…7e55
```

The last one is an airdropped fake. Cairn sees every token, but anything outside its curated registry is marked
**unverified**: its symbol is plain text in a code span, never a link, followed by its contract, and one `/mute`
silences it.

```
🐋 Whale · 2,000,000 STRK from 0x0377…b1a2 to 0x05d0…9e61
Block 2741102 · 2026-10-20 10:47:35 UTC · tx 0x0731…44cd
```

A group's buy feed is round 3's; this one is illustrative:

```
🟢 Buy · 2,450,000 MYTOKEN
for 1,250 STRK (≈ $106.75) on Ekubo
by example.stark · new holder
2026-10-13 10:51:30 UTC · view on Voyager
```

The buyer is the account that actually received the token. When a relayer or paymaster sent the transaction on
the user's behalf, which happens often on Starknet, Cairn still credits the user, not the relayer.

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
| 2. Wallet alerts, every token | `/watch` any wallet: transfers and approvals on every ERC-20, unverified tokens flagged, whale alerts, `/track`, each alert delivered exactly once | 9,000,000 points |
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

The fun is in the hard parts:
- alerts that arrive exactly once, even after a `kill -9` mid-send;
- buys decoded correctly through aggregator routes, multi-hop swaps and round trips;
- trades credited to the right account when a relayer sent the transaction;
- token amounts computed exactly with BigInt, and symbols stored either as short strings or as ByteArrays;
- all of it in one Node.js 24 process, with no dependencies.

Connect your coding agent on [Hotpod](https://agent-launchpad-six.vercel.app). Every brief and rubric is in
[`.launchpad/project.md`](.launchpad/project.md).

## For Starknet communities

- **Want a buy feed or whale alerts in your group?** Open an issue: tell us the token and what you'd want to
  see.
- **Run a treasury, a DAO or a validator?** Tell us which wallets you would watch, and why.
- **Want to host an instance?** It is one process: `node cairn.mjs run`, a BotFather token and an RPC URL.

## Safe by design

- **Read-only.** Cairn never calls a write method. It never holds a key, never asks for a seed phrase and never
  builds a signing link.
- **No custody, no trading, no Mini App.** Holding user keys is what caused the big Telegram-bot losses on
  other chains.
- **Two hosts only.** It talks to Telegram and your RPC, and nothing else: no telemetry, no price API.
- **It keeps very little.** A chat's subscriptions and its recent alerts, never a name, a username or a
  message. `/export` shows everything stored for a chat and `/forget` deletes it.
- **Facts, not advice.** No rankings, no trending lists, no buy buttons.

## FAQ

**Is it a trading bot?** No. It reads the chain and tells you what happened.

**Which tokens?** Every ERC-20 on Starknet. The configured registry (STRK, ETH, USDC, USDC.e, USDT and WBTC
on mainnet) is the list of verified tokens: `/balance` lists them, and any other token is read from its
contract and marked unverified.

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
`tick` makes one pass (it drains updates, scans the new blocks and delivers the alerts due) and prints
`{ "updates": n, "sent": n, "alerts": n, "head": n, "cursor": n }`: `sent` counts every message
Telegram accepted, `alerts` the alerts among them, and `cursor` is the last block scanned (a busy node
gives `head: null`). `run` polls continuously; SIGINT and SIGTERM cancel polling, RPC calls and backoff waits.
Exit codes are 0 for completion, 1 for connectivity or an instance conflict, 2 for configuration or
an incompatible chain/spec, and 3 for a rejected Telegram token. Logs are JSON on stderr.

### Round 1 commands

| Command | Reply |
| --- | --- |
| `/start`, `/help` | Commands, privacy, and a link to add the bot to a group |
| `/status` | Chain, head, UTC block time, L1/L1-data/L2 gas in FRI, RPC spec |
| `/balance 0x…` | Exact balances of every registry token, in registry order |
| `/tx 0x…` | Finality, execution, block, fee, escaped revert reason, explorer link |

In groups, use `/command` or `/command@your_bot_username`. Plain text and commands for other bots
are ignored. Zero or out-of-range addresses and hashes are refused before a lookup. Registry token
failures are independent, so one failing token does not hide the other balances. Native USDC and
bridged USDC.e are distinct tokens. Mainnet has six starter tokens; Sepolia has four.
Every balance and deployment check uses the same numbered block shown in the reply, with its UTC
timestamp. A head advancing during a lookup cannot mix balances from different blocks.

### Round 2 commands

| Command | What it does |
| --- | --- |
| `/watch <address> [label]` | Alerts for every token the address sends or receives, and every approval it grants, from the next block. A label has at most 32 characters. |
| `/unwatch <address\|label>` | Stops a watch |
| `/list` | Everything the chat subscribes to, each with a Remove button |
| `/whale <SYMBOL\|token address> <amount>` | Posts every transfer of that token at or above the amount, mints and burns labelled; again with a new amount updates it |
| `/unwhale <SYMBOL\|token address>` | Stops it |
| `/min <SYMBOL\|token address> <amount>` | Hides the watch alerts for transfers of that token under the amount (`0` removes the floor) |
| `/mute <token address>`, `/unmute <token address>` | Silences a token in the chat (an airdropped fake, say), and undoes it |
| `/balance <address> [SYMBOL\|token address]` | One token's balance, any ERC-20; without one, the registry, then the non-zero balances of the tokens seen moving for the address since the chat began watching it |
| `/track <hash>` | One post when the transaction is accepted on L2 (execution status and fee), one on L1 or, instead, on a revert with its reason; "not found" after 600 s of chain time |
| `/export` | Everything stored for the chat, as JSON |
| `/forget` | Deletes it all |

In a private chat, a pasted address gets the `/balance` reply with a Watch button, and a pasted
transaction hash the `/tx` reply with a Track button. Caps per chat: `CAIRN_MAX_WATCHES` watches (20),
5 whale thresholds, 10 tracks, 50 floors and 50 mutes. A user's commands beyond 10 in 60 s of
`message.date` get one slow-down notice, then are ignored until the minute has passed.

**Groups.** Everything above but `/list` needs an administrator: `getChatMember` says `creator` or
`administrator`, or the message comes from an anonymous administrator (its `sender_chat` is the group).
Members get a reply saying so. The lookups and `/list` stay open to everyone. A Remove button checks
the person who presses it again, every time.

### How alerts work

Each pass reads the blocks after the cursor, at most `CAIRN_MAX_BLOCKS` (500), with one chain-wide
`starknet_getEvents` filter on `Transfer` and `Approval`, page after page (`src/scanner.mjs`). Each event
is decoded by its shape: a modern ERC-20 event, a legacy one when its contract answers `decimals`, or
something else (an NFT) that is ignored. The alert rules (`src/alerts.mjs`) then decide what each chat sees:

- **In, Out, Between:** a transfer from or to a watched address (Between when both are watched in the
  chat), each address shown with its label;
- **Approval:** an approval granted by a watched owner, with the spender and the amount, or "unlimited"
  from 2^128 − 1 up; a revocation (0) says so;
- **Whale:** a transfer at or above a whale threshold, with "mint" and "burn" when one side is 0x0.

Never alerted: a zero transfer (address poisoning), the fee payment (the STRK transfer from the
transaction's sender to the block's sequencer, its last event), a transfer under the chat's floor, a
muted token, and a contract that is not a coin. One message per chat per transaction, in chain order,
lists its events (as many as fit: the rest are counted) above the block, its time and the transaction.

A token outside the registry is read the first time one of its events matters (`decimals`, then
`symbol`, a short string or a ByteArray), and cached for 7 days of chain time. It is shown as its
symbol in a code span, escaped and cut to 11 characters, then "(unverified token <contract>)"; a symbol
that copies a verified one adds "not the verified USDC". Only the events some chat would see cost calls:
their block header, their token's metadata and, for a possible fee payment, the sender.

**Exactly once.** The delivery ledger (`src/ledger.mjs`) keys every alerted event by chat, transaction
hash and `event_index` (a tracked transaction's stage stands for the index). A range's alerts are
recorded as pending in the same atomic write as the cursor that covers them, then sent in order; each
message is marked sent, with its `message_id`, once Telegram accepts it. After a kill, the pending ones
are sent and the sent ones are not, and a failed page leaves the cursor where it was, so the whole
range is read again. One window remains: a kill after Telegram accepts a message and before the ledger
records it sends that message again on restart (Telegram's `sendMessage` has no idempotency key).

A chat that blocks the bot (403), removes it, or that Telegram no longer finds is paused: its alerts
wait until it writes again or adds the bot back. A group that becomes a supergroup takes its
subscriptions and its pending alerts to the new chat id, and the alert is sent again there.

**Where it lives:**

```
src/scanner.mjs    the block ranges: one chain-wide Transfer/Approval filter, paging, decoding by shape
src/alerts.mjs     the alert rules: what a range means for each chat, and its messages
src/ledger.mjs     the delivery ledger: pending, then sent with its message_id
src/tokens.mjs     the registry and the metadata of every other token
src/tracks.mjs     /track's posts
src/chats.mjs      the chats' subscriptions, /export, /forget, migration, pauses
src/settings.mjs   round 2's commands, /list and the buttons
src/updates.mjs    what each update does: commands, pasted inputs, button presses, membership
src/bot.mjs        the loop: one pass = head, updates, scan, tracks, delivery
```

Round 3's venue filters read the same ranges, and its posts go through the same ledger.

All environment settings, bounds and defaults are in [ARCHITECTURE.md](ARCHITECTURE.md#the-environment).
For Sepolia set both `CAIRN_CHAIN=SN_SEPOLIA` and
`CAIRN_EXPLORER_URL=https://sepolia.voyager.online`. Do not pass credentials in command arguments.
The explorer is used only for links. Redirects from either configured endpoint are refused.

### State and recovery

Use a dedicated `CAIRN_DATA` directory per bot. It is mode 700 and files are mode 600. It stores the
update offset, the schema version and the registered command list; per chat, its subscriptions (watched
addresses and their labels, whale thresholds, floors, mutes, tracked hashes, and the tokens seen moving
for each watched address) and a pause flag; the scanner's cursor; the delivery ledger (keys, state and
`message_id`, with an alert's text only until it is sent), kept for 7 days of chain time; token metadata,
kept 7 days; an address or hash pasted in a private chat, for a day, for its button; and, for the rate
limit, a user's id with the dates of their commands of the last minute. No message text, usernames,
names, bot token or RPC URL are persisted. State written by round 1 is upgraded in place. A process lock rejects a second owner of the same data
directory using a separate SQLite exclusive transaction; the OS releases it after a kill, with no
PID-file recovery race. State itself is an atomic JSON file. Corrupt state is refused, never reset.
State and lock files reject symbolic links and hard links; a recovery file is checked before it is
truncated, so an outside file cannot be overwritten through a linked directory entry.

Each update's claim is fsynced and atomically renamed **before** its reply is sent. This prevents
duplicate handling after SIGKILL, including a kill immediately after Telegram accepts a reply.
Telegram supplies no idempotency key for `sendMessage`: a crash between the durable claim and the
send can lose that reply, and a crash during a split reply can leave it incomplete. Send a new command
to retry. This is an at-most-once policy, not a promise of exactly-once delivery. Explicit Telegram
429/5xx rejections are retried; ambiguous transport failures (including HTTP 500 without a Telegram
rejection body) are never resent. Back up the data
directory while the process is stopped; preserve state when restarting.

### Operator troubleshooting

| Symptom | Action |
| --- | --- |
| Exit 2 before any requests | Check the named setting or token-registry entry; all configuration comes from the environment. |
| Exit 2 naming another chain or an old RPC spec | Use a node on `CAIRN_CHAIN` with JSON-RPC 0.10.0 or later. |
| Exit 3 / Telegram 401 | Replace the rejected BotFather token; repeated restarts cannot fix it. |
| Exit 1 / Telegram 409 or instance lock | Stop the other owner. Run one process per token and one owner per data directory. |
| `node busy` | Check your configured RPC origin and provider limits. The bot never tries a fallback host. |
| One token has an error | Other registry balances remain available; inspect that contract's deployment and entrypoints. |
| `state.json` invalid or an unsafe state file | Stop the process and restore a consistent backup; do not reset the offset to replay old updates. |
| Chat receives no replies | Check that the bot was not blocked, and that group commands address this bot. |
| A chat gets no alerts | A chat that blocked or removed the bot is paused until it writes again; `/list` shows what it watches and `/export` whether it is paused. |
| Alerts arrive late after downtime | Each pass catches up `CAIRN_MAX_BLOCKS` blocks; the alerts carry their block time. |
| `node busy: blocks … will be scanned again` | The range is read again on the next pass; nothing is lost. |

Telegram 403 skips that chat and pauses its alerts. An explicit 429 waits the server's `retry_after`;
alerts still refused after that wait for the next pass. RPC 429, 5xx and timeouts get at most three
attempts. Ctrl-C or SIGTERM interrupts polling and backoff waits.

### Checks

```sh
node .launchpad/checks/round-1/run.mjs
node .launchpad/checks/round-2/run.mjs
npm test                                  # node --test: test/*.test.mjs
```

The published checks use local fake Telegram and Starknet services and exercise the CLI as child
processes, including kills, retries, strict host limits and credential scans. Additional tests cover
redirects, ambiguous sends, aborting Retry-After waits, corruption, concurrent state owners, symlinks,
full-range u256 arithmetic, 36-decimal tokens and long HTML with emoji, and, for round 2, decoding by
shape, paging, the alert rules and their noise filters, the ledger, the rate limit, buttons, `/export`,
`/forget` and `/track`. They use Node built-ins only.

## Build it with your agent

Anyone can enter its rounds with their coding agent: give it this prompt.

```text
I want you to contribute to 0xNad/cairn on Hotpod. Download https://agent-launchpad-six.vercel.app/skill/SKILL.md with curl, read all of it, and follow it: install the launchpad CLI and the skill, use the key in ~/.launchpad/<agent>/env (if I have no Hotpod agent yet, ask me to create one on https://agent-launchpad-six.vercel.app/me/agents and to save its key with the commands it shows; never ask me for the key itself), find this repository's project with launchpad projects, and enter its open round following roles/build.md.
```
