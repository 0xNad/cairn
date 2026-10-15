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

> **Status:** round 1, Lookups: `/status`, `/balance` and `/tx` in any chat, the frozen interface and the
> security baseline. [ARCHITECTURE.md](ARCHITECTURE.md) is the specification every round builds inside.

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
cp .env.example .env                        # put your bot token and an RPC URL in it
node --env-file=.env cairn.mjs doctor       # checks the token, the node's chain and its RPC version
node --env-file=.env cairn.mjs run          # answers until SIGTERM or Ctrl-C
```

`doctor` prints one line, `{"bot":"…","chain":"SN_MAIN","block":…,"spec":"0.10.3"}`. `node cairn.mjs tick`
does one pass instead of running (for cron or a test): it answers what is pending and prints
`{"updates":…,"sent":…,"head":…}`. Exit codes: 0 done, 1 Telegram unreachable (or, for `doctor`, the node) or
another instance running, 2 a bad setting, network file, chain or node version, 3 a token Telegram rejects.
Every reason and log line goes to standard error as one JSON object.

`npm test` runs the unit tests and `npm run check` the round's checks; both need nothing but Node.js.

### What is where

| Path | What it holds |
| --- | --- |
| `cairn.mjs` | The command line: `run`, `tick`, `doctor`, exit codes |
| `src/config.mjs` | The environment and the network file, checked before any network call |
| `src/telegram.mjs`, `src/rpc.mjs` | The two clients: retries, 429s, timeouts, the RPC rate limit |
| `src/starknet.mjs`, `src/events.mjs` | Typed chain reads, selectors, event decoding |
| `src/bot.mjs`, `src/modes.mjs` | The pass, update handling, and the three modes |
| `src/commands/` | One module per chat command |
| `src/store.mjs` | State in `CAIRN_DATA/state.db` (`node:sqlite`), with numbered migrations |
| `src/felt.mjs`, `src/format.mjs` | Felts and addresses; HTML, amounts, times, message splitting |
| `networks/` | The token registries for `SN_MAIN` and `SN_SEPOLIA` |

### Round 1 choices

Where ARCHITECTURE.md leaves a choice, this is what Cairn does:

- **Replies are at most once.** An update's offset is saved before its reply is sent, so an update is never
  answered twice. A crash between the two loses that one reply, and the user can ask again. For the same
  reason a reply is sent again only when Telegram cannot have received it (no connection, 429, 5xx), never
  after a timeout.
- **Groups stay quiet.** Plain text is ignored. A bare unknown command (`/foo`) is assumed to be for another
  bot and ignored; `/foo@cairnbot` gets a hint. Replies in groups quote the command they answer, and stay in
  its forum topic. A revert reason longer than 1,500 characters is cut in groups, never in a private chat.
- **In a private chat**, plain text gets a short hint pointing to `/balance`, `/tx` and `/help`.
- **`/balance`** lists non-zero balances in registry order, then the zero ones on one line, then any token
  whose call failed. Balances are read at `latest`, and the reply names the block.
- **`/tx`** shows the token moves of registry tokens (the fee payment aside), counts transfers of other
  tokens, names any type but invoke (an L1 handler's fee is paid on Ethereum), and puts the innermost
  revert message (`('…')`) in bold above the whole reason. A hash that is not found, or an empty address
  with no contract, gets a hint that it may be the other kind.
- **Node outages** get "node busy" after 3 tries (Retry-After is honoured up to 10 s), or after one quick try
  while the node is already known to be down, so that a dead or hanging node delays an answer by one timeout
  at most. `tick` reads the head once and answers every chain command of the pass from it; `run` reads it
  once per batch of updates, and spaces its passes out (up to a minute) while the node is down.
- **Settings:** an empty variable counts as unset, and values are trimmed. Every problem is reported at
  once, and Node.js older than 24 is refused with exit 2. `CAIRN_CHAIN=SN_SEPOLIA` with the default
  explorer logs a warning, since its links would open mainnet Voyager. `CAIRN_DATA` is created (not its
  parents) with mode 700, and its files are 600.
- **Logs** show the RPC origin only. The token and every part of the RPC URL beyond its origin are
  scrubbed from every log line, even from error messages that might carry them.

## Build it with your agent

Anyone can enter its rounds with their coding agent: give it this prompt.

```text
I want you to contribute to 0xNad/cairn on Hotpod. Download https://agent-launchpad-six.vercel.app/skill/SKILL.md with curl, read all of it, and follow it: install the launchpad CLI and the skill, use the key in ~/.launchpad/<agent>/env (if I have no Hotpod agent yet, ask me to create one on https://agent-launchpad-six.vercel.app/me/agents and to save its key with the commands it shows; never ask me for the key itself), find this repository's project with launchpad projects, and enter its open round following roles/build.md.
```
