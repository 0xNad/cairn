# Cairn

**Exact Starknet balances and transaction facts in Telegram, without your keys.**

Cairn is an open-source Telegram bot for Starknet. Round 1 provides chain status, registry token
balances and transaction lookups in private chats and groups. Round 2 adds wallet alerts, whale
thresholds, arbitrary ERC-20 balances, approval alerts, transaction tracking and privacy controls.
Buy feeds and network guards remain on the roadmap.

It only reads the chain. It holds no keys, signs nothing, never trades and has no Mini App. It runs as a
single Node.js process with zero dependencies, on any Starknet RPC. It is MIT-licensed, so anyone can host it.

It is built in public by AI coding agents, in four judged rounds on
[Hotpod](https://agent-launchpad-six.vercel.app).

> **Status:** Round 1 lookups and Round 2 wallet alerts are implemented.
> Group trade feeds and network guards remain future rounds.
> [ARCHITECTURE.md](ARCHITECTURE.md) specifies the frozen interface.

## What it looks like

These messages are illustrative: the exact copy and layout are what the agents compete on.

```
⬇️ In · treasury
+12,500 STRK (≈ $1,067.50)
from 0x05a3…77e1
2026-10-13 10:42:07 UTC · view on Voyager
```

```
⚠️ Approval · hot wallet
Unlimited USDC to spender 0x02f1…c09a
2026-10-13 10:44:51 UTC · view on Voyager
```

```
⬇️ In · cold wallet
+1,000 USDC  unverified token 0x07ab…3f10
from 0x0412…9be2
```

The last one is an airdropped fake. Cairn sees every token, but anything outside its curated registry is marked
**unverified**: it shows no dollar value and no clickable symbol, and one `/mute` silences it.

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
| 2. Wallet alerts, every token | `/watch` any wallet: transfers and approvals on every ERC-20, unverified tokens flagged, whale alerts, `/track`, durable alerts with restart recovery | 9,000,000 points |
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
- durable alerts that recover after a kill; the ambiguous-send limit is documented below;
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
- **It keeps very little.** Round 1 stores only an update offset, schema version and registered command
  list. Round 2 adds chat settings, subscriptions, token metadata and a delivery ledger, with `/export` and `/forget`.
- **Facts, not advice.** No rankings, no trending lists, no buy buttons.

## FAQ

**Is it a trading bot?** No. It reads the chain and tells you what happened.

**Which tokens?** Round 1 reads every token in the configured registry: STRK, ETH, USDC, USDC.e, USDT
and WBTC on mainnet. Round 2 watches arbitrary ERC-20 tokens; their escaped symbol and contract link are explicitly marked unverified.

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
`tick` drains updates once and prints `{ "updates": n, "sent": n, "head": n }` (a busy node gives
`head: null`). Round 2 also reports `alerts` and the durable `cursor`. `run` polls continuously; SIGINT and SIGTERM cancel polling, RPC calls and backoff waits.
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

All environment settings, bounds and defaults are in [ARCHITECTURE.md](ARCHITECTURE.md#the-environment).
For Sepolia set both `CAIRN_CHAIN=SN_SEPOLIA` and
`CAIRN_EXPLORER_URL=https://sepolia.voyager.online`. Do not pass credentials in command arguments.
The explorer is used only for links. Redirects from either configured endpoint are refused.

### State and recovery

Use a dedicated `CAIRN_DATA` directory per bot. It is mode 700 and files are mode 600. Round 1 stores
only the update offset, schema version and registered command list. No message text, lookup inputs,
usernames, bot token or RPC URL are persisted. A process lock rejects a second owner of the same data
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

Telegram 403 skips that chat. An explicit 429 waits the server's `retry_after`; RPC 429, 5xx and
timeouts get at most three attempts. Ctrl-C or SIGTERM interrupts polling and backoff waits.

### Checks

```sh
node .launchpad/checks/round-1/run.mjs
node .launchpad/checks/round-2/run.mjs
node --test test/*.test.mjs
```

The published checks use local fake Telegram and Starknet services and exercise the CLI as child
processes, including kills, retries, strict host limits and credential scans. Additional tests cover
redirects, ambiguous sends, aborting Retry-After waits, corruption, concurrent state owners, symlinks,
full-range u256 arithmetic, 36-decimal tokens and long HTML with emoji. They use Node built-ins only.

## Build it with your agent

Anyone can enter its rounds with their coding agent: give it this prompt.

```text
I want you to contribute to 0xNad/cairn on Hotpod. Download https://agent-launchpad-six.vercel.app/skill/SKILL.md with curl, read all of it, and follow it: install the launchpad CLI and the skill, use the key in ~/.launchpad/<agent>/env (if I have no Hotpod agent yet, ask me to create one on https://agent-launchpad-six.vercel.app/me/agents and to save its key with the commands it shows; never ask me for the key itself), find this repository's project with launchpad projects, and enter its open round following roles/build.md.
```

## Wallet alerts and transaction tracking

In a private chat, use `/watch <address> [label]`, `/list` and `/unwatch <address|label>`.
`/list` has Remove buttons. A pasted address offers a balance and a Watch button; a known
transaction hash offers transaction details and a Track button. A Starknet address and hash are
both felts: a pasted value known to the node as a transaction is treated as a hash; otherwise it is
an address. Explicit `/balance` and `/tx` remove that ambiguity.

`/whale <symbol|token address> <amount>` watches transfers at or above a threshold, including mints
and burns. `/unwhale` stops it. `/min <symbol|token address> <amount>` filters watched-wallet
transfers; `/mute <token address>` and `/unmute <token address>` control spam. Muting and floors
suppress notifications, while token discovery still records what moved for a watched wallet.
`/balance <address> [symbol|token address]` accepts any ERC-20; a watched wallet's default list also
includes nonzero balances of discovered tokens. Verified registry tokens and unknown contracts
with the same symbol stay distinct. Unknown symbols are escaped, truncated to eleven characters,
shown in code and explicitly labelled unverified. Their metadata expires in seven days of chain time.

`/track <hash>` reports L2 acceptance, then L1 acceptance, or a revert. An unknown transaction times
out after 600 seconds of chain time. Tracks are capped at ten, whale thresholds at five and watches
at `CAIRN_MAX_WATCHES` (default 20, range 1–200). Commands are limited per user across chats to ten
in sixty seconds of message time, with one slow-down notice per exhausted window.

Group configuration and `/export` and `/forget` require an administrator, including anonymous
administrators posting as the group. `/list` and the original lookup commands remain available to
members. Buttons recheck the clicking user's authority; the bot message's sender grants none.
`/export` returns JSON in one or more contiguous chunks, with watches, whales, minimums, tracks,
mutes, seen tokens and pause state. Numeric threshold values in the export are exact base-unit
strings. `/forget` deletes the chat's subscriptions, pending and confirmed deliveries, buttons and
rate state. It preserves other chats and the shared non-personal token cache.

### Scanner and delivery recovery

One chain-wide Transfer/Approval filter reads at most `CAIRN_MAX_BLOCKS` (default 500, range
1–10000) blocks per pass, following every continuation page. The first start and new subscriptions
never backfill. Paging and transient metadata failures retain the durable cursor. Only relevant
transactions need receipt reads; equal-looking events are matched to distinct receipt positions,
including nodes that omit event indexes. Amounts use BigInt throughout. Zero transfers, NFTs and
actual sequencer fee payments are suppressed.

Matching events form one transaction alert per chat, split only at Telegram's message limit.
The outbox is saved and fsynced before delivery. Each accepted chunk records its message id and
progress; confirmed chunks survive restarts without replay. Pending chunks retry after failures.
A 403 or removal pauses the chat; a new message or re-add resumes it. Chat migrations move settings,
callback ids and ledger keys to the new id. Confirmed ledger entries expire after seven chain days.

Telegram offers no sendMessage idempotency key. If it accepts a chunk and the process dies before
saving that acknowledgement, a later retry may duplicate the chunk. Durable retry avoids silently
abandoning pending alerts, but cannot guarantee exactly-once remote delivery in this ambiguous
interval. This differs from the original lookup replies' at-most-once update handling described above.

The new code is separated into `alert-values.mjs` (decoding and exact amounts), `alert-scanner.mjs`
(chain ranges and notification rules) and `round2.mjs` (commands, subscriptions and the delivery
ledger). The existing RPC, Telegram, formatting and durable store layers are reused.
