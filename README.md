# Cairn

A self-hosted, read-only Telegram bot for Starknet. Round 1 implements public
lookups in private chats and groups, using Node.js 24 built-ins with no dependencies.
The interface and chain layouts are specified in [ARCHITECTURE.md](ARCHITECTURE.md).

## Run

Create a bot with [BotFather](https://t.me/BotFather). Copy `.env.example` to `.env`,
set the token and your RPC URL locally, and restrict that file to your user:

```sh
cp .env.example .env
chmod 600 .env
# Edit .env locally. Do not source an untrusted file.
set -a
. ./.env
set +a
node cairn.mjs doctor
node cairn.mjs run
```

Do not put secrets in CLI arguments. There are no flags. Keep one process and a
separate `CAIRN_DATA` directory per bot. `doctor` validates configuration and checks
Telegram identity, chain, RPC version and block number without creating state.

`run` removes any existing webhook without dropping updates, registers commands,
and long-polls. SIGINT/SIGTERM abort requests and backoff, then exit cleanly.
`tick` drains updates, confirms the saved offset, and prints exactly one JSON line:

```json
{"updates":3,"sent":3,"head":16314862}
```

On a node outage, `tick` still exits 0, reports `head:null`, and replies “Node busy”.
Configuration/chain/version errors exit 2, transport errors and conflicting
instances exit 1, and Telegram token rejection exits 3. Logs are JSON on stderr.

## Chat commands

| Command | Reply |
| --- | --- |
| `/start`, `/help` | Commands, privacy notice and group setup link |
| `/status` | Chain, head block, UTC time, L1/L1-data/L2 gas in FRI, RPC spec |
| `/balance <address>` | Every registered token in order, with exact decimal amounts |
| `/tx <hash>` | Finality, execution, block, fee in STRK, escaped revert reason and explorer link |

In groups use `/status` or `/status@your_bot_username`. Plain text, other bots'
commands and messages from bots are ignored. Invalid inputs explain the expected
format before making any lookup about them. Unknown commands point to `/help`.

Balances use the same block number as the pass header. An undeployed account can
still hold tokens; it is labelled accordingly. A failing token does not hide the
other balances. `balanceOf` is used only when `balance_of` returns error 21.
Amounts use BigInt, including both u256 limbs; no rounding or scientific notation.

On-chain facts, not financial advice. Public balances and transfers only.

## Configuration

| Variable | Default / rule |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Required; BotFather token |
| `TELEGRAM_API_ROOT` | `https://api.telegram.org`; HTTP(S) origin |
| `STARKNET_RPC_URL` | Required; HTTP(S) JSON-RPC endpoint |
| `CAIRN_CHAIN` | `SN_MAIN` or `SN_SEPOLIA` |
| `CAIRN_NETWORK_FILE` | `networks/<chain>.json` beside the entry point |
| `CAIRN_DATA` | `./data`, relative to the working directory |
| `CAIRN_EXPLORER_URL` | `https://voyager.online`; links only, never fetched |
| `CAIRN_POLL_MS` | `10000`, integer ≥50 |
| `CAIRN_TG_TIMEOUT` | `30`, integer 0–50 seconds |
| `CAIRN_RPC_RPS` | `5`, integer 1–100 |
| `CAIRN_RPC_TIMEOUT_MS` | `10000`, integer ≥100 |
| `CAIRN_LOG` | `info`; accepts `error`, `warn`, `info`, `debug` |

Currently only fatal error events are logged; quieter levels retain those errors.
For Sepolia also set `CAIRN_EXPLORER_URL=https://sepolia.voyager.online`.
Starter registries contain the official architecture's six mainnet and four
Sepolia tokens. Custom registries are validated completely before network access.

RPC admission uses a rolling window, counting retries. HTTP failures, timeouts and
malformed responses receive up to three attempts with exponential backoff and
`Retry-After` respected. Telegram 429 is resent once after `retry_after`; a blocked
chat is skipped. Responses normally arrive promptly, but low RPC limits, many
registry tokens and upstream retries can extend lookup latency.

## Security and durable state

Only the configured Telegram and RPC endpoints are contacted; redirects are
refused. The RPC client has an explicit read-only method allowlist. No chain
signing, wallets, Mini App, payments, telemetry or fallback endpoints exist.
Remote error descriptions are never logged. Outside text is escaped as HTML;
known secrets are redacted, and long replies split into independent valid messages.

State holds a schema version, bot id, update offset and registered command list.
It never stores message text, human names/usernames, tokens or RPC URLs. The data
directory is mode 700; state, temporary state and lock files are mode 600.
State is fsynced, atomically renamed and the directory fsynced before handling
each update. Symbolic links in data paths are refused. Corrupt state fails closed
instead of resetting offsets. Back up the data directory while the bot is stopped.

Delivery is **at-most-once** in this round: the durable update claim precedes any
reply. A SIGKILL after Telegram accepts a reply cannot cause a duplicate on restart.
A crash between the claim and acceptance can lose that reply. Telegram offers no
idempotency key or transaction with local state, so guaranteed exactly-once delivery
is not claimed. Ambiguous send failures are not retried. A dead process's PID lock
is recovered on restart; a live instance sharing the directory is refused.

## Development

```sh
node .launchpad/checks/round-1/run.mjs
node --test test/security.mjs
```

The official checks run the bot in child processes against loopback-only fake
Telegram/Starknet servers and a network trap. They require no real credentials.
Official files under `.launchpad/checks/` are unchanged. Additional security tests
exercise redirects, data-path symlinks, instance locking, cancellation, reflected
secrets and formatting boundaries.

Modules separate configuration, transport, commands, formatting and storage.
Later rounds can add a scanner and delivery ledger without changing the frozen
Round 1 interface. Wallet alerts, feeds, price/name lookups and network guards are
future-round features and are not implemented here.

For an entry's official gate, use the reviewed `gate.mjs` and the round's pinned
container image as described by Hotpod. Local check results are not a pinned gate
transcript. This checkout does not push, seal, reveal or submit anything.

MIT licensed.
