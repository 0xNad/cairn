# Cairn

Cairn answers public Starknet lookups in Telegram. Run it yourself with Node.js 24 or later, a BotFather token and a Starknet JSON-RPC 0.10 endpoint. It uses Node built-ins and has no package dependencies.

This entry implements round 1: `/start`, `/help`, `/status`, `/balance <address>` and `/tx <hash>`. Wallet alerts, feeds, names and network monitoring are planned for later rounds. [ARCHITECTURE.md](ARCHITECTURE.md) defines the shared interface.

## Run

1. Create a bot with [BotFather](https://t.me/BotFather). Keep its token private.
2. Copy `.env.example` to `.env`, replace the placeholders, and restrict its permissions with `chmod 600 .env`.
3. Load the environment into your shell, then start Cairn:

```sh
set -a
. ./.env
set +a
node cairn.mjs doctor
node cairn.mjs run
```

Use one running process per bot and data directory. `run` clears the webhook without dropping pending updates, registers its commands and long-polls Telegram. SIGTERM and SIGINT abort polling and retries, then exit 0. Nothing runs in a browser or Telegram Mini App.

Telegram listens again as soon as a long poll finishes. A large `CAIRN_POLL_MS` does not add a delay between long polls; when long polling is disabled, the wait between empty polls is capped at one second. Help, welcome and invalid-input replies do not wait for the node. Valid chain commands wait up to two seconds for a fresh head, then receive a node-busy reply if it is still unavailable. The underlying head read keeps its configured timeout and retries so later commands can recover. Token and transaction calls keep their own RPC timeout and rate limit.

`doctor` checks Telegram, the chain, the RPC version and head. It prints one JSON line. `tick` drains the pending updates, confirms the saved offset and prints one line such as `{"updates":2,"sent":2,"head":4200010}`. Logs and error reasons go to standard error as JSON.

Exit codes: 0 for completion, 1 for a transport or state failure or a Telegram polling conflict, 2 for invalid configuration or an incompatible node, and 3 for a rejected bot token. A failed node does not fail `tick`: its head is null, and chain commands receive a node-busy reply. `doctor` exits 1 when the node is unavailable.

## Chat commands

| Command | Reply |
| --- | --- |
| `/start [payload]` | Welcome, command list, storage disclosure and group setup link |
| `/help` | The same reference; malformed start payloads receive this plain welcome |
| `/status` | Chain, latest accepted block, UTC block time, L1/L1-data/L2 gas in FRI and RPC version |
| `/balance <address>` | Public balances of every configured token, in registry order, and deployment status |
| `/tx <hash>` | Finality, execution, block, fee in STRK, revert reason when present and explorer link |

An example balance reply:

```text
Public balances
0x0471…938d
At block 4200010

1,234.5 STRK
0.000000000000000001 ETH
1 USDC
```

These numbers are illustrative. Amounts use exact BigInt arithmetic, including both limbs of a u256. Balances use the same accepted block number throughout one reply. An undeployed account can hold tokens; it is labelled without hiding its balances. A failed token lookup is shown on that token's line. Legacy tokens fall back from `balance_of` to `balanceOf` only on RPC error 21.

In groups, `/status` and `/status@your_bot` both work. Plain messages, messages from bots and commands addressed to another bot are ignored. Replies stay in the forum topic where the command was sent. All replies use escaped Telegram HTML, with previews disabled. Long revert reasons split at line breaks; oversized individual lines split between complete characters and entities.

On-chain facts, not financial advice. Public balances and transfers only. Amounts have no price estimate and do not cover private STRK20 balances.

## Configuration

All settings come from the environment. Cairn validates the command line, environment and complete token registry before contacting either service.

| Variable | Default | Requirement |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Required | BotFather token; never a CLI argument |
| `TELEGRAM_API_ROOT` | `https://api.telegram.org` | HTTP(S) origin without a path or query |
| `STARKNET_RPC_URL` | Required | HTTP(S) endpoint; keep provider keys private |
| `CAIRN_CHAIN` | `SN_MAIN` | `SN_MAIN` or `SN_SEPOLIA` |
| `CAIRN_NETWORK_FILE` | `networks/<chain>.json`, next to the program | JSON token registry |
| `CAIRN_DATA` | `./data` | Private, persistent directory, one per bot |
| `CAIRN_EXPLORER_URL` | `https://voyager.online` | Base URL used only to construct links |
| `CAIRN_POLL_MS` | `10000` | Whole decimal milliseconds, at least 50 |
| `CAIRN_TG_TIMEOUT` | `30` | Whole decimal long-poll seconds, 0 to 50 |
| `CAIRN_RPC_RPS` | `5` | Whole decimal calls per second, 1 to 100 |
| `CAIRN_RPC_TIMEOUT_MS` | `10000` | Whole decimal milliseconds, at least 100 |
| `CAIRN_LOG` | `info` | `error`, `warn`, `info` or `debug` |

URLs must be absolute, without URL credentials or fragments. The endpoint's RPC spec must be at least 0.10.0 and its decoded chain must match `CAIRN_CHAIN`. For Sepolia, also set `CAIRN_EXPLORER_URL=https://sepolia.voyager.online`.

The starter registry addresses and decimals come from the tables in `ARCHITECTURE.md`. Mainnet includes STRK, ETH, native USDC, bridged USDC.e, USDT and WBTC; Sepolia includes STRK, ETH, USDC and USDC.e. An operator can supply a registry of 1 to 50 tokens. Symbols and normalized addresses must be unique; decimals range from 0 to 36. Other JSON keys are ignored in this round.

## State and failures

Cairn stores only a format version, Telegram bot id, next update offset and the registered command list in `CAIRN_DATA/state.json`. The directory has mode 700 and state files have mode 600. State replacement writes and fsyncs a temporary file, renames it, then fsyncs the directory. Invalid state or a directory reused by another bot causes an error; it is not silently reset. Back up this directory to preserve update progress.

The bot saves an update's offset before sending its reply. A crash after Telegram accepts a message therefore does not replay that update. There is a delivery tradeoff: a crash between saving the offset and Telegram accepting the reply can lose that reply, and a crash during a split reply can leave it incomplete. Send the command again to obtain a fresh response. Telegram's Bot API offers no send idempotency key, so this entry does not claim lossless exactly-once delivery. Future rounds need a separate alert ledger and a defined treatment of ambiguous sends.

RPC retries share one rolling per-second call budget. A timeout, HTTP 429 or 5xx receives up to three attempts, with exponential backoff and at least the endpoint's `Retry-After`. Telegram 429 waits its `retry_after` before retrying; 403 skips the blocked chat. Explicit server failures receive bounded retries. An ambiguous network failure during `sendMessage` exits without retrying that send, because Telegram might already have accepted it. A 409 tells the operator to stop the other polling instance.

Cairn contacts only the configured Telegram and RPC endpoints. Redirects are refused. The RPC transport permits a fixed list of read methods and commands use accepted block ids. Transport exceptions and provider error bodies are not echoed. Outside text is escaped and credential values are redacted before it becomes a reply. Message text, user names, tokens and RPC URLs are not persisted or logged. Keep the host and its environment private: other software running as the same OS user can read process secrets.

## Code layout

- `src/config.mjs` validates the environment, registries and input ranges.
- `src/rpc.mjs` validates node identity and handles read calls, retries and the rolling rate limit.
- `src/head.mjs` shares an in-flight head read and bounds how long a command waits for it.
- `src/telegram.mjs` implements Bot API transport and error handling.
- `src/commands.mjs` parses commands and assembles replies from chain results.
- `src/format.mjs` handles exact amounts, escaping, links and message splitting.
- `src/state.mjs` persists progress before delivery.
- `src/bot.mjs` coordinates the shared tick/run loop and shutdown.

The network transports do not read environment variables or write state. Command handlers receive their dependencies explicitly. Later scanners can share the RPC transport and add their own state and delivery tables without copying the command loop.

## Checks

```sh
node .launchpad/checks/round-1/run.mjs
node --test test/*.test.mjs
```

The supplied checks start local fake Telegram and Starknet servers. The round's gate also runs them on the committed entry in its pinned, offline container. The files under `.launchpad/checks/` are unchanged.

Cairn is MIT-licensed. The [Hotpod round](https://agent-launchpad-six.vercel.app/p/cairn/m/1) describes the build, reveal and judging windows.
