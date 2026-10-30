# Cairn

**A Starknet companion in Telegram: create a trading wallet, buy and sell, and follow your wallets and tokens.**

Open [@Cairn_tgbot](https://t.me/Cairn_tgbot) and press **Start**. Use the buttons to create a dedicated trading wallet, back up its key, deposit, activate, trade, view positions or withdraw. Trade review and confirmation happen in the bot. No external wallet connection is needed for the in-bot flow.

The trading wallet is custodial: Cairn holds its encrypted key and signs only your confirmed transactions. Wallet creation is off-chain; activation, trades and withdrawals spend your funds and network fees. [Custody model, operation and verification](custody/README.md).

Only five commands appear in the menu: `/start`, `/trade`, `/price`, `/list`, `/help`. Paste a wallet, .stark name or transaction for lookups; paste a supported token to start trading. Help opens short sections for monitoring, advanced settings and privacy. Existing command aliases remain available.

For groups, add Cairn and configure a feed such as `/feed STRK $100 all` as an administrator. Wallet alerts, Pragma prices, names, transaction tracking, network guards, reorg corrections and member protection remain available. Trading wallets are private-chat only.

Self-hosting can enable either model: dependency-free, read-only monitoring with custody disabled, or the optional in-bot signing engine. A separate [wallet-connected website](https://cairn-trading.vercel.app) remains available. Neither product is a Telegram Mini App. The project is MIT-licensed.

The current release is for live owner acceptance. Automated local-fork tests do not claim a funded owner trade on mainnet or an independent custody security audit.

It was built in public by AI coding agents, in four completed judged rounds on [Hotpod](https://hotpod.io/p/cairn).

> **Status:** all four rounds are implemented: lookups; wallet alerts on every token, whale alerts, floors,
> mutes, `/track`, buttons, `/export` and `/forget`; trade feeds from Ekubo and AVNU, `/price`, USD values,
> `.stark` names, a message budget for groups and forum topics; then stall and recovery alerts, reorg
> corrections, confirmations, RPC failover, gap skips, `/healthz`, `/metrics`, the seed-phrase and link guards
> and the [deploy guide](#deploy-it). [ARCHITECTURE.md](ARCHITECTURE.md) specifies the frozen interface.

## What it looks like

A group's trade feed, `/feed STRK $20 all`, on mainnet trades of 24 October 2026:

```
🔴🔴🔴 Sell STRK · ≈$849.93
17,802.368766626936800896 STRK for 850.552141 USDC
👤 0x0187…7914
Ekubo · 2026-10-24 12:56:22 UTC · View tx
```

```
🔴🔴 Sell STRK · ≈$12.83
268.63691294143686493 STRK for 0.005416127807376098 ETH
👤 firatnam.stark
AVNU · 2026-10-24 12:56:57 UTC · View tx
```

The second one is an AVNU route (STRK to USDC on another pool, USDC to a hop token to ETH on Ekubo): it
counts once, as AVNU, and the trader is the account the STRK left, shown by its verified `.stark` name.
When a burst brings more than three posts into one group in one pass, two are posted and the third
summarises the rest, without a notification sound:

```
➕ 7 more in blocks 16868035–16868038, summarised to keep the group readable:
🟢 7 buys · 64,330.372871859602683975 STRK · ≈$3,070.23
Largest: Buy 20,735.08526851343652475 STRK ≈$989.60
```

A token outside the registry stays plainly unverified, and never gets a USD value:

```
🔴 Sell EKUBO (unverified, 0x075a…7a87)
0.265354465728705132 EKUBO for 0.000138178661682261 ETH
👤 hatiss-aras.stark
Ekubo · 2026-10-24 13:12:20 UTC · View tx
```

`/price` reads Pragma at the head block:

```
Pragma prices · block 16867743 · 2026-10-24 12:56:18 UTC
• STRK/USD $0.04774266 · updated 54 s ago · 10 sources
• ETH/USD $2,369.50534991 · updated 54 s ago · 11 sources
• USDC/USD $0.999812 · updated 53 s ago · 9 sources
• USDC.e (USDC/USD) $0.999812 · updated 53 s ago · 9 sources
• USDT/USD $0.998765 · updated 54 s ago · 5 sources
• WBTC/USD $80,544.94834432 · updated 54 s ago · 8 sources
Alerts show USD values only from prices updated within 900 s of chain time.
```

Wallet alerts for mainnet transactions of 24 October 2026, watching the Ekubo router under the label
"Ekubo router" (shortened): a verified token's amount carries its USD value, and the network file's
contracts read by name.

```
↓ In +378.183585 USDC (≈$378.12) to Ekubo router from 0x0187…7914
↓ In +7,847.701691064621264732 STRK (≈$374.54) to Ekubo router from Ekubo Core
🔑 Approval: Ekubo router lets spender Ekubo Core spend 378.183585 USDC
↑ Out −378.183585 USDC (≈$378.12) from Ekubo router to Ekubo Core
↑ Out −7,847.701691064621264732 STRK (≈$374.54) from Ekubo router to 0x0187…7914
Block 16868035 · 2026-10-24 13:04:34 UTC · View tx
```

Round 2's alerts, for mainnet transactions of 19 October 2026, watching the AVNU exchange contract
under the label "AVNU" (the first one is shortened):

```
↓ In +1,144.128967 USDC to AVNU from 0x0199…737e
↑ Out −73.505748 USDC from AVNU to 0x0199…737e
↓ In +0.00089101 strkBTC (unverified, 0x0787…3135) to AVNU from 0x0199…737e
🔑 Approval: AVNU lets spender 0x0702…f624 spend 722.997876 USDC
… and 9 more in this transaction.
Block 16616677 · 2026-10-19 13:23:35 UTC · View tx
```

```
🐋 Whale 15,737.876609793529295857 STRK from 0x0000…5b4b to 0x0448…a791 (2 hops)
Block 16616896 · 2026-10-19 13:29:55 UTC · View tx
```

```
✅ Accepted on L2 · SUCCEEDED
Fee: 0.11574329611192912 STRK · block 16616704
View transaction
```

When the chain misbehaves, a chat with `/network on` hears it once, and hears again when it is over. These
are the messages Cairn sends for the checks' fixtures (`npm run transcript` replays them, see
[Checks](#checks)):

```
⚠️ Starknet stalled: no new block for 2 s. The head is still block 4200010. Cairn posts here again when blocks resume.
```

```
✅ Starknet is producing blocks again: block 4200011 arrived after a 3 s stall at block 4200010.
```

After a reorg, an alert whose transaction left the chain gets one correction, as a reply to it; whatever
replaced it is alerted on its own:

```
↩️ Correction: Starknet reorganised the blocks after 4200010, and transaction 0x0065…188d is no longer on chain. What this alert reported did not happen; anything that replaced it is posted on its own.
```

The operator alone hears of RPC trouble (`CAIRN_OPERATOR_CHAT`), once per outage:

```
🚨 RPC outage: all 2 endpoints of STARKNET_RPC_URLS fail, so Cairn cannot read Starknet. Alerts are on hold and none are lost: scanning picks up where it stopped. Cairn says so here once an endpoint answers.
```

And the guards, on by default, delete a seed phrase or a phishing link with a warning that repeats nothing
of it:

```
🛡 Deleted: it held 12 recovery words. Whoever reads them controls the wallet. If those words secure funds, sweep everything to a new wallet straightaway. Nobody legitimate requests them: not admins, moderators or bots.
```

```
🛡 Deleted: it linked to starknet-bot[.]com, a domain on this bot's phishing blocklist. Never connect a wallet or sign anything there.
```

- **A trade post reads at a glance.** The first line is the size, the side and the USD value; the second
  the exact amount and what was paid for it (or got for it); then the trader and the venue, the block time
  and a link. The row of dots grows by one at every decade of USD value ($10, $100, $1,000 and $10,000: five
  dots at most, with a 🐋 from $100,000), green for a buy and red for a sell, so a big trade stands out in a
  scroll, and the first line of the largest one still fits a phone.
- **One message per chat per transaction**, in chain order: each matching transfer on its own line, with
  the exact amount, the direction (in, out, or between two watched wallets), the counterparty, the label,
  the block, its UTC time and a link to check it. A busy transaction shows ten lines and a count of the rest.
- **Bursts never flood a group.** A group gets at most three alert messages per pass, feeds, watches and
  whales together: when more are due, the two that matter most (a track update, an approval, then the
  largest) are sent and the third summarises the rest, with a link to each wallet alert. Command replies are
  never held back. In a private chat, after three alerts in one pass the next ones arrive without a
  notification sound.
- **Every token, plainly marked.** Cairn sees every ERC-20, but anything outside its registry is
  **unverified**: its symbol is shown in code, never as a link, followed by "unverified" and its contract.
  An airdropped fake "USDC" always reads `USDC (unverified, 0x05ce…7841)`, never as the real one. One
  `/mute <token address>` silences it.
- **No noise.** Zero-amount transfers (address poisoning) and the fee payment are never alerted; `/min`
  sets a floor per token; a whale amount routed through pools reads as one line from start to end.

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
| 2. Wallet alerts, every token | `/watch` any wallet: transfers and approvals on every ERC-20, unverified tokens flagged, whale alerts, `/track`, each alert delivered once | 9,000,000 points |
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

The four rounds are closed and their winners are merged into `main`: [#4](https://github.com/0xNad/cairn/pull/4),
[#13](https://github.com/0xNad/cairn/pull/13), [#16](https://github.com/0xNad/cairn/pull/16) and
[#21](https://github.com/0xNad/cairn/pull/21). Further improvements use ordinary issues and pull requests.
Every historical brief and rubric is in [`.launchpad/project.md`](.launchpad/project.md).

## For Starknet communities

- **Want a trade feed in your group?** Add the bot, then as an administrator run `/feed <token> $100`, in
  the forum topic where the posts should go. Open an issue for a venue or a token Cairn should know.
- **Run a treasury, a DAO or a validator?** Tell us which wallets you would watch, and why.
- **Tired of seed-phrase scams in your group?** Make Cairn an administrator with the Delete messages right: it
  deletes pasted recovery phrases and links to phishing domains, and warns the group.
- **Want to host an instance?** [Deploy it](#deploy-it) with Docker or systemd: a BotFather token, two RPC
  URLs and ten minutes.

## Monitoring bot safety and privacy

- **Read-only.** Cairn never calls a write method. It never holds a key, never asks for a seed phrase and never
  builds a signing link.
- **No custody or Mini App.** The bot never executes a trade. When configured, `/trade`, `/buy` and `/sell`
  open the companion website, where the user's wallet reviews, signs and submits. See its separate [security and operating contract](trading/README.md).
- **Only the hosts you configure.** It talks to Telegram and your RPC endpoints, and nothing else: no
  telemetry, no price API, no fallback you did not list. Prices come from the Pragma oracle contract and names
  from the Starknet ID contract, read through your RPC. The blocklist is a local file, never fetched.
- **Guards that never repeat what they protect.** A seed phrase is deleted unseen by Cairn's storage and logs,
  and its warning is written without a single BIP-39 word, so it cannot quote one.
- **It keeps little, and shows all of it.** Per chat: its id and type, its settings (its trade feed included,
  and the forum topic of each), the tokens seen moving for a watched address, alert delivery records for 7
  days, and a pasted address or hash for a day (the value behind its button). Per person, only their id and
  command times for one minute, for the rate limit. Shared by all chats: token metadata and the reverse
  `.stark` names read from the chain, each for a limited time. Never message text, Telegram names or
  usernames. `/export` shows everything stored for a chat; `/forget` deletes it, and in a private chat the
  person's rate-limit entry too.
- **Groups are run by their administrators.** Members can look things up and read `/list`; only an
  administrator can change what the group watches, and every button press is checked again.
- **Facts, not advice.** Monitoring has no rankings or trending lists. Trading is a separate explicit wallet action.

## FAQ

**Can I buy or sell?** The optional [trading companion](trading/README.md) supports exact-input Starknet swaps
with your own wallet. The Telegram bot opens ordinary links; it never holds keys or sends a chain transaction.
Set `CAIRN_TRADING_URL` to your hosted HTTPS companion to enable `/trade`, `/buy STRK 100 USDC` and `/sell STRK 100 USDC`.
The four original competition rounds remain read-only and unchanged; trading is a later extension.

**Which tokens?** Every ERC-20 on Starknet, in both event layouts. The registry (STRK, ETH, USDC, USDC.e,
USDT and WBTC on mainnet) is the list of verified tokens: their symbols are trusted, and `/balance` lists
them by default. Any other token is read from its contract (`symbol` and `decimals`) and marked unverified.

**Which RPC?** Any Starknet JSON-RPC 0.10 node, and preferably two from different providers: see
[choosing RPC endpoints](#2-choose-rpc-endpoints). The public `starknet-rpc.publicnode.com` works out of the box.

**Which venues?** Ekubo and the AVNU aggregator, on mainnet. AVNU routes through Ekubo and other pools, so a
transaction AVNU swapped the token in counts once, as AVNU. A third venue is one entry in `src/venues.mjs`
and one contract in the network file: say a pool contract `0x0123…` that emits `Swap` events. A selector is
the hash of the event's name, so its `Swap` has AVNU's selector, and the scanner adds one filter on the same
ranges, `{"address": "0x0123…", "keys": [["0x00e316f0d9d2a3affa97de1d99bb2aac0538e2666d0d8545545ead241ef0ccab"]]}`;
the entry's `legs` function turns that event's data into the tokens it moved, signed from the trader's side,
and its place in the list sets its precedence. The netting and trader rules apply unchanged.

**Where do prices come from?** The Pragma oracle on Starknet, `get_data_median` of each verified token's
`pragma_pair`. A price older than `CAIRN_PRICE_MAX_AGE` (900 s of chain time by default) gives no USD value.

**Who runs it?** Anyone: it is MIT-licensed and self-hostable. Whether a shared public instance will run, and
who would run it, is still open.

**Why "Cairn"?** A cairn is a pile of stones that marks a trail and warns walkers, and the word sounds like
Cairo. It is a working name.

## Deploy it

From a fresh Linux machine to a bot that runs unattended: a BotFather token, two RPC endpoints, then Docker
(step 3) or systemd (step 3b), and the checks of step 4. Cairn needs no database server and no dependencies;
everything it keeps is one SQLite file in its data directory.

### 1. Create the bot with BotFather

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, then a display name and a username
   that ends in `bot` (such as `mycommunity_cairn_bot`).
2. BotFather answers with the bot's token, `7700112233:AAH…`. It is the bot's password: keep it out of chats,
   screenshots and Git. If it leaks, `/revoke` in BotFather issues a new one.
3. Optional: `/setdescription` and `/setuserpic`. Cairn registers its command list itself at start.
4. To use it in a group, add the bot, then make it an **administrator with the Delete messages right**. The
   guards need it: an administrator bot sees every message (not only commands) and may delete seed phrases
   and phishing links. Without it, Cairn still answers commands and posts alerts, and `/guard` says what it lacks.

### 2. Choose RPC endpoints

- Cairn reads any Starknet **JSON-RPC 0.10** endpoint (or later) on the chain of `CAIRN_CHAIN` (`SN_MAIN`
  by default). Providers often serve several spec versions at different paths: use the 0.10 one.
- Each pass reads one chain-wide `starknet_getEvents` filter with no contract address, plus block headers and
  a few calls: a few requests every `CAIRN_POLL_MS` (10 s), capped by `CAIRN_RPC_RPS` (5 per second). Some free
  plans refuse event filters without an address: `doctor` tries that filter on each endpoint and says
  `"events":"ok"` or why not.
- **Use two endpoints from different providers** in `STARKNET_RPC_URLS`, your best first:
  `STARKNET_RPC_URLS=https://<provider>/<path>/<your-key>,https://starknet-rpc.publicnode.com`. Cairn uses the
  first one that answers and moves to the next on a 429, a 5xx, a timeout or a broken answer, then comes back
  to the first a minute later. Every endpoint must serve the same chain: Cairn checks each one at start and
  exits 2 otherwise. The URLs are secrets (keys sit in their paths): logs, `/status` and `/metrics` name an
  endpoint by its place in the list, never by its URL.
- Two public mainnet endpoints answered spec 0.10 with the event filter, without a key, on 27 October 2026:
  `https://starknet-rpc.publicnode.com` and `https://api.zan.top/public/starknet-mainnet/rpc/v0_10`. A provider
  account (a key in the URL) gives higher limits for the first place. Sepolia needs `CAIRN_CHAIN=SN_SEPOLIA`,
  a Sepolia endpoint and `CAIRN_EXPLORER_URL=https://sepolia.voyager.online`.

### 3. Run it with Docker

The image is Node.js 24 on Alpine with Cairn's files; it runs as the unprivileged `node` user and keeps its
state in the volume `/data` (with a host directory instead, `-v /srv/cairn:/data`, make it owned by uid 1000
first: `sudo chown 1000:1000 /srv/cairn`).

```sh
git clone https://github.com/0xNad/cairn && cd cairn
cp .env.example .env && chmod 600 .env
# Edit .env: TELEGRAM_BOT_TOKEN, and STARKNET_RPC_URLS with your two endpoints.
docker build -t cairn .
docker volume create cairn-data
docker run --rm --env-file .env -v cairn-data:/data cairn doctor
docker run -d --name cairn --restart unless-stopped --env-file .env \
  --log-opt max-size=10m --log-opt max-file=3 \
  -v cairn-data:/data -p 127.0.0.1:8080:8080 cairn
docker logs -f cairn
```

`doctor` prints one line with the bot's username and each endpoint's chain, head block, spec and `events`
(whether it serves the event filter), or says what is wrong. The image serves `/healthz` and `/metrics` on port 8080 (`CAIRN_HTTP_PORT`), and Docker's own
health check reads `/healthz`: `docker ps` shows `healthy` once blocks arrive. `-p 127.0.0.1:8080:8080`
publishes it on the host's loopback only, and the log options keep at most 30 MB of logs. Write `.env` values
without quotes: `--env-file` keeps them. With Compose, `docker compose up -d --build` does the same from
`compose.yaml`.

### 3b. Or run it with systemd

On a machine with Node.js 24 (from [nodejs.org](https://nodejs.org) or your distribution) at `/usr/bin/node`
(`command -v node` says where it is; adjust `ExecStart` if needed):

```sh
sudo useradd --system --home-dir /var/lib/cairn --shell /usr/sbin/nologin cairn
sudo git clone https://github.com/0xNad/cairn /opt/cairn
sudo install -d -m 700 /etc/cairn
sudo install -m 600 /opt/cairn/.env.example /etc/cairn/cairn.env
sudo nano /etc/cairn/cairn.env          # the token and STARKNET_RPC_URLS; leave CAIRN_DATA unset
sudo install -d -o cairn -g cairn -m 700 /var/lib/cairn
sudo systemd-run --wait --pipe --quiet -p User=cairn -p EnvironmentFile=/etc/cairn/cairn.env \
  -E CAIRN_DATA=/var/lib/cairn /usr/bin/node /opt/cairn/cairn.mjs doctor
sudo cp /opt/cairn/deploy/cairn.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cairn
journalctl -u cairn -f
```

The unit, [`deploy/cairn.service`](deploy/cairn.service), runs Cairn as `cairn` with state in
`/var/lib/cairn`, a read-only view of the rest of the system, and restarts it after a crash, but not after
exit 2 (a configuration error) or 3 (a rejected token), which restarting cannot fix. For `/healthz`, add
`CAIRN_HTTP_PORT=8080` to `/etc/cairn/cairn.env`: it listens on 127.0.0.1 unless `CAIRN_HTTP_HOST` says otherwise.

### 3c. Or host it on a Mac

An always-on Mac with Node.js 24 and Python 3 can run Cairn under the current user's `launchd` session:

```sh
mkdir -p ~/.config/cairn
cp .env.example ~/.config/cairn/cairn.env
chmod 700 ~/.config/cairn && chmod 600 ~/.config/cairn/cairn.env
# Edit the private env file: the token, two RPC URLs, an absolute CAIRN_DATA path,
# and CAIRN_HTTP_PORT=8486 for local health checks.
python3 deploy/install-macos.py --node "$(command -v node)"
curl --fail http://127.0.0.1:8486/healthz
```

The installer creates `~/Library/LaunchAgents/com.cairn.bot.plist`. It starts now and on user login,
restarts after a crash and keeps the token out of the service arguments. Configuration and token errors
stop rather than loop. Logs in `~/Library/Logs/Cairn` rotate at 5 MiB (one previous file each).
Keep the Mac awake and the user session signed in; this is a user service, not a pre-login system daemon.
After upgrading, rerun the installer. To stop it:
`launchctl bootout gui/$(id -u)/com.cairn.bot`.

### 4. Check it

- **Health:** `curl -s http://127.0.0.1:8080/healthz` answers `200 {"ok":true,"head":17024011,"lag_s":0,…}`:
  `head` is the latest block, `lag_s` the chain seconds between it and the last block scanned (how late alerts
  are). Otherwise `503 {"ok":false,"reason":…}`: `rpc` when every endpoint fails, `telegram` when Telegram
  cannot be reached, `stalled` when no new block came for `CAIRN_STALL_SECONDS`. Both answers add `cursor`,
  `unchanged_s` (seconds since the head last changed) and `endpoint`/`endpoints` (which one is in use).
- **Metrics:** `curl -s http://127.0.0.1:8080/metrics` is Prometheus text: `cairn_head_block`,
  `cairn_cursor_block`, `cairn_lag_seconds`, `cairn_head_unchanged_seconds`, `cairn_healthy`,
  `cairn_updates_total`, `cairn_messages_sent_total`, `cairn_alerts_total`, `cairn_pending_alerts`,
  `cairn_rpc_requests_total{endpoint}`, `cairn_rpc_errors_total{endpoint}`, `cairn_rpc_endpoint`,
  `cairn_telegram_errors_total`, `cairn_reorgs_total`, `cairn_corrections_total` and
  `cairn_guard_deletions_total{guard}`. Scrape it with `- targets: ['127.0.0.1:8080']`;
  [`deploy/prometheus-rules.yml`](deploy/prometheus-rules.yml) alerts when Cairn is down or unhealthy for 5
  minutes, when alerts fall 10 minutes behind, when an endpoint keeps failing and when deliveries pile up.
  Nothing else is served: other paths are 404, other methods 405.
- **In Telegram:** send `/start` and `/status` to the bot (`/status` names the endpoint in use when there are
  several), then `/network on` in your group. `/export` in a private chat shows your chat id: set it as
  `CAIRN_OPERATOR_CHAT` and apply it (`docker rm -f cairn`, then the `docker run` above: `docker restart`
  keeps the old settings; or `sudo systemctl restart cairn`), and Cairn tells you, and only you, when every
  endpoint fails and when one answers again.
- **Failover:** break the first endpoint (a wrong key in its URL, say) and apply it the same way: `/healthz`
  stays 200, the logs say `{"level":"warn","event":"rpc endpoint","using":"endpoint 2 of 2"}`, and
  `cairn_rpc_endpoint` is 2.

### 5. Stop, upgrade, back up

- **Stop:** `docker stop cairn` or `sudo systemctl stop cairn` sends SIGTERM: Cairn ends its long poll and
  exits 0 within 3 s. It resumes where it stopped: an update is never handled twice, and alerts pending at the
  stop are sent after the restart. After more than `CAIRN_MAX_GAP` blocks (50,000, about a day) away, it skips
  to the head and says so in each chat concerned rather than flooding them with day-old alerts.
- **Upgrade:** `git pull`, then `docker build -t cairn . && docker rm -f cairn` and the `docker run` above
  (or `sudo systemctl restart cairn`). The state file migrates in place, in one transaction.
- **Back up:** stop Cairn and copy `state.db` from the volume (`docker run --rm -v cairn-data:/data -v
  "$PWD":/backup alpine cp /data/state.db /backup/`) or from `/var/lib/cairn`. One process per bot token and
  per data directory: a second one exits 1.
- **Logs** are one JSON object per line on standard error (`CAIRN_LOG=debug` for more): never the token, an
  RPC URL or message text. Exit codes: 0 stopped, 1 Telegram unreachable at start (for `doctor`, an endpoint
  too) or another instance running, 2 configuration or endpoints on different chains, 3 a token Telegram
  rejected.
- **The blocklist** is `blocklist/domains.txt`, or your own file in `CAIRN_BLOCKLIST`: one domain per line
  (subdomains are covered; `#` starts a comment; `*.domain`, `.domain` and hosts-file lines such as
  `0.0.0.0 domain` work too). Edit it while Cairn runs: it reloads the file on its next pass.

## Run it

To try it on your own machine: Node.js 24 or later, nothing else (Cairn has no dependencies). Create a bot
with [@BotFather](https://t.me/BotFather), then:

```sh
git clone https://github.com/0xNad/cairn && cd cairn
cp .env.example .env                    # put your bot token and an RPC URL in it
node --env-file=.env cairn.mjs doctor   # checks the token, each endpoint's chain, spec and event filter
node --env-file=.env cairn.mjs run
```

To keep it running, [deploy it](#deploy-it). `doctor` prints one JSON line with the bot username, decoded
chain, block number, RPC version and `events` (whether the endpoint serves the event filter), and with
`STARKNET_RPC_URLS` the same for each endpoint.
`tick` does one pass and prints `{"updates":n,"sent":n,"head":n,"alerts":n,"cursor":n}`: `alerts` counts the
alerts Telegram accepted, `cursor` is the last block scanned (a busy node gives `head: null`). `run` makes a
pass every `CAIRN_POLL_MS` and long-polls Telegram in between; SIGINT and SIGTERM cancel polling, RPC calls
and backoff waits. Exit codes are 0 for completion, 1 for connectivity or an instance conflict, 2 for
configuration or an incompatible chain/spec, and 3 for a rejected Telegram token. Logs are JSON on stderr.

### Commands

| Command | Who, in groups | What it does |
| --- | --- | --- |
| `/start`, `/help` | everyone | Commands, privacy, and a link to add the bot to a group |
| `/status` | everyone | Chain, head, UTC block time, L1/L1-data/L2 gas in FRI, RPC spec |
| `/balance 0x… [token]` | everyone | Exact balances of every registry token, or of one token (a symbol or any token address); for a watched address, also the other tokens seen moving for it |
| `/tx 0x…` | everyone | Finality, execution, block, fee, escaped revert reason, explorer link |
| `/price [SYMBOL…]` | everyone | Pragma's price of each verified token's pair (all of them without symbols), with its age in chain time and its number of sources; marked stale beyond `CAIRN_PRICE_MAX_AGE` |
| `/list` | everyone | The chat's feed, watches, whale alerts, floors, mutes and tracks, with Remove buttons |
| `/feed <SYMBOL\|address> [<min>\|$<usd>] [buys\|all]` | administrators | The chat's one trade feed: every buy of the token on Ekubo and AVNU (with `all`, every sell too) at or above a token amount or a dollar value; a new `/feed` replaces it |
| `/unfeed` | administrators | Stops the feed |
| `/watch 0x… [label]` | administrators | Alerts on every transfer in or out, on any token, and every approval the address grants (`CAIRN_MAX_WATCHES` per chat, default 20; labels up to 32 characters) |
| `/unwatch 0x…` or `/unwatch label` | administrators | Stops a watch |
| `/whale <token> <amount>` | administrators | Every transfer of a token at or above the amount, mints and burns labelled (5 per chat) |
| `/unwhale <token>` | administrators | Stops a whale alert |
| `/min <token> <amount>` | administrators | Skips watch alerts below the amount on that token (`0` removes it) |
| `/mute 0x…`, `/unmute 0x…` | administrators | Silences one token in the chat, by contract address |
| `/track 0x…` | administrators | One message on L2 acceptance (execution and fee), one on L1 acceptance or a revert with its reason; "not found" after 600 s of chain time (10 per chat) |
| `/network on\|off` | administrators (anyone reads `/network`) | A stall alert when no new block comes for `CAIRN_STALL_SECONDS` (120 s), and one recovery alert with its length when blocks resume; posted in the topic it was set up in |
| `/guard seed\|links on\|off` | administrators (anyone reads `/guard`) | The guards, both on by default: delete messages holding a seed phrase or a link to a blocklisted domain, with a warning; bare, `/guard` also says whether Cairn has the Delete messages right |
| `/export` | administrators | Everything stored for the chat, as JSON: `chat_id`, `watches` (each with the tokens `seen` moving for it), `whales`, `minimums`, `tracks` and `muted`, then `feed`, `network`, `guards`, `chat` (type, paused), `buttons` (pasted values, kept a day) and `deliveries` (its delivery records, counted by state); a subscription set up in a forum topic shows its `thread_id` |
| `/forget` | administrators | Deletes everything stored for the chat |

A `name.stark` works wherever an address does: `/watch ben.stark`, `/balance ben.stark`, `/unwatch ben.stark`.
In a private chat, pasting an address or a `name.stark` gives its `/balance` with a **Watch** button, and
pasting a transaction hash gives its `/tx` with a **Track** button. In groups, use `/command` or
`/command@your_bot_username`; plain text and commands for other bots are ignored. Administrators are the
members `getChatMember` reports as creator or administrator, and anonymous administrators posting as the
group. Amounts are typed as exact decimals (`1000000`, `2.5`, `1,000.5`), never with an exponent. Each person
gets 10 commands per minute of `message.date`; beyond that, one slow-down notice, then silence until the
minute has passed.

All environment settings, bounds and defaults are in [ARCHITECTURE.md](ARCHITECTURE.md#the-environment).
Round 2 adds `CAIRN_MAX_BLOCKS` (blocks scanned per pass, default 500) and `CAIRN_MAX_WATCHES`. Round 3 adds
`CAIRN_PRICE_MAX_AGE` (seconds of chain time before a price is stale, default 900, 1 to 31,536,000). Round 4
adds `STARKNET_RPC_URLS` (up to 10 failover endpoints), `CAIRN_CONFIRMATIONS` (0 to 100, default 0),
`CAIRN_STALL_SECONDS` (at least 2, default 120), `CAIRN_REORG_DEPTH` (1 to 1000, default 64), `CAIRN_MAX_GAP`
(default 50,000 blocks), `CAIRN_OPERATOR_CHAT`, `CAIRN_HTTP_PORT` (0 to 65535, 0 picks a free port; off when
unset), `CAIRN_HTTP_HOST` (default 127.0.0.1) and `CAIRN_BLOCKLIST`; each one is checked before any call. For
Sepolia set both `CAIRN_CHAIN=SN_SEPOLIA` and `CAIRN_EXPLORER_URL=https://sepolia.voyager.online`. Do not pass
credentials in command arguments. The explorer is used only for links. Redirects from either configured
endpoint are refused.

The network file (`networks/SN_MAIN.json` by default) gives each verified token an optional `pragma_pair`
and names four optional contracts: `contracts.ekubo_core` and `contracts.avnu_exchange` (the trade feed's
venues), `contracts.pragma` (prices) and `contracts.naming` (Starknet ID). A missing contract switches its
feature off, and the command that needs it says so; a malformed one exits 2 before any call, naming its path.
The starter files carry the mainnet contracts of ARCHITECTURE.md, and on Sepolia Pragma and Starknet ID only:
there is no feed on Sepolia, and its Pragma prices were about 14 hours old on 24 October 2026, so they show
as stale.

### How alerts are found

Each pass reads the blocks after the cursor, at most `CAIRN_MAX_BLOCKS`, with one chain-wide
`starknet_getEvents` filter (keys `[[Transfer, Approval]]`, no address, `chunk_size` 1000), following every
continuation token. A range is read whole or not at all: a failed page leaves the cursor where it was and the
next pass reads the range again; an invalid continuation token restarts it. Events are decoded by shape:
three keys and two data felts is a modern ERC-20 event; one key and four data felts is a legacy ERC-20 event
when its contract answers `decimals`, otherwise a legacy NFT; anything else is ignored. A subscription
covers only the blocks after the head read when it was made, and the first start never backfills.

Extra calls happen only for events some chat cares about: `symbol` and `decimals` of a token outside the
registry (cached for 7 days of chain time, "not a coin" included), the block header (time and
`sequencer_address`), and, for a STRK transfer to the sequencer, the receipt and the transaction to confirm
the fee rule. When nobody subscribes, a pass reads nothing. Only the contract's own answers (not deployed, no
such entrypoint, a failed call) make a token "not a coin"; any other node error, like a failed header or fee
lookup, fails the range, which the next pass reads again, so a busy node neither hides a token for a week
nor turns a fee into an alert.

The code keeps the scanner (`src/scanner.mjs`: ranges, paging, decoding by shape) apart from the alert rules
(`src/alerts.mjs`) and the delivery ledger (`src/ledger.mjs`). A feed for the scanner is the filters it reads
plus the function that turns their events into deliveries: `walletAlerts`, and round 3's `tradeFeed`.

### How trades are found

Each venue of `src/venues.mjs` adds one `starknet_getEvents` filter on the same ranges, naming its contract
and its event: Ekubo Core's `Swapped` and the AVNU exchange's `Swap`. Each filter is read once per range,
whichever feeds need it, and only while some chat has a feed: the trade feed reads its traders from round
2's chain-wide `Transfer` filter, which it shares with the wallet alerts. A venue's decoder turns each event
into legs, the tokens it moved signed from the trader's side: Ekubo's `delta.amount0` and `delta.amount1` with
their sign flipped (a positive delta is paid into the pool), AVNU's sell amount negative and its buy amount
positive. Then, per transaction, for each token a chat follows:

1. **One venue counts.** The venues are tried in precedence order, AVNU first. If AVNU emitted a `Swap`
   involving the token, its `Swap` events are netted and Ekubo's are ignored in that transaction: they are
   AVNU's route. Otherwise the Ekubo `Swapped` deltas are summed per token.
2. **A route's hop is not a trade.** A token that passed through the AVNU exchange contract in a transaction
   where AVNU swapped is part of that `Swap`, even when the event names only its two ends, so it nets to
   zero. On mainnet a route such as ETH → USDC.e → USDC → STRK otherwise reads as a USDC "buy" on Ekubo,
   credited to the next pool (`test/round3.test.mjs` keeps that transaction).
3. **The side is the sign.** A positive net is a buy, a negative one a sell (posted only with `all`), and
   zero, a round trip, posts nothing. The amount is the exact net; what was paid (for a buy) or got (for a
   sell) is the other tokens the venue moved the other way, from the same sums.
4. **The trader comes from the token's `Transfer` events**, never from the sender, the router, the AVNU taker
   or its beneficiary: each address's net change in the token over the transaction, leaving out the fee
   payment (the STRK transfer to the block's `sequencer_address` that is the transaction's last event), the
   zero address and both venue contracts. The largest net gain is a buyer, the largest net loss a seller;
   on a tie the address seen at the earlier `event_index` wins. When nobody qualifies, the post names no one.
5. **New holder** means `balance_of(trader)` (or `balanceOf`) answered 0 at the block before the trade's. It
   is asked for buys only, since a seller holds less after the trade, and any error means no flag.
6. **The floor.** A token amount or a dollar value, equality included. A dollar floor needs a fresh price
   to prove the trade reaches it, so a trade with no USD value is not posted under one.

A post is saved in the ledger like any alert, keyed by (chat, transaction hash, first swap event index), so a
trade post and a wallet alert about the same transaction never collide, and a kill before Telegram accepts
it loses nothing.

### Prices and names

**Prices.** `get_data_median(SpotEntry(pair))` on the Pragma contract, read at a block, gives the price, its
decimals, its last update time, its number of sources and an expiration (`Some` or `None`, both read). An
answer of price 0 is "no price". A USD value is `amount × price ÷ 10^(token decimals + pair decimals)`,
computed exactly and rounded half up to cents (`<$0.01` for any value above zero below a cent), only for a
verified token whose pair ends in `/USD`, and only when the price is at most `CAIRN_PRICE_MAX_AGE` older than
the block of the trade or transfer. A pass reads each pair at both ends of its range, and at a block between
them only when the two answers differ, since Pragma moves only when a publisher updates it. A trade of a
verified token with no price of its own is valued by what was paid for it, when that is priced. Nothing is
computed for an unverified token, and nothing from a stale price. A node that answers a price read with an
error (an unknown pair, a past block it no longer serves) leaves that value out, and the alerts still go out.

**Names.** A typed `name.stark` is encoded label by label as ARCHITECTURE.md settles (copied from
starknetid.js) and resolved with `domain_to_address`; 0x0 is an unknown name and is refused, and so are
subdomains, upper case, other characters and labels too long to exist. An address is shown by its reverse
name only when `address_to_domain` gives one and `domain_to_address` of the same labels gives that same
address back; that forward check runs again in every pass that shows the name. A reverse name is kept a day
of chain time, and "no name" (none, or one that does not resolve back) an hour, so an address that sets or
fixes its name shows it within the hour; any failure shows the short address. `/balance 0x…` shows the
address's verified name too. A chat's own label wins over a name, and the network file's contracts read by
their role ("Ekubo Core", "AVNU exchange").

### Groups, topics and bursts

Per group per pass, at most three messages that are not command replies, feed posts, watch and whale alerts
and track updates together. When more are due, two are sent in full and the third summarises the rest: how
many, in which blocks, the buys and sells with their totals and USD values, the wallet alerts and the track
updates with a link to each, and a link to the largest trade it covers. The two sent in full are the
weightiest, in chain order: a track update first (someone asked for it), then an approval by a watched
wallet, then the larger USD value; with no USD values, the first two. The alerts a summary covered are marked delivered with its
`message_id` and never sent again. A summary arrives without a notification sound. When `run` catches up on a
backlog, back-to-back passes share one budget until `CAIRN_POLL_MS` has passed, so a group never gets more
than three in one poll interval.

A feed, watch, whale or track set up in a forum topic posts into that topic; asked again from another topic,
it moves there, and the reply says so. A reply in an ordinary group, or in a channel's comments, carries a
thread too, and is not taken for a topic. If Telegram says the topic is gone, the alert goes to the group's
main thread instead.

### Network alerts, reorgs and failover

**Stalls.** After each head read, Cairn notes the highest block it has seen and the wall-clock time it first
saw it, in `CAIRN_DATA`, so the clock survives restarts; block timestamps play no part. When that block stays
the head for `CAIRN_STALL_SECONDS`, every chat with `/network on` gets one stall alert, in the topic it was
set up in (a chat that turns alerts on during a stall gets it too), and when a higher block arrives, each chat
that got it gets one recovery alert with the stall's length. With several endpoints, a head that stopped moving
is first checked against the others: if one is ahead, the endpoint that fell behind is set aside for ten minutes
and nobody is alerted, since the chain was fine. A stall alert still unsent when blocks resume (a group over its
budget, Telegram down) is dropped rather than sent late, and needs no recovery.

**Outages.** When every endpoint fails (each one tried up to 3 times with backoff), only `CAIRN_OPERATOR_CHAT`
is told, once per outage, and once more when an endpoint answers again, with the outage's length. Subscribers
hear nothing: the chain may be fine. The cursor waits, so no alert is lost; `/healthz` says `rpc`.

**Reorgs.** Cairn keeps the hash and time of every block in the last
`CAIRN_REORG_DEPTH` blocks scanned (table `blocks`), including after a wide catch-up scan. Missing headers
are read before the scan commits; a failed header leaves the cursor and deliveries unchanged.
Before each scan it compares the node's hash of the cursor block
with the kept one: one header read per pass, none when the cursor is the head just read. Each block commits
to its parent, so an unchanged cursor block means nothing below it changed. When it differs, Cairn walks back
through the kept hashes, newest first and never deeper than `CAIRN_REORG_DEPTH`, to the newest block the node
still has (the common ancestor), then works with round 2's ledger:

1. Each alert or trade post about a block after the ancestor is checked against the node
   (`starknet_getTransactionStatus`; with several endpoints, against each one, so that an endpoint still on
   the old fork never causes a false correction). A transaction no endpoint finds gets **one correction, as a
   reply to the alert** (`reply_parameters` with the stored `message_id`), and its ledger row is marked
   `corrected`, so that no later fork or restart corrects it twice. A summary that counted several such
   transactions gets one correction listing them. An alert still pending (never sent) is dropped instead.
2. A transaction the node still has gets nothing more: re-included in a replacement block, its key is already
   in the ledger, so the rescan cannot send it twice; the ledger only notes its new block, for a later fork. One
   the node knows but has put back in no block yet (its mempool) is checked again each pass: back in a block,
   nothing more; gone, or not back within 10 minutes of chain time, it gets its correction then.
3. The cursor moves back to the ancestor, and the same pass rescans the replacement blocks through the
   scanner like any range: their new events are new keys, alerted once, in chain order.

A fork deeper than `CAIRN_REORG_DEPTH` (no kept hash matches) rescans from that depth and no deeper, and tells
`CAIRN_OPERATOR_CHAT` which blocks could not be checked; `CAIRN_REORG_DEPTH=1000` widens the window.

**Confirmations.** `CAIRN_CONFIRMATIONS=n` scans only blocks at least n deep: an alert waits until n blocks
were built on top of its block, which makes a reorg correction rarer at the cost of n blocks of delay. On the
first start the cursor is that safe block, so `tick`'s `cursor` is never ahead of it.

**Gaps.** After a long downtime, more than `CAIRN_MAX_GAP` blocks behind (a gap of exactly `CAIRN_MAX_GAP` is
still scanned), Cairn jumps to the safe head instead of catching up through day-old alerts, and every chat the
gap concerns (network alerts on, or a feed, watch, whale alert or track) gets one notice naming the skipped
blocks.

**Failover.** `STARKNET_RPC_URLS` lists the endpoints, best first; they must all serve `CAIRN_CHAIN`. A call
goes to the first endpoint that has not failed in the last minute, and an HTTP 429, a 5xx, a timeout, a broken
answer or a JSON-RPC error of the endpoint itself (`-32xxx`) sends it on to the next one at once; each endpoint
still gets up to 3 tries, with backoff of at least its `Retry-After`. A page of `starknet_getEvents` is read
from the endpoint that issued its `continuation_token`: when that endpoint fails mid-range, the range restarts
from its first page on the next one, so a token never reaches an endpoint that did not issue it.

### Guards

Both guards are on in every chat until an administrator turns one off (`/guard seed off`, `/guard links off`);
`/forget` brings a chat back to the defaults. A guarded message is deleted with `deleteMessage`, then the chat
gets a warning, in the same forum topic, never as a reply (a reply's preview would quote the message). Edited
messages are read too, so a link edited into an old message is caught. Without the right to delete (a group
where Cairn is not an administrator with Delete messages), the warning says the message is still there and
names the right Cairn needs. A flood gets one warning per chat and guard in each batch of updates; every message
is still deleted.

- **Seed phrases.** A message, or a caption, holding a run of 12 or more words of the BIP-39 English list
  ([`wordlists/bip39-english.txt`](wordlists/bip39-english.txt), checked at start: 2048 words, MIT, see
  [`wordlists/BIP39-NOTICE`](wordlists/BIP39-NOTICE)) is deleted: 12, 15, 18, 21 and 24 words all hold such a
  run. Words are compared in lower case; numbers, bullets and punctuation between them (a numbered list, a
  comma-separated paste) neither count nor break a run, and any other word breaks it, so 11 words, or two runs
  of 6 around another word, stay. In 100 KB of this repository's prose the longest run is 7 words. The words are
  never stored or logged (logs say `{"event":"guard","guard":"seed","deleted":true}`), and the warning is built
  from words outside the list: it cannot repeat one.
- **Links.** Every link of a message is read: URLs with any scheme, hosts written without one
  (`starknet-bot.com/claim`), the hidden targets of text links, Telegram's link entities and a bot message's URL
  buttons. Hosts are parsed the way a browser parses them, lower case and punycode, so `HTTP://STARKNET-BOT.COM`
  matches and `starknet-bot.com@safe.example` (whose host is `safe.example`), `safe.example/starknet-bot.com`,
  `starknet-bot.com.safe.example` and `safestarknet-bot.com` do not. A host matches when it is a listed domain or
  sits under one (`claim.starknet-bot.com`). The warning names the domain defanged (`starknet-bot[.]com`) so that
  it is not a link again.

### Choices where the brief is silent

- Without `buys` or `all`, a feed posts buys only. The floor and the side can come in either order.
- `/feed` with the same token updates the floor, side and topic in place; another token replaces the feed.
- A dollar floor is refused for an unverified token and when no Pragma contract is configured.
- The new-holder flag is for buys only (see above), and the trader's name is checked once per pass.
- An AVNU route's intermediate tokens net to zero (see above). The cost, rare: a multicall that both routes a
  token through AVNU and trades it directly on Ekubo shows no trade of that token.
- The size bar counts decades of USD value, five dots at most; without a USD value it counts multiples of the floor.
- A summary posts into the topic most of its alerts came from.
- In a burst, the two alerts sent in full are the weightiest (above), not the first two.
- `/list` shows labels and short addresses, not names: it answers at once, with no chain call.
- A stall is measured from the first time Cairn saw the head hash, on the wall clock. A higher block or a
  replacement hash at the same height resets that clock; a lagging failover endpoint does not reset it.
- With several endpoints, a head that stopped moving is checked against the others before anyone is alerted.
- Network alerts go to the chats with `/network on`; a skipped gap also tells the chats whose alerts it skipped.
  RPC outages and reorgs deeper than `CAIRN_REORG_DEPTH` go to `CAIRN_OPERATOR_CHAT` only.
- A correction replies to the alert it corrects; a transaction back in the mempool gets 10 minutes of chain
  time to be included again before its correction.
- `lag_s` in `/healthz` is the chain time between the head and the last block scanned: 0 while Cairn keeps up.
- `/healthz` reports `rpc` before `telegram` before `stalled` when several are true.
- A seed phrase is any run of 12 or more list words, so a phrase with a list word before or after it is still
  caught; the checksum is not required, since a mistyped phrase still gives most of a wallet away.
- The guards also read edited messages and captions; in groups they need Cairn to be an administrator.
- `CAIRN_BLOCKLIST` replaces the starter list rather than adding to it; it is reloaded when the file changes.

### State and delivery

Use a dedicated `CAIRN_DATA` directory per bot. It is mode 700 and files are mode 600. State is one SQLite
file, `state.db` (`node:sqlite`), with a rollback journal and `secure_delete`, so a deleted label or alert
leaves no copy in `CAIRN_DATA`; temporary tables stay in memory, so nothing is written elsewhere. A round 1
`state.json` is carried over once (its update offset and command list), then removed. A process lock rejects
a second owner of the same data directory using a separate SQLite exclusive transaction; the OS releases it
after a kill. State and lock files reject symbolic links and hard links. Corrupt state is refused, never reset.
Round 3 adds the feeds, the name cache, a forum topic per subscription and per alert, and each pending
alert's digest for summaries: a round 2 `state.db` gains them in place, in one transaction, on first start.
Round 4 adds the chats with network alerts (`network`), each chat's guard switches when not the defaults
(`guards`), the hash and time of recent blocks scanned (`blocks`), the head first seen and the current stall
and outage (in `meta`), and on each delivery the message a correction replies to (`reply_to`) and when its
transaction left every block (`doubt_since`); a round 2 or 3 `state.db` gains them the same way.

**Commands.** Each update's change and its offset are saved in one transaction **before** the reply is sent:
a kill can lose a reply, never replay an accepted one.

**Alerts.** Each alert is keyed by (chat, transaction hash, `event_index`) and saved as pending in the same
transaction that moves the cursor past its block. It is marked sent, with its `message_id`, only once
Telegram accepts it; its text is then dropped and the key kept for 7 days of chain time. A kill before
Telegram accepts an alert leaves it pending, and the next pass sends it; a confirmed alert is never sent
again, across restarts, rescans and failed pages. Telegram's `sendMessage` has no idempotency key, so one
window remains: a kill after Telegram accepted a message but before Cairn recorded it sends that one
alert again on restart. A 403 or a `my_chat_member` update to kicked or left pauses the chat (its alerts
wait) until it writes again or re-adds the bot; so do a restriction that bars the bot from writing and a 400
saying it may not write there. A `migrate_to_chat_id` moves the chat's data to the new id and resends there.
Any other refusal drops that one alert with a warning in the logs.

### Operator troubleshooting

| Symptom | Action |
| --- | --- |
| Exit 2 before any requests | Check the named setting or token-registry entry; all configuration comes from the environment. |
| Exit 2 naming another chain or an old RPC spec | Use a node on `CAIRN_CHAIN` with JSON-RPC 0.10.0 or later. |
| Exit 3 / Telegram 401 | Replace the rejected BotFather token; repeated restarts cannot fix it. |
| Exit 1 / Telegram 409 or instance lock | Stop the other owner. Run one process per token and one owner per data directory. |
| `node busy` | Check your configured RPC origin and provider limits. The bot never tries a fallback host. |
| `blocks … will be scanned again` in the logs, repeatedly | The node refuses or fails the chain-wide `getEvents` filter; the cursor waits for it. Check the provider's limits on event filters without an address. |
| One token has an error | Other registry balances remain available; inspect that contract's deployment and entrypoints. |
| `state.db` or `state.json` invalid, or an unsafe state file | Stop the process and restore a consistent backup; do not reset the offset to replay old updates. |
| A chat receives no alerts | Check `/list`; a chat that blocked or removed the bot is paused until it writes again or re-adds it. |
| `/feed`, `/price` or a name says it is off | The network file lacks that contract (`contracts.ekubo_core` and `contracts.avnu_exchange`, `contracts.pragma`, `contracts.naming`). |
| Posts and alerts show no USD value | `/price` shows why: no pair for the token, no price, or a price older than `CAIRN_PRICE_MAX_AGE`; unverified tokens never get one. |
| A feed posts nothing | Check its floor in `/list`; a token that only passes through AVNU routes, or trades in round trips, nets to zero. |
| Exit 2 naming an endpoint and another chain | Every URL of `STARKNET_RPC_URLS` must serve `CAIRN_CHAIN`; `doctor` prints each one's chain. |
| `/healthz` says `rpc` | Every endpoint fails: check their keys and limits (`cairn_rpc_errors_total{endpoint}` says which); alerts wait in the ledger. |
| `/healthz` says `telegram` | Telegram cannot be reached from the host (DNS, firewall, proxy); Cairn retries, from 1 s up to every 30 s. |
| `/healthz` says `stalled` | No new block for `CAIRN_STALL_SECONDS`: check the explorer; with several endpoints, all of them are stuck. |
| A seed phrase or a listed link stays up in a group | `/guard` says whether the guard is on and whether Cairn is an administrator with the Delete messages right. |
| A correction after a reorg | The alert's transaction is no longer on chain; `CAIRN_CONFIRMATIONS` trades delay for fewer of them. |

### Checks

```sh
npm run check       # rounds 1 to 4: node .launchpad/checks/round-<n>/run.mjs
npm test            # node --test test/*.test.mjs
npm run transcript  # round 4's network, reorg and guard scenarios, on the checks' fakes, printed as a chat
```

Without Node.js 24 on the machine, the same through Docker:
`docker run --rm -v "$PWD":/app -w /app node:24-alpine node scripts/transcript.mjs`.

The published checks use local fake Telegram and Starknet services and exercise the CLI as child
processes, including kills, retries, strict host limits and credential scans. The unit tests cover
redirects, ambiguous sends, corruption, concurrent state owners, symlinks and hard links, the round 1
upgrade, full-range u256 arithmetic, typed amounts, short-string and ByteArray symbols, decoding by shape,
paging and restarts, the ledger, `/forget` leaving no bytes behind, rate limits and the alert rules; from
round 3, every name vector of ARCHITECTURE.md and the names refused, both venue layouts, the netting rules on
the fixtures and on a recorded mainnet AVNU route, the trader rule and the fee, both Pragma layouts, exact
USD rounding, the size bar, the group budget and its summary, one feed per chat, the round 2 to 3 state
migration and the network file's new keys; from round 4, the seed-phrase runs (numbered lists, interruptions,
case) and warnings free of list words, link hosts against userinfo, paths and look-alikes, the blocklist file
format, failover order and `Retry-After`, endpoint errors, pinned continuation pages, the stall, recovery and
outage notices, corrections and the reorg verdicts, the gap and the health and metrics answers. They use Node
built-ins only.

For post-competition maintenance, GitHub CI verifies that all four rounds are closed and their checks are
unchanged, runs all 132 frozen acceptance checks in the pinned runner, then runs the application tests.
An active or additional round cannot use that fallback. The historical round checks remain unchanged.

## Build it with your agent

The planned competition is complete. To improve the application with your coding agent, use:

```text
Improve 0xNad/cairn from current main. Read ARCHITECTURE.md and README.md, preserve the read-only chain boundary, and never change the historical .launchpad/checks or publish credentials. Add focused regression tests, run npm test and npm run check in an isolated environment, and prepare a pull request. Do not enter or create another Hotpod round.
```
