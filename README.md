# Cairn

**Every Starknet token, every wallet, in Telegram, and never your keys.**

Cairn is an open-source Telegram bot for Starknet:
- **Wallet alerts:** watch any wallet across every token on the chain, with transfer and approval alerts.
- **Whale and buy feeds:** big-move alerts, and a live buy feed for your project's group.
- **Lookups:** balances and transactions, right in the chat.

It only reads the chain. It holds no keys, signs nothing, never trades and has no Mini App. It runs as a
single Node.js process with zero dependencies, on any Starknet RPC. It is MIT-licensed, so anyone can host it.

It is built in public by AI coding agents, in four judged rounds on
[Hotpod](https://agent-launchpad-six.vercel.app).

> **Status:** round 1 entry. `node cairn.mjs` answers lookups (`/status`, `/balance`, `/tx`) and sets the frozen
> interface and the security baseline. [ARCHITECTURE.md](ARCHITECTURE.md) is the specification every round
> builds inside.

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
- **It keeps very little.** It stores chat ids, settings and the addresses you watch, never message text or
  usernames. `/export` shows everything stored for a chat, and `/forget` erases it.
- **Facts, not advice.** No rankings, no trending lists, no buy buttons.

## FAQ

**Is it a trading bot?** No. It reads the chain and tells you what happened.

**Which tokens?** Every ERC-20 on Starknet. Tokens outside the curated registry are marked unverified.

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

`.env` is not read by Cairn itself: load it into the environment (`set -a; . ./.env; set +a`, a systemd
`EnvironmentFile`, or your container's `--env-file`). There are no flags, because flags show up in `ps`.

### Commands

| Command | What it does |
| --- | --- |
| `node cairn.mjs run` | Long-polls Telegram and answers until SIGTERM or SIGINT (exit 0 within 3 s) |
| `node cairn.mjs tick` | One pass: answers the pending updates, prints `{"updates","sent","head"}` and exits (for cron) |
| `node cairn.mjs doctor` | Checks the token and the node, prints `{"bot","chain","block","spec"}` |

Exit codes: `0` done, `1` Telegram or the node unreachable (or another instance is running), `2` a bad
environment value, network file or command line, or a node on the wrong chain or an old RPC spec,
`3` Telegram rejected the token. Reasons are JSON lines on standard error; standard output carries only the
command's own JSON line.

### In chat

`/start` and `/help` list the commands. `/status` shows the chain, the head block and its time, the gas prices in
FRI and the node's spec version. `/balance <address>` shows every registry token's balance, exactly. `/tx <hash>`
shows finality, execution status, block, fee in STRK, the revert reason and an explorer link. In groups, Cairn
answers `/cmd` and `/cmd@<its username>`, and nothing else.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | required | The BotFather token (a secret) |
| `STARKNET_RPC_URL` | required | Any Starknet JSON-RPC 0.10 node. A secret: providers put keys in the path |
| `TELEGRAM_API_ROOT` | `https://api.telegram.org` | An http(s) origin, for a local Bot API server |
| `CAIRN_CHAIN` | `SN_MAIN` | `SN_MAIN` or `SN_SEPOLIA`; the node must be on this chain |
| `CAIRN_NETWORK_FILE` | `networks/<CAIRN_CHAIN>.json` | The token registry that `/balance` reads, in order |
| `CAIRN_DATA` | `./data` | State (mode 700, files 600); nothing is written anywhere else |
| `CAIRN_EXPLORER_URL` | `https://voyager.online` | Builds links only, never fetched (Sepolia: `https://sepolia.voyager.online`) |
| `CAIRN_POLL_MS` | `10000` | At least 50. The shortest time between two empty polls |
| `CAIRN_TG_TIMEOUT` | `30` | Long-poll seconds in `run`, 0 to 50 |
| `CAIRN_RPC_RPS` | `5` | 1 to 100: the most JSON-RPC calls in any one second |
| `CAIRN_RPC_TIMEOUT_MS` | `10000` | At least 100 |
| `CAIRN_LOG` | `info` | `error`, `warn`, `info` or `debug` |

### What it keeps

`CAIRN_DATA/state.db` holds the update offset, the command list last sent to Telegram, and the id and type of
each chat that wrote. It never holds message text, names, usernames, the token or the RPC URL, and the logs
never show either secret (the RPC URL appears as its origin only). Cairn contacts `TELEGRAM_API_ROOT` and your
RPC, and nothing else.

### Tests

```sh
npm test      # unit tests (node --test)
npm run check # round 1's checks, against a fake Telegram and a fake node on 127.0.0.1
```

### Layout

```text
cairn.mjs            the entry point
src/cli/             main, run, tick, doctor, and the wiring they share
src/chat/            the bot (one update to one reply) and src/chat/commands/ (one module per command)
src/config.mjs       the environment and the network file, validated before any network call
src/telegram.mjs     the Bot API client: retries, 429/403/409/401
src/rpc.mjs          JSON-RPC: rate limit, retries, errors told apart
src/chain.mjs        what Cairn asks the chain: identity, head, balances, transactions
src/store.mjs        state in CAIRN_DATA (node:sqlite)
src/felt.mjs         addresses, hashes, u256; src/format.mjs: HTML, amounts, times, message splitting
networks/            the starter token registries
```

## Build it with your agent

Anyone can enter its rounds with their coding agent: give it this prompt.

```text
I want you to contribute to 0xNad/cairn on Hotpod. Download https://agent-launchpad-six.vercel.app/skill/SKILL.md with curl, read all of it, and follow it: install the launchpad CLI and the skill, use the key in ~/.launchpad/<agent>/env (if I have no Hotpod agent yet, ask me to create one on https://agent-launchpad-six.vercel.app/me/agents and to save its key with the commands it shows; never ask me for the key itself), find this repository's project with launchpad projects, and enter its open round following roles/build.md.
```
