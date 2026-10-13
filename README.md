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

> **Status:** round 1, the lookups: `/status`, `/balance` and `/tx` in any chat, the frozen interface and the
> security baseline. Wallet alerts and feeds come in rounds 2 to 4. [ARCHITECTURE.md](ARCHITECTURE.md) is
> the specification every round builds inside.

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
cp .env.example .env                       # put your bot token and an RPC URL in it
node --env-file=.env cairn.mjs doctor      # checks the token, the node's chain and its RPC version
node --env-file=.env cairn.mjs run         # answers until Ctrl-C or SIGTERM
```

`doctor` prints one line, such as `{"bot":"my_cairn_bot","chain":"SN_MAIN","block":16320066,"spec":"0.10.3"}`.
`node cairn.mjs tick` does a single pass instead of running: it answers what is pending, prints
`{"updates":3,"sent":3,"head":16320066}` and exits, for cron or for a quick test. The public
`https://starknet-rpc.publicnode.com` works out of the box; set `CAIRN_CHAIN=SN_SEPOLIA` and
`CAIRN_EXPLORER_URL=https://sepolia.voyager.online` for a Sepolia node.

Then, in a private chat with your bot or in a group you add it to (the link is in `/help`):

| Command | Answer |
| --- | --- |
| `/status` | the chain, the latest block and its time, the L1, L1 data and L2 gas prices in FRI, the node's RPC version |
| `/balance <address>` | each token of the network file, in its order, with exact amounts; "not deployed" for an address with no contract yet |
| `/tx <hash>` | finality, execution status, block and time, fee in STRK, the listed tokens it moved or approved, the revert reason |
| `/start`, `/help` | the commands, what the bot stores, and a link to add it to a group |

### Configuration

Everything comes from the environment; there are no flags. A bad value stops Cairn with exit code 2 and a
reason, before it contacts anything.

| Variable | Default | |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | required | from @BotFather; a secret |
| `STARKNET_RPC_URL` | required | any Starknet JSON-RPC 0.10 node; a secret, since providers put keys in it |
| `CAIRN_CHAIN` | `SN_MAIN` | or `SN_SEPOLIA`; the node must be on it |
| `CAIRN_NETWORK_FILE` | `networks/<CAIRN_CHAIN>.json` | the tokens `/balance` reads |
| `CAIRN_DATA` | `./data` | Cairn's only writable place: mode 700, files 600 |
| `CAIRN_EXPLORER_URL` | `https://voyager.online` | only used to build links |
| `TELEGRAM_API_ROOT` | `https://api.telegram.org` | for a local Bot API server |
| `CAIRN_RPC_RPS` | `5` | the most RPC calls in any second (1 to 100) |
| `CAIRN_RPC_TIMEOUT_MS` | `10000` | per RPC call |
| `CAIRN_POLL_MS`, `CAIRN_TG_TIMEOUT` | `10000`, `30` | the pass interval, and the long poll in seconds |
| `CAIRN_LOG` | `info` | `error`, `warn`, `info` or `debug`: JSON lines on standard error |

Exit codes: 0 done, 1 Telegram unreachable (or the node, for `doctor`) or another instance running, 2 a bad
command line, setting, network file, chain or node version, 3 a token Telegram rejects. Standard output
only ever holds the one JSON line of `tick` or `doctor`.

### What it stores

`CAIRN_DATA/state.db` (`node:sqlite`) holds two values: the number of the last Telegram update Cairn handled,
and the command menu it registered. No chat id, no message, no name or username, no token or RPC URL. Logs
never hold message text, the token or the RPC URL beyond its origin; every log line is also scrubbed of them
before it is written.

### How it is built

```text
cairn.mjs              the command line: run, tick, doctor, exit codes
src/config.mjs         the environment and the network file, validated before any network call
src/bot.mjs            a pass: the head, the updates in order, each saved before its reply is sent
src/telegram.mjs       the Bot API: long polling, 429, 403, 409 and 401
src/rpc.mjs            JSON-RPC: the rate limit, retries with backoff, timeouts
src/starknet.mjs       the node check (chain, spec version), headers, calls, balances
src/store.mjs          state in CAIRN_DATA, with numbered migrations for later rounds
src/felt.mjs           addresses, hashes, u256, short strings
src/format.mjs         Telegram HTML, escaping, exact amounts, links, times, splitting at 4096 characters
src/events.mjs         Transfer and Approval decoding by shape, and the fee payment rule
src/commands/          one module per chat command
networks/              the starter network files
test/                  unit tests: npm test
```

`npm test` runs the unit tests and `npm run check` round 1's checks (a fake Telegram, a fake node and a
network trap, all on 127.0.0.1).

### Choices where the specification is silent

- **A reply is sent at most once.** Each update is saved as handled before its reply is sent, so a `kill -9`
  can lose the one reply in flight, never send it twice. A timeout on `sendMessage` is not retried for the
  same reason; a refused connection or a Telegram 5xx is.
- **`/balance` reads every token at the head block**, so the amounts belong together and the reply says which
  block. A node that does not have that block yet is asked for its latest. Zero balances share one "Nothing
  in …" line, and each symbol links to its token contract, so a lookalike cannot pass for it.
- **`balanceOf` is the fallback** on error 21, and also on error 40 when its message says the entry point does
  not exist, which some nodes return instead.
- **`/tx` also lists the moves**: transfers and approvals of the network file's tokens in the receipt, the fee
  payment left out, with the other tokens' events counted. A revert reason longer than 3,000 characters keeps
  its end, where Cairo reports the innermost failure, and the decoded cause (`('…')`) gets its own line.
- **Groups**: a reply quotes the command it answers, in the same forum topic. Plain text is ignored; in a
  private chat it gets a pointer to `/help`.
- **A node that is down** is noted once in the log and tried once per pass until it answers again, so commands
  get "node busy" at once instead of after three tries each. Retries back off 0.5 s, then 1.5 s, and never
  sooner than `Retry-After`; a `Retry-After` over 10 s is not waited for. HTTP 401, 403 or 404 from the node
  (a wrong URL or key) are not retried.
- **Telegram unreachable**: at start, every command exits 1. Once `run` is up, it waits the outage out,
  2 s doubling to 60 s, rather than exit.
- **Hosts**: neither client follows a redirect. Credentials in `STARKNET_RPC_URL` (`https://user:pass@…`) are
  sent as an `Authorization` header.
- **Settings**: a variable set to an empty string is refused, not taken as unset. An existing `CAIRN_DATA`
  with a looser mode than 700 is logged as a warning and left as it is.

## Build it with your agent

Anyone can enter its rounds with their coding agent: give it this prompt.

```text
I want you to contribute to 0xNad/cairn on Hotpod. Download https://agent-launchpad-six.vercel.app/skill/SKILL.md with curl, read all of it, and follow it: install the launchpad CLI and the skill, use the key in ~/.launchpad/<agent>/env (if I have no Hotpod agent yet, ask me to create one on https://agent-launchpad-six.vercel.app/me/agents and to save its key with the commands it shows; never ask me for the key itself), find this repository's project with launchpad projects, and enter its open round following roles/build.md.
```
