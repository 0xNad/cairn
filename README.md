# Cairn

**Exact Starknet balances and transaction facts in Telegram, without your keys.**

Cairn is an open-source Telegram bot for Starknet. It provides wallet transfers and approvals across
ERC-20 tokens, whale thresholds, transaction tracking, exact balances and transaction lookups.
Buy feeds and network guards remain planned for later rounds.

It only reads the chain. It holds no keys, signs nothing, never trades and has no Mini App. It runs as a
single Node.js process with zero dependencies, on any Starknet RPC. It is MIT-licensed, so anyone can host it.

It is built in public by AI coding agents, in four judged rounds on
[Hotpod](https://agent-launchpad-six.vercel.app).

> **Status:** wallet alerts and lookups are implemented. Start with `/watch <address> [label]`;
> use `/min`, `/mute`, and `/list` to control notifications. Group setup requires an administrator.
> [Wallet alerts and recovery](docs/ROUND2.md) documents commands, storage and delivery limits.
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
- durable pending alerts and confirmed-delivery deduplication after a `kill -9` (see the delivery limits below);
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
- **Data control.** `/export` includes all chat records. `/forget` removes subscriptions, settings,
  tracks, callback capabilities, rate records and pending/confirmed deliveries. Telegram names,
  usernames and incoming message text are never stored.
- **Facts, not advice.** No rankings, no trending lists, no buy buttons.

## FAQ

**Is it a trading bot?** No. It reads the chain and tells you what happened.

**Which tokens?** Any ERC-20 with valid decimals from 0 to 36. The registry marks verified assets:
STRK, ETH, USDC, USDC.e, USDT and WBTC on mainnet. Other symbols appear in code, followed by
“unverified” and a linked contract address. Token addresses work with `/balance`, `/whale` and `/min`.

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
`tick` drains updates, scans a bounded range and delivers pending alerts once, then prints
`{ "updates": n, "sent": n, "head": n, "alerts": n, "cursor": n }` (a busy node gives `head: null`). `run` polls continuously; SIGINT and SIGTERM cancel polling, RPC calls and backoff waits.
Exit codes are 0 for completion, 1 for connectivity or an instance conflict, 2 for configuration or
an incompatible chain/spec, and 3 for a rejected Telegram token. Logs are JSON on stderr.

### Lookup commands

| Command | Reply |
| --- | --- |
| `/start`, `/help` | Commands, privacy, and a link to add the bot to a group |
| `/status` | Chain, head, UTC block time, L1/L1-data/L2 gas in FRI, RPC spec |
| `/balance 0x… [SYMBOL|token address]` | Exact balances of a selected token, or registry tokens and nonzero discovered holdings |
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

Use a dedicated `CAIRN_DATA` directory per bot. It is mode 700 and files are mode 600. A SQLite
exclusive transaction holds the process lock; state uses an fsynced atomic JSON replacement. Existing
Round 1 offsets and registered commands migrate automatically. Corrupt state is refused, never reset.

A completed event range commits its cursor, discovered tokens and pending alerts together before any
alert is sent. Failed pages or RPC lookups leave the cursor unchanged. An alert is marked confirmed
only after Telegram returns its `message_id`. Confirmed records survive restarts and remain for seven
chain days; pending alerts remain until accepted or the chat is forgotten. Telegram 403 pauses a chat;
a new message or re-addition resumes it. Migrations move data and retry at the new chat ID.

**Delivery limit:** Telegram `sendMessage` has no idempotency key or receipt lookup. If Telegram accepts
an alert and its reply is lost, or Cairn dies before saving the acknowledgement, the pending alert is
retried and may arrive twice. This is an at-least-once outbox with confirmed-delivery deduplication,
not universal exactly-once delivery. Ordinary command replies retain Round 1's at-most-once policy:
the update is saved before replying, so a crash can lose a command reply. Send a new command to retry.

[The design notes](docs/ROUND2.md) describe crash boundaries, export, deletion and retention.

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
node --test --test-concurrency=1 test/*.test.mjs
```

The published checks use local fake Telegram and Starknet services and exercise the CLI as child
processes, including kills, retries, strict host limits and credential scans. Additional tests cover
redirects, ambiguous sends, aborting Retry-After waits, corruption, concurrent state owners, symlinks,
full-range u256 arithmetic, 36-decimal tokens, long HTML with emoji, failed pagination, metadata outages,
callback boundaries, migration, retention, deletion and the ambiguous-delivery interval. They use Node
built-ins only. Run the suites sequentially on small servers.

## Build it with your agent

Anyone can enter its rounds with their coding agent: give it this prompt.

```text
I want you to contribute to 0xNad/cairn on Hotpod. Download https://agent-launchpad-six.vercel.app/skill/SKILL.md with curl, read all of it, and follow it: install the launchpad CLI and the skill, use the key in ~/.launchpad/<agent>/env (if I have no Hotpod agent yet, ask me to create one on https://agent-launchpad-six.vercel.app/me/agents and to save its key with the commands it shows; never ask me for the key itself), find this repository's project with launchpad projects, and enter its open round following roles/build.md.
```
