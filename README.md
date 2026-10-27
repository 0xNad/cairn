# Cairn

Cairn is a read-only Starknet Telegram bot. It answers lookups, watches wallets and trades,
reports network trouble, and protects chats from recovery phrases and listed phishing links.
It never holds keys or signs transactions. It needs Node.js 24 and no npm dependencies.

## Set up Telegram

From a checkout, prepare the private configuration file:

```sh
cp .env.example .env
chmod 600 .env
```

1. Open [BotFather](https://t.me/BotFather), run `/newbot`, and save the token in `.env`.
2. Use `/setprivacy` → Disable so Cairn receives ordinary group messages.
   Remove and re-add an existing bot after changing this setting.
3. Add Cairn as a group administrator with **Delete messages** enabled.
   Without it, Cairn warns but cannot delete dangerous messages.
4. Send `/start` privately to Cairn. Private chats need no administrator setup.

## Choose two RPC endpoints

Set `STARKNET_RPC_URLS` to two complete URLs, separated by a comma. Choose independent
providers on the same Starknet chain with:

- JSON-RPC spec 0.10.0 or later;
- chain-wide `getEvents` queries without a contract address;
- historical contract calls if you want prices at older trade blocks.

Cairn stays with a working endpoint and retries a complete scan range after switching.
A provider on another chain stops startup with exit 2.

With Node 24 installed, load `.env` and check connectivity:

```sh
set -a
. ./.env
set +a
node cairn.mjs doctor
node cairn.mjs run
```

`doctor` prints the bot, chain, block and RPC spec. In a test group, send `/network on`,
`/watch <address>` and optionally `/feed STRK $100 all`.
Use `/status` for connectivity and `/list` for subscriptions.

For Sepolia, also set `CAIRN_CHAIN=SN_SEPOLIA` and
`CAIRN_EXPLORER_URL=https://sepolia.voyager.online`.

## Find your operator chat id

1. Open [@userinfobot](https://t.me/userinfobot) privately, send `/start`, and copy your numeric **Id**.
2. Send `/start` to your own Cairn bot so it can message you.
3. Set `CAIRN_OPERATOR_CHAT` to that id in `.env`, then restart Cairn.

Never share your BotFather token. Finding your chat id does not require giving it to another bot.

## Docker

Install Docker Engine, then build and run from the checkout with the configured `.env`:

```sh
docker build -t cairn:local .
docker volume create cairn-data
docker run -d --name cairn --restart unless-stopped \
  --env-file .env -e CAIRN_DATA=/data \
  -v cairn-data:/data cairn:local
docker logs cairn
docker stop --time 3 cairn
```

- Keep the `cairn-data` volume when replacing the container: it holds subscriptions and delivery history.
- The image runs as `node` (uid 1000). For a bind mount, give that user ownership and use mode 700.
- Run one instance per bot token and data directory.

To expose monitoring, set `CAIRN_HTTP_PORT=8080` and `CAIRN_HTTP_HOST=0.0.0.0` in `.env`.
Add `-p 127.0.0.1:8080:8080` to `docker run`.

RPC services running on the host need container-reachable addresses.
On Linux, `--network host` also permits their loopback addresses.

## systemd

Install Node 24 at `/usr/local/bin/node` and verify `node --version`.
Copy the checkout to `/opt/cairn`, then install the service:

```sh
sudo useradd --system --home-dir /var/lib/cairn --shell /usr/sbin/nologin cairn
sudo install -m 600 .env /etc/cairn.env
sudo install -m 644 deploy/cairn.service /etc/systemd/system/cairn.service
sudo systemctl daemon-reload
sudo systemctl enable --now cairn
sudo journalctl -u cairn -f
sudo systemctl stop cairn
```

The unit forces `CAIRN_DATA=/var/lib/cairn`, overriding `.env`.
If Node lives elsewhere, edit `ExecStart` before starting the service.

- SIGTERM and SIGINT close polling, HTTP and SQLite and exit 0 within three seconds.
- Stop Cairn before backing up its data directory.
- To upgrade, replace the code and restart. Existing databases migrate automatically.
- Exit codes: 0 completed; 1 connectivity or instance conflict; 2 invalid configuration/chain/spec;
  3 rejected Telegram token. Repair configuration before restarting exits 2 or 3.

## Configuration

Configuration comes from the environment. Keep tokens and RPC URLs private.
Only configured Telegram and RPC hosts are contacted; explorer links are never fetched.

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

In groups, administrators control settings, `/track`, `/export` and `/forget`.
Everyone can use lookups and `/list`. Anonymous administrators posting as the group can change settings.
Subscriptions created in a forum topic post there.

Both guards start enabled and inspect new messages, edits, captions and Telegram text links:

- **Seeds:** a run of 12 or more English BIP-39 words triggers deletion, including numbered and
  punctuated lists. Other non-BIP-39 words interrupt a run. No checksum is required.
- **Links:** the parsed host must equal a blacklisted domain or be its subdomain.
  Case, scheme, userinfo and path do not change the match.

For example, `claim.starknet-bot.com` matches the starter blacklist.
`starknet-bot.com.safe.example` and `starknet-bot.com@safe.example` do not.
A custom `CAIRN_BLOCKLIST` replaces the starter list.

Warnings explain what happened without quoting the protected content.
Missing rights produce a warning naming **Delete messages**.
Guards never log or store inspected text. Never test using a real recovery phrase.
`/forget` clears subscriptions and restores both guards to on.

## Network and delivery

- `/network on` enables one stall notice and one recovery notice per incident.
  Stalls show elapsed wall time and the last block's number and time.
- When every endpoint is unavailable, only the operator receives an outage notice and a restoration notice.
  Both survive restarts without repeating.
- A chain reorganisation can remove a transaction. Cairn replies to each affected original message
  with a correction; re-included transactions receive no duplicate alert.
- `CAIRN_CONFIRMATIONS` delays scanning. Gaps beyond `CAIRN_MAX_GAP` are skipped with one subscriber notice.

Groups receive at most three alert messages per pass. During a multi-block catch-up, ordinary group
posts wait until the saved backlog is scanned. The planner then selects the two weightiest posts and
one summary covering the remainder, with a link to the largest remaining trade.
New blocks arriving meanwhile form the next batch. Network notices and corrections remain immediate;
command replies and guard warnings do not consume the alert budget.

A lagging endpoint is allowed to catch up. Only conflicting block hashes establish a fork.
Chain alerts wait while history cannot be validated.
A missing receipt is corrected only when the same endpoint also reports the transaction status as
not-found; ambiguous checks retry and expire silently after `CAIRN_REORG_DEPTH` blocks from the first fork.
Changes deeper than retained history cannot be fully recovered.

Trade posts show **Paid** for buys and **Received** for sells.
Prices come from the trade's block; zero or stale answers give no USD value.
Names appear only after forward verification. Unverified tokens have no USD values.
Size bars grow at $100, $1,000 and $10,000; trades at $100,000 or above carry a whale marker.

## Monitoring

With HTTP enabled:

- `GET /healthz`: 200 `{"ok":true,"head":123,"lag_s":2}`, or 503 with reason `rpc`, `telegram` or `stalled`.
  RPC failure takes priority. Lag is recalculated from the observed head's timestamp for each request.
- `GET /metrics`: Prometheus head, updates, messages, alerts and RPC-error metrics.
  `cairn_head_block` keeps the last known head during an outage; counters cover the current process.
- Other routes and methods return 404. Without a configured port, nothing listens.

```sh
curl -f http://127.0.0.1:8080/healthz
curl http://127.0.0.1:8080/metrics
```

## Data and development

SQLite keeps subscriptions and delivery records in `CAIRN_DATA` (directory mode 700, files 600).
Sent bodies are discarded. Delivery keys expire after seven days of chain time; an original awaiting
its correction is retained until that correction is resolved. A blocked chat pauses until it writes
again or re-adds the bot.

Telegram has no send idempotency key: stopping after acceptance but before the database update can
repeat that message. Accepted ledger keys otherwise prevent rescan and restart duplicates.

There is one pass loop. It validates history, scans confirmed ranges, steps tracking and delivers
through the shared planner. HTTP only reads state. Reorg checks and correction replies use the delivery
ledger's dedicated reconciliation table; pending executions are rebuilt through the normal scanner.

To add a third venue using an existing event layout, add one row to `VENUES` in `src/venues.mjs`, for example:

```js
{ key: 'pool3', name: 'Pool3', label: 'Pool3 Core', contract: 'pool3_core',
  selector: SELECTORS.Swapped, aggregator: false, legs: ekuboLegs }
```

Set `contracts.pool3_core` in the network JSON. The generated event filter has exactly
`{ address: config.contracts.pool3_core, keys: [[SELECTORS.Swapped]] }`; `from_block`, `to_block`,
`chunk_size` and `continuation_token` come from the same scanner. Another layout needs its own decoder.

Run the unit tests and all four local check suites:

```sh
npm test
npm run check
```

The tests need permission to bind loopback sockets.
`tick` drains updates, performs one pass and prints a JSON result.
See [ARCHITECTURE.md](ARCHITECTURE.md) for selectors, contract layouts and the frozen interface.
