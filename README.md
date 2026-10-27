# Cairn

Cairn is a read-only Starknet Telegram bot, running on Node.js 24 with no npm dependencies.
It answers balance and transaction lookups, watches wallets, posts Ekubo and AVNU trades,
and reports chain stalls and transaction corrections. It never holds keys or signs transactions.

## Set up Telegram and RPC

1. In [BotFather](https://t.me/BotFather), run `/newbot` and save the token in `.env`.
   Keep this file private (`chmod 600 .env`); never put tokens in command arguments.
2. For group protection, use BotFather's `/setprivacy` → Disable, then remove and re-add
   the bot if it was already in the group. Cairn must receive ordinary messages to inspect them.
3. Add Cairn as a group administrator with **Delete messages** enabled. Without that right it
   warns about dangerous messages but cannot delete them. Group members can use lookups;
   administrators control subscriptions and guards. Private chats need no administrator setup.
4. Choose two independent Starknet JSON-RPC providers on the same chain, supporting spec 0.10.0
   or later and the chain-wide `getEvents` filter without a contract address. For older trade prices,
   choose providers that serve historical contract calls. Put both complete URLs in
   `STARKNET_RPC_URLS`, separated by a comma. Cairn tries them in order, stays with a working
   endpoint, and starts paginated ranges over after a switch. It validates each endpoint's chain
   before using it; a different chain exits 2. An unavailable endpoint is checked when next used.

From a checkout, with Node 24 installed:

```sh
cp .env.example .env
chmod 600 .env
# Edit .env: token, two RPC URLs, and optionally CAIRN_OPERATOR_CHAT.
set -a
. ./.env
set +a
node cairn.mjs doctor
node cairn.mjs run
```

`doctor` prints one JSON line with `bot`, `chain`, `block`, `spec`. In a test group, send
`/network on`, `/watch <address>`, and optionally `/feed STRK $100 all`. Use `/status` to check
connectivity and `/list` to inspect subscriptions. For Sepolia also set `CAIRN_CHAIN=SN_SEPOLIA`
and `CAIRN_EXPLORER_URL=https://sepolia.voyager.online`.

## Docker

Install Docker Engine on the host, then build from the checkout:

```sh
docker build -t cairn:local .
docker volume create cairn-data
docker run -d --name cairn --restart unless-stopped \
  --env-file .env -e CAIRN_DATA=/data \
  -v cairn-data:/data cairn:local
docker logs cairn
docker stop --time 3 cairn
```

The image runs as the `node` user. The named volume holds SQLite state across container replacements;
keep it when upgrading. For a bind mount, create the directory owned by uid 1000 and mode 700 first.
Do not run two containers with the same token or data directory.
To expose monitoring through Docker, set `CAIRN_HTTP_PORT=8080` and `CAIRN_HTTP_HOST=0.0.0.0`
in `.env`, and add `-p 127.0.0.1:8080:8080` to `docker run`.
For RPC fixtures running on the host, use their container-reachable addresses (on Linux, host networking
with `--network host` also permits their loopback addresses).

## systemd

Install Node 24 at `/usr/local/bin/node` (verify `node --version`), copy this checkout to `/opt/cairn`,
and create a dedicated service account. The unit sets `CAIRN_DATA=/var/lib/cairn` in `ExecStart`,
overriding the value in the environment file:

```sh
sudo useradd --system --home-dir /var/lib/cairn --shell /usr/sbin/nologin cairn
sudo install -m 600 .env /etc/cairn.env
sudo install -m 644 deploy/cairn.service /etc/systemd/system/cairn.service
sudo systemctl daemon-reload
sudo systemctl enable --now cairn
sudo journalctl -u cairn -f
sudo systemctl stop cairn
```

If Node is elsewhere, edit `ExecStart` in the unit first. SIGTERM and SIGINT abort polling, requests and
backoff, close HTTP and SQLite, and exit 0 within three seconds. Stop Cairn before backing up the data
directory. On upgrade, replace the code and restart; existing databases migrate in place.
Exit codes: 0 completed, 1 connectivity or instance conflict, 2 invalid configuration/chain/spec,
3 rejected Telegram token. The unit avoids restarting exits 2 and 3 until configuration is repaired.

## Configuration

All configuration comes from the environment; no command-line flags. RPC URLs and tokens are secrets.
Only configured Telegram and RPC hosts are contacted. Explorer URLs create links and are never fetched.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | required | BotFather token |
| `TELEGRAM_API_ROOT` | `https://api.telegram.org` | Bot API origin |
| `STARKNET_RPC_URL` | required unless URLS is set | One HTTP(S) RPC URL |
| `STARKNET_RPC_URLS` | unset | Comma-separated endpoints; replaces RPC_URL |
| `CAIRN_CHAIN` | `SN_MAIN` | `SN_MAIN` or `SN_SEPOLIA` |
| `CAIRN_NETWORK_FILE` | `networks/<chain>.json` | Token registry and optional contracts |
| `CAIRN_DATA` | `./data` | Persistent directory, mode 700, files 600 |
| `CAIRN_EXPLORER_URL` | `https://voyager.online` | Explorer link prefix |
| `CAIRN_POLL_MS` | `10000` | Pass interval, at least 50 ms |
| `CAIRN_TG_TIMEOUT` | `30` | Long poll seconds, 0–50 |
| `CAIRN_RPC_RPS` | `5` | RPC calls per second, 1–100 |
| `CAIRN_RPC_TIMEOUT_MS` | `10000` | Request timeout, at least 100 ms |
| `CAIRN_LOG` | `info` | `error`, `warn`, `info`, `debug`; JSON stderr |
| `CAIRN_MAX_BLOCKS` | `500` | Scan range limit per pass, 1–10000 |
| `CAIRN_MAX_WATCHES` | `20` | Watches per chat, 1–200 |
| `CAIRN_PRICE_MAX_AGE` | `900` | Price freshness in seconds of chain time |
| `CAIRN_CONFIRMATIONS` | `0` | Scan depth behind head, 0–100 |
| `CAIRN_STALL_SECONDS` | `120` | Unchanged-head threshold in wall seconds, at least 2 |
| `CAIRN_REORG_DEPTH` | `64` | Retained block hashes, 1–1000 |
| `CAIRN_MAX_GAP` | `50000` | Skip when gap exceeds this many blocks; equality scans |
| `CAIRN_OPERATOR_CHAT` | unset | Chat id for all-endpoint outage notices |
| `CAIRN_HTTP_PORT` | unset, off | Listener port; 0 chooses and logs a free port |
| `CAIRN_HTTP_HOST` | `127.0.0.1` | HTTP bind address |
| `CAIRN_BLOCKLIST` | `blocklist/domains.txt` | Domain blacklist, one per line, `#` comments |

## Commands and protection

| Command | Use |
| --- | --- |
| `/start`, `/help` | Privacy and command guide |
| `/status` | Head, chain time, gas and RPC spec |
| `/balance <address\|name.stark> [token]` | Exact balances; optional symbol or token address |
| `/tx <hash>`, `/track <hash>` | Transaction lookup or staged acceptance notices |
| `/price [SYMBOL…]` | Pragma prices, freshness and sources |
| `/feed <token> [min\|$usd] [buys\|all]`, `/unfeed` | One trade feed per chat |
| `/watch <address\|name.stark> [label]`, `/unwatch <address\|label>` | Wallet transfers and approvals |
| `/whale <token> <amount>`, `/unwhale <token>` | Large transfers |
| `/min <token> <amount>` | Watch floor; 0 clears it |
| `/mute <token address>`, `/unmute <token address>` | Silence a token |
| `/list`, `/export`, `/forget` | Inspect, export or delete chat data |
| `/network on\|off` | Subscribe to stalls, recoveries and skipped-gap notices; default off |
| `/guard seed\|links on\|off` | Configure each guard; both default on |

In groups, settings, `/track`, `/export` and `/forget` require an administrator; lookups and `/list`
are open to everyone. Anonymous administrators posting as the group can change settings.
Commands addressed to another bot are ignored. A forum subscription posts into its saved topic.

Guards inspect new and edited message text, captions and Telegram text links before command parsing. Exact uninterrupted
runs of 12, 15, 18, 21 or 24 English BIP-39 words trigger deletion without checksum validation.
Eleven or thirteen words and interrupted runs do not. Punctuation breaks a run. Guards never echo,
log or persist matched content; their switches persist. `/forget` restores guards to on and network
subscriptions to off for that chat. Never test using a real recovery phrase.

The link blacklist matches the parsed hostname or its subdomains, ignoring case, scheme, userinfo and path.
`claim.starknet-bot.com` matches; `starknet-bot.com.safe.example` and
`starknet-bot.com@safe.example` do not. A custom list replaces the starter list. Missing delete rights
produce a warning naming **Delete messages**.

## Network and delivery

There is one scanner pass. It reads the head and updates, prepares network checks, scans confirmed ranges,
steps tracked transactions and delivers the ledger within a shared group budget. A first start sets the
cursor to the confirmed head. Stored hashes cover blocks observed since startup, up to the configured
depth. A fork walks back to a retained common ancestor, rewinds the same scanner, and checks receipts for
transactions already alerted. An orphan gets one correction replying to its original message; a transaction
found elsewhere gets no duplicate or correction.
A missing receipt is corrected only after the same endpoint also reports transaction status not-found;
ambiguous or failed checks stay in the delivery ledger for retry on each pass and are silently abandoned
after `CAIRN_REORG_DEPTH` additional head blocks. If no retained ancestor remains, Cairn rescans the retained
window. Older history cannot be recovered by that bounded check.

Stall duration uses wall time from the first sight of the unchanged head, surviving restarts. Subscribers
receive one stall and one recovery notice per incident. When all endpoints are down only the operator
receives one outage notice, persisted across restarts. A long gap skips to the confirmed head with one
subscriber notice; scanning then resumes normally. Groups receive at most three alert messages per pass,
including network notices and corrections. Command replies and guard warnings are immediate.

The round-2 delivery ledger records each chat/transaction/event before sending and stores Telegram's
message id on acceptance. Corrections use that ledger too. No accepted key is replayed on rescan.
Telegram provides no send idempotency key: a kill after acceptance but before the database update can
repeat that message. Sent bodies are discarded; delivery keys expire after seven days of chain time.
A blocked chat pauses pending alerts until it writes again or re-adds the bot.

Trade netting uses signed legs of swaps touching the watched token, with AVNU preceding its underlying
pools. Routed intermediate tokens and round trips net to zero. Traders come from Transfer flows, excluding
fees and venue contracts. Sellers show **Received**, buyers **Paid**. Prices are read at each trade's
block, including replacement blocks, and zero or stale answers give no USD value. Names display only after
forward verification; failed verification is retried next pass. Unverified tokens have no USD values.
A burst posts its biggest trades in full and links the largest remaining trade in its summary.

To add a third venue using an existing event layout, add one row to `VENUES` in `src/venues.mjs`, for example:

```js
{ key: 'pool3', name: 'Pool3', label: 'Pool3 Core', contract: 'pool3_core',
  selector: SELECTORS.Swapped, aggregator: false, legs: ekuboLegs }
```

Set `contracts.pool3_core` in the network JSON. The generated event filter has exactly
`{ address: config.contracts.pool3_core, keys: [[SELECTORS.Swapped]] }`; `from_block`, `to_block`,
`chunk_size` and `continuation_token` come from the same scanner. Another layout needs its own decoder.

## Monitoring and checks

With HTTP enabled, `GET /healthz` returns 200 `{"ok":true,"head":123,"lag_s":2}` or
503 `{"ok":false,"reason":"stalled"}` (`rpc` or `telegram` for service failures). Lag is wall time since
the currently observed head's chain timestamp, recalculated per request. `GET /metrics` serves
Prometheus `cairn_head_block`, `cairn_updates_total`, `cairn_messages_sent_total`, `cairn_alerts_total`
and `cairn_rpc_errors_total`. Counters cover the current process. Other routes and methods return 404.
Handlers only read pass state. Telegram connectivity failures in `run` remain visible and are retried;
401 and 409 still stop the process. Without a configured port, nothing listens.

```sh
curl -f http://127.0.0.1:8080/healthz
curl http://127.0.0.1:8080/metrics
npm test
npm run check
```

`tick` drains updates, performs one pass and prints `{"updates":0,"sent":0,"head":123,"alerts":0,"cursor":123}`.
The four check suites use local fake services. The tests require permission to bind loopback sockets.
See [ARCHITECTURE.md](ARCHITECTURE.md) for selectors, contract layouts and the frozen interface.
