# Cairn

Cairn is a self-hosted Telegram bot for public Starknet lookups. It runs as one Node.js 24 process with
no dependencies. It reads the chain without holding keys or signing transactions.

## Run

Create a Telegram bot with [BotFather](https://t.me/BotFather). In this checkout, copy `.env.example` to
`.env`, replace the placeholder token, and set your Starknet JSON-RPC endpoint. The node must report RPC
spec 0.10.0 or later.

```sh
cp .env.example .env
# Edit .env before continuing.
set -a
. ./.env
set +a
node cairn.mjs doctor
node cairn.mjs run
```

`doctor` checks the Telegram identity, chain and RPC version and prints one JSON line. `run` removes an
existing webhook without discarding pending updates, then long-polls until SIGTERM or SIGINT. Run only
one instance per bot token and data directory.

For a single pass, use `node cairn.mjs tick`. It drains pending updates, confirms the offset, and prints
`{"updates":0,"sent":0,"head":4200010}` with the actual counts and head. A node outage produces a null
head and a "Node busy" reply for chain lookups. The CLI takes no flags.

## In chat

| Command | Reply |
| --- | --- |
| `/start` or `/help` | Commands, privacy information and the link to add the bot to a group |
| `/status` | Chain, head block, UTC block time, three gas prices in FRI and RPC spec |
| `/balance <address>` | Exact balances of each token in the configured registry |
| `/tx <hash>` | Finality, execution status, block, fee in STRK, revert reason and explorer link |

In groups, use `/status` or `/status@your_bot_username`; lookups are open to all members. Plain text and
commands addressed to another bot are ignored. `/start` payloads receive the same welcome.

Balances use one block number throughout the lookup, retain every decimal, and include zero balances.
An undeployed address can hold tokens and still gets a balance reply. A token call failure affects only
that token's row. Long replies split into valid HTML messages with link previews disabled.

On-chain facts, not financial advice. Public balances and transfers only.

## Configuration

Configuration comes from environment variables and is validated before any network request.

| Variable | Default | Accepted value |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Required | BotFather token |
| `STARKNET_RPC_URL` | Required | HTTP(S) JSON-RPC URL |
| `TELEGRAM_API_ROOT` | `https://api.telegram.org` | HTTP(S) origin, no trailing slash or path |
| `CAIRN_CHAIN` | `SN_MAIN` | `SN_MAIN` or `SN_SEPOLIA` |
| `CAIRN_NETWORK_FILE` | `networks/<chain>.json` beside the entry point | JSON token registry |
| `CAIRN_DATA` | `./data` | Private state directory |
| `CAIRN_EXPLORER_URL` | `https://voyager.online` | HTTP(S) explorer base URL; only used for links |
| `CAIRN_POLL_MS` | `10000` | Head refresh interval in milliseconds, at least 50 |
| `CAIRN_TG_TIMEOUT` | `30` | Telegram long-poll timeout, 0–50 seconds |
| `CAIRN_RPC_RPS` | `5` | Maximum RPC calls per second, 1–100 |
| `CAIRN_RPC_TIMEOUT_MS` | `10000` | Timeout per RPC attempt, at least 100 milliseconds |
| `CAIRN_LOG` | `info` | `error`, `warn`, `info`, `debug`; fatal errors are JSON on stderr |

Numeric settings accept whole decimal digits only. URLs cannot contain user credentials or fragments.
For Sepolia, also set `CAIRN_EXPLORER_URL=https://sepolia.voyager.online`.

The mainnet registry contains STRK, ETH, native USDC, bridged USDC.e, USDT and WBTC. Sepolia contains STRK,
ETH, USDC and USDC.e. A custom registry contains `chain` and 1–50 `tokens`, each with a unique `symbol`,
unique `address` and integer `decimals` from 0 to 36. Tokens appear in file order. Invalid files report the
file and field to fix.

## Failure and restart behavior

RPC requests use a rolling rate limit. HTTP 429, server errors, malformed responses and connection
failures get up to three attempts with backoff, respecting `Retry-After`. Telegram rate limits use
`retry_after`; blocked chats are skipped. A Telegram conflict stops the process so the operator can
resolve the competing instance. Shutdown cancels requests and retry waits.

| Exit | Meaning |
| --- | --- |
| 0 | Completed, or stopped by SIGTERM/SIGINT |
| 1 | Telegram unavailable or conflicting instance, local state failure, or an unavailable node during `doctor` |
| 2 | Invalid command/configuration, wrong chain, or unsupported node spec |
| 3 | Telegram rejected the token |

State is an atomic, fsynced JSON snapshot in `CAIRN_DATA/state.json`. It stores only the next update
offset and the registered command list. The directory has mode 700 and its files mode 600. Cairn saves
the offset before sending a reply, so a handled update is not replayed after a crash. A crash between
that save and delivery can lose the reply; send the command again. Uncertain send outcomes are not
retried automatically. Keep the data directory when restarting.

Only the configured Telegram and RPC endpoints are fetched. Redirects are refused. Logs omit request
URLs and remote error bodies; displayed node text is escaped and known credential values are redacted.
Message text, names and usernames are not saved. Telegram and the selected RPC provider still receive
the requests needed to perform each lookup.

This release provides lookups only. Wallet alerts, feeds, prices, names, message guards and HTTP health
endpoints are not implemented. Large registries, slow nodes and low RPC rate limits increase response
time. Token balances are the registry contracts' reported values; Cairn does not assess those tokens.

## Verification

```sh
node scripts/proof.mjs /home/djizus/.launchpad/djAIzus/cairn-1/evidence
npm run check
```

The first command starts the actual CLI against local HTTP fakes and preserves commands, replies,
requests, connection records and state outside the repository. It checks exact lookup results and
restart behavior, including SIGKILL after an accepted reply and SIGTERM during a long poll. See
[PROOF.md](PROOF.md) for the evidence files and alternate destination.

The second command runs the complete round 1 checks. Both use Node built-ins and loopback connections;
no live bot token or RPC provider is needed. The frozen interface is in [ARCHITECTURE.md](ARCHITECTURE.md).
