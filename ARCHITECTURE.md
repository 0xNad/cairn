# Architecture

Cairn is an open-source Telegram bot for Starknet that anyone can host. It answers balance and transaction
lookups in chat, alerts a chat when a watched wallet moves any token or grants an approval, posts a project
group's trades with USD values and .stark names, and warns when the chain stalls or reorganises. It only
reads the chain, over any Starknet JSON-RPC 0.10 node, and runs as one Node.js 24 process.

This file is the plan agreed before the launch. It fixes the lines every entry builds inside: commands,
variables, file formats, message formats, selectors, call layouts and exit codes. The checks follow it to
the letter. Entries differ inside these lines, never on them. What each round must do is in its brief in
[`.launchpad/project.md`](.launchpad/project.md); when the two disagree, the brief wins.

## Ground rules, every round

- **Read-only, no custody.** No `starknet_add*` call, ever. Cairn holds no key, asks for no seed phrase,
  signs nothing and builds no signing link.
- **A plain bot.** No Mini App, no `web_app` or `login_url` button, no wallet connection, no payments.
- **Only the configured hosts.** Cairn contacts `TELEGRAM_API_ROOT` and its RPC URL (from round 4, its RPC
  URLs), and nothing else: no telemetry, no fallback RPC, no price API. `CAIRN_EXPLORER_URL` only builds
  links and is never fetched. A later round can add a host only through an opt-in `*_URL` variable that is
  off when unset.
- **Secrets come from the environment only**, never from flags (flags show up in `ps`). The bot token and
  the RPC URLs appear in no output, log, message, data file or request to the other host. The repository
  holds no token, key or seed phrase.
- **The chain is the clock.** "Now" is the timestamp of the latest block Cairn has read. Per-user rate
  limits use `message.date`. The wall clock is used only for backoff, timeouts, logs and, in round 4, stall
  detection.
- **No dependencies** (decided 13 Oct). Node.js 24 built-ins only: `package.json` declares
  `"engines":{"node":">=24"}`, its `dependencies` and `devDependencies` are empty, and `package-lock.json`
  is committed. `node:sqlite` is allowed for state. No `better-sqlite3`, no starknet.js, no Telegram
  framework: every selector and layout Cairn needs is in this file, and nothing hashes or signs.
- **Standard output carries only the command's JSON line.** Reasons and logs go to standard error.
- **Every earlier round keeps working:** each round re-runs every earlier round's checks.
- **The interface is frozen in round 1, and later rounds only add.** Commands, variables, file formats
  and JSON shapes are never renamed or removed.

## The rounds

| # | Title | What it adds | How it is checked |
| --- | --- | --- | --- |
| 1 | Lookups | The frozen interface; `run`, `tick` and `doctor`; `/start`, `/help`, `/status`, `/balance`, `/tx`; group addressing; retries and rate limits; the security baseline; the starter network files | Child processes against a fake Telegram, a fake node and a network trap; bad environments and network files; kills and restarts |
| 2 | Wallet alerts, every token | Watches, whales, floors and mutes on every ERC-20 through one chain-wide events filter; unverified tokens; approval alerts; `/track`; buttons; exactly-once delivery; admin gating; rate limits; `/export` and `/forget` | Event fixtures in both layouts, a token outside the registry, a spam symbol, a legacy NFT, paging, a kill during a send, restarts, migration, 403 |
| 3 | Group feeds, prices and names | The Ekubo and AVNU trade feed; Pragma prices and USD values; .stark names; the group budget; forum topics | Recorded swap layouts (direct, aggregator, multi-hop, round trip, relayed); fake Pragma and naming contracts |
| 4 | Network guard and operations | Stall and recovery alerts, reorg corrections, confirmations, failover, gap skip, `/healthz` and `/metrics`, seed-phrase and phishing-link guards, the deploy guide | A frozen head, a replayed reorg, two fake nodes, HTTP probes, guard fixtures |

### What each round adds to the interface

| Round | Commands in chat | Variables | Network file | Output lines | Bot API methods | RPC methods |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `/start [payload]`, `/help`, `/status`, `/balance <address>`, `/tx <hash>` | the 12 below | `chain`, `tokens[].symbol`, `address`, `decimals` | `tick`, `doctor` | see [Telegram](#telegram-transport) | see [Starknet](#starknet-access) |
| 2 | `/watch <address> [label]`, `/unwatch <address\|label>`, `/list`, `/whale <SYMBOL\|token address> <amount>`, `/unwhale <SYMBOL\|token address>`, `/min <SYMBOL\|token address> <amount>`, `/mute <token address>`, `/unmute <token address>`, `/balance <address> [SYMBOL\|token address]`, `/track <hash>`, `/export`, `/forget`; a pasted address or hash in a private chat | `CAIRN_MAX_BLOCKS`, `CAIRN_MAX_WATCHES` | (the registry now means "verified") | `tick` adds `"alerts"`, `"cursor"` | `answerCallbackQuery`, `editMessageText`, `getChatMember` | `starknet_getEvents` |
| 3 | `/feed <SYMBOL\|address> [<min>\|$<usd>] [buys\|all]`, `/unfeed`, `/price [SYMBOL…]`; a `name.stark` wherever an address is | `CAIRN_PRICE_MAX_AGE` | `contracts.pragma`, `contracts.ekubo_core`, `contracts.avnu_exchange`, `contracts.naming`, `tokens[].pragma_pair` | | | |
| 4 | `/network on\|off`, `/guard seed\|links on\|off` | `STARKNET_RPC_URLS`, `CAIRN_CONFIRMATIONS`, `CAIRN_STALL_SECONDS`, `CAIRN_REORG_DEPTH`, `CAIRN_MAX_GAP`, `CAIRN_OPERATOR_CHAT`, `CAIRN_HTTP_PORT`, `CAIRN_HTTP_HOST`, `CAIRN_BLOCKLIST` | | `GET /healthz`, `GET /metrics` | `deleteMessage` | |

In groups, round 2's commands except `/list` need an administrator, and so do `/feed`, `/unfeed` (round
3), `/network` and `/guard` (round 4). Round 1's lookups stay open to every member, as round 1's checks
require.

### Decisions that later rounds keep

- **One scanner (round 2).** Every block range is read once, by the chain-wide `Transfer`/`Approval`
  filter. Round 3 adds one filter per venue on the same ranges; round 4's reorg handling rescans through
  the same scanner.
- **One delivery ledger (round 2).** Each alert is keyed by (chat, transaction hash, `event_index`), saved
  before it is sent, and marked sent, with its `message_id`, only once Telegram accepts it. Round 4's
  corrections reply to that stored `message_id`.
- **The registry is the list of verified tokens (round 2).** It no longer limits what Cairn sees. Any
  other ERC-20 is read from its contract and shown as unverified: its symbol in `<code>`, never a link and
  never a USD value.
- **The trader comes from the token's `Transfer` flows (round 3)**, never from the transaction's sender or
  the AVNU `beneficiary`.

## The command line

```text
node cairn.mjs run
node cairn.mjs tick
node cairn.mjs doctor
```

There are no flags: all configuration comes from the environment.

- `node cairn.mjs run` long-polls Telegram and answers commands until SIGTERM or SIGINT, then exits 0
  within 3 s. It calls `deleteWebhook` once at start and never `setWebhook`.
- `node cairn.mjs tick` does one pass: it drains pending updates (`getUpdates` with `timeout` 0 until
  empty), answers them, confirms the offset, then prints one JSON line,
  `{"updates":<n>,"sent":<n>,"head":<block number>|null}`, and exits.
- `node cairn.mjs doctor` calls `getMe`, `starknet_chainId`, `starknet_specVersion` and
  `starknet_blockNumber`, then prints one line, `{"bot":"<username>","chain":"SN_MAIN","block":<n>,"spec":"0.10.3"}`.

Details every entry follows:

- `run` answers a command within 3 s. It calls `deleteWebhook` with `drop_pending_updates` false, and on
  SIGTERM aborts a held `getUpdates` (for example with an `AbortController`) so that it exits in time.
- `sent` counts the messages Telegram accepted during the pass. `updates` counts the updates handled.
- From round 2, `tick`'s line also holds `"alerts":<n>` and `"cursor":<n>` (the last block scanned).
- Later rounds may add keys to these lines. They never rename or remove one, and checks ignore keys they
  do not know.
- `run` and `tick` call `setMyCommands` whenever the stored command list differs from the current one.
- `run` and `tick` check `starknet_chainId` and `starknet_specVersion` once per process, before the first
  other chain call.
- `doctor`'s `chain` is the decoded chain id and `spec` the node's own string.

### Exit codes

| Exit | Meaning |
| --- | --- |
| 0 | Done (`tick` also exits 0 when the node is unreachable: `head` is `null` and commands get a "node busy" reply) |
| 1 | Telegram unreachable, the node unreachable (`doctor` only) or a 409 conflict ("another instance is running") |
| 2 | A bad command line, environment value or network file, detected **before any network call**, or a node on another chain than `CAIRN_CHAIN`, or a node whose spec version is below 0.10.0. From round 4, also endpoints on different chains |
| 3 | Telegram rejected the token (401) |

Reasons go to standard error, never to standard output. An exit 2 prints nothing on standard output, and
a chain or version refusal names what the node reported. Exit 3 is kept apart from 1 so that a supervisor
does not restart in a loop. After any exit the stored state stays consistent.

### One pass

The shape of a pass, the same in `run` and `tick` (the step order is suggested; the rules in it are fixed):

```text
1. head      starknet_getBlockWithTxHashes("latest"): number, hash, timestamp (chain time), sequencer_address.
             On failure head = null, and commands that need the chain reply "node busy".
2. updates   getUpdates from the saved offset; handle each in order. A subscribing command records
             since_block = head. Each change and the update_id are saved before the reply is sent.
3. scan      (round 2+) blocks (cursor, min(head - CAIRN_CONFIRMATIONS, cursor + CAIRN_MAX_BLOCKS)]
             -> events -> pending alerts, saved.
4. periodic  (round 4) stall and reorg checks.
5. deliver   pending -> sendMessage -> marked sent, with its message_id, only once Telegram accepts it
             (round 3: the group budget).
6. save      the cursor and recent block hashes; confirm the offset.
run  = a pass every CAIRN_POLL_MS, long-polling getUpdates in between.
tick = one pass with getUpdates timeout 0, drained until empty, then one JSON line on standard output.
```

On the first start the cursor is set to the head, so Cairn never backfills.

## The environment

Secrets come only from here, never from flags. A value out of range, or a numeric value that is not a
whole number in decimal digits, exits 2. A round ignores variables that later rounds introduce, and
earlier rounds' checks never set them.

**Round 1** reads these twelve:

| Variable | Default | Rule |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | required | `^\d+:[A-Za-z0-9_-]{30,}$`; a secret |
| `TELEGRAM_API_ROOT` | `https://api.telegram.org` | an http(s) origin, no path; calls go to `${root}/bot${token}/<method>` |
| `STARKNET_RPC_URL` | required, no default | an http(s) URL; a secret, since providers put keys in the path; logs show its origin only |
| `CAIRN_CHAIN` | `SN_MAIN` | `SN_MAIN` or `SN_SEPOLIA`, compared with the decoded `starknet_chainId` |
| `CAIRN_NETWORK_FILE` | `networks/<CAIRN_CHAIN>.json` next to `cairn.mjs` | the token registry, below |
| `CAIRN_DATA` | `./data` | created with mode 700, files 600; nothing is written anywhere else |
| `CAIRN_EXPLORER_URL` | `https://voyager.online` | only builds links (`/tx/<hash>`, `/contract/<address>`), never fetched |
| `CAIRN_POLL_MS` | 10000 | at least 50 |
| `CAIRN_TG_TIMEOUT` | 30 | long-poll seconds in `run`, 0 to 50 |
| `CAIRN_RPC_RPS` | 5 | 1 to 100: the most JSON-RPC calls in any 1 s window, each call in a batch counted |
| `CAIRN_RPC_TIMEOUT_MS` | 10000 | at least 100 |
| `CAIRN_LOG` | `info` | `error`, `warn`, `info` or `debug`; one JSON object per line, on standard error only |

Notes on round 1's variables:

- `TELEGRAM_API_ROOT` has no trailing slash. `api.telegram.org` is never hardcoded in a request.
- `starknet_chainId` answers `0x534e5f4d41494e` for `SN_MAIN` and `0x534e5f5345504f4c4941` for
  `SN_SEPOLIA` (the names as short strings).
- An operator on Sepolia sets `CAIRN_EXPLORER_URL=https://sepolia.voyager.online`; the default does not
  change with the chain.
- The checks use `CAIRN_POLL_MS=100`, `CAIRN_TG_TIMEOUT=1` and `CAIRN_RPC_TIMEOUT_MS=1500`.

**Later rounds:**

| Variable | Round | Default | Rule |
| --- | --- | --- | --- |
| `CAIRN_MAX_BLOCKS` | 2 | 500 | 1 to 10000: blocks scanned per pass |
| `CAIRN_MAX_WATCHES` | 2 | 20 | 1 to 200: watches per chat |
| `CAIRN_PRICE_MAX_AGE` | 3 | 900 | seconds of chain time before a price is stale |
| `STARKNET_RPC_URLS` | 4 | unset | a comma-separated failover list; when set, it replaces `STARKNET_RPC_URL`; every entry is a secret |
| `CAIRN_CONFIRMATIONS` | 4 | 0 | 0 to 100: scan only blocks this deep |
| `CAIRN_STALL_SECONDS` | 4 | 120 | at least 2, wall clock |
| `CAIRN_REORG_DEPTH` | 4 | 64 | 1 to 1000: block hashes kept, and the deepest walk-back |
| `CAIRN_MAX_GAP` | 4 | 50000 | blocks (about 25 h at 1.78 s per block) |
| `CAIRN_OPERATOR_CHAT` | 4 | unset | the chat id that receives node-down notices |
| `CAIRN_HTTP_PORT` | 4 | unset (off) | `0` means any free port, logged as `{"level":"info","event":"http","port":<n>}` |
| `CAIRN_HTTP_HOST` | 4 | `127.0.0.1` | the bind address |
| `CAIRN_BLOCKLIST` | 4 | `blocklist/domains.txt` next to `cairn.mjs` | one domain per line; `#` starts a comment |

## The network file

```json
{
  "chain": "SN_MAIN",
  "tokens": [
    {"symbol": "STRK", "address": "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
     "decimals": 18, "pragma_pair": "STRK/USD"}
  ],
  "contracts": {"pragma": "0x…", "ekubo_core": "0x…", "avnu_exchange": "0x…", "naming": "0x…"}
}
```

`{"chain":"SN_MAIN","tokens":[{"symbol","address","decimals"}…]}`:

- `chain` equals `CAIRN_CHAIN`;
- 1 to 50 tokens;
- `symbol` matching `^[A-Za-z0-9.]{1,11}$` and unique ignoring case;
- `address` valid (see [input validation](#input-validation)) and unique once normalised;
- `decimals` an integer from 0 to 36.

Other keys are ignored in round 1, so the starter files may already hold round 3's keys.

From round 3, `pragma_pair` must match `^[A-Z0-9]{1,10}/[A-Z0-9]{1,10}$`, and each entry in `contracts`
must be a valid address. A missing contract switches its feature off, with a reply saying so; it never
exits 2.

**Validation messages.** A bad entry exits 2 naming its path, for example
`networks/SN_MAIN.json: tokens[3].decimals: …`. The form is `<file>: <JSON path>: <reason>`, with array
indexes counted from 0 and the reason in plain words. A file that is missing, unreadable or not JSON gets
`<file>: <reason>`.

**What the registry means.** In round 1 it is the list `/balance` reads, in order. From round 2 it is the
list of verified tokens: their symbols, decimals and Pragma pairs drive the default `/balance` list, the
USD values and the "verified" status. It no longer limits what Cairn sees.

## The starter registry

Commit `networks/SN_MAIN.json` with STRK, ETH, USDC, USDC.e, USDT and WBTC, and `networks/SN_SEPOLIA.json`
with the four Sepolia tokens. The checks assert the shape and the symbols; the creator and the judges
review the addresses. Decimals and Transfer layouts below were read on chain on 13 Oct 2026.

**Mainnet (`SN_MAIN`)**

| Symbol | Address | Decimals | Transfer layout | `pragma_pair` (round 3) |
| --- | --- | --- | --- | --- |
| STRK | `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d` | 18 | modern | `STRK/USD` (8 decimals) |
| ETH | `0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7` | 18 | modern | `ETH/USD` (8) |
| USDC | `0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb` | 6 | modern | `USDC/USD` (6) |
| USDC.e | `0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8` | 6 | legacy | `USDC/USD` (6), an assumed peg |
| USDT | `0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8` | 6 | modern | `USDT/USD` (6) |
| WBTC | `0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac` | 8 | legacy | `WBTC/USD` (8) |

USDC is the native token; USDC.e is the bridged one.

**Sepolia (`SN_SEPOLIA`)**

| Symbol | Address | Decimals | Transfer layout |
| --- | --- | --- | --- |
| STRK | `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d` (as mainnet) | 18 | modern |
| ETH | `0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7` (as mainnet) | 18 | modern |
| USDC | `0x0512feac6339ff7889822cb5aa2a86c848e9d392bb0e3e237c008674feed8343` | 6 | modern |
| USDC.e | `0x053b40a647cedfca6ca84f542a0fe36736031905a9639a7f19a3c1e66bfd5080` | 6 | legacy |

Sepolia's Pragma answered `STRK/USD` on 13 Oct; its other pairs are to be confirmed before round 3.

**Contracts (round 3)**

| Key | Mainnet | Sepolia |
| --- | --- | --- |
| `pragma` | `0x02a85bd616f912537c50a49a4076db02c00b29b2cdc8a197ce92ed1837fa875b` | `0x036031daa264c24520b11d93af622c848b2499b66b41d611bac95e13cfca131a` |
| `ekubo_core` | `0x00000005dd3d2f4429af886cd1a3b08289dbcea99a294197e9eb43b0e0325b4b` | absent: the feed is off on Sepolia |
| `avnu_exchange` | `0x04270219d365d6b017231b52e92b3fb5d7c8378b05e9abc97724537a80e93b0f` | absent: the feed is off on Sepolia |
| `naming` | `0x06ac597f8116f886fa1c97a23fa4e08299975ecaf6b598873ca6792b9bbfb678` | `0x00000154bc2e1af9260b9e66af0e9c46fc757ff893b3ff6a85718a810baf1474` |

## State and the data directory

- **Recommended store:** `node:sqlite` (`DatabaseSync`) at `$CAIRN_DATA/state.db`. It runs in Node 24 with
  no flag and no warning. **Also allowed:** one JSON file, written to a temporary file in `CAIRN_DATA`,
  fsynced, then renamed.
- **The format is the entry's own; the checks never parse it.** They assert behaviour: state survives a
  restart and a SIGKILL; a change is saved before its confirmation is sent; the directory has mode 700 and
  its files mode 600; nothing is written outside `CAIRN_DATA` (the checks snapshot the entry's tree, HOME
  and TMPDIR before and after); neither secret appears in any file; from round 2, no fixture user's name
  or username appears in any file.
- **Stored:** chat ids and types, settings, subscriptions and labels; the update offset and the command
  list sent; the cursor and the recent block hashes; the delivery ledger (key, state, `message_id`), kept
  for 7 days of chain time. From round 2: the token metadata cache (symbol and decimals, or "not a coin",
  kept for 7 days of chain time), muted tokens per chat, and the tokens seen moving for each watched
  address. From round 3: price samples and a name cache. From round 4: the time the head was first seen.
- **Never stored:** message text, names or usernames, the token, RPC URLs, or anything a seed guard
  matched.

## Output conventions

Fixed so that the checks can match exactly. Before comparing, the checks strip tags, unescape entities and
remove commas from numbers.

- **Messages** use `parse_mode: "HTML"` with link previews off (`link_preview_options:
  {"is_disabled": true}`), and are 1 to 4096 characters, counted as Telegram counts them (UTF-16 code
  units after entity parsing). Longer replies split at line breaks.
- **Escaping.** Every outside string (labels, symbols, names, revert reasons) is escaped: `&`, `<` and
  `>`, plus `"` inside attributes.
- **Amounts** are exact decimals computed with BigInt (u256 = low + high·2^128), trailing zeros trimmed,
  then the symbol: `1,234.5 STRK`. The decimal point is `.`; `,` grouping in the integer part is optional;
  there is no scientific notation. Fees in FRI are shown in STRK (FRI ÷ 10^18). Gas prices are exact FRI
  integers.
- **Addresses** are accepted with 1 to 64 hex digits in any case, normalised to `0x` and 64 lowercase
  digits, shown as `0x0471…938d` (`0x`, the first 4 and the last 4 of the 64 digits, joined by `…`) and
  linked as `${CAIRN_EXPLORER_URL}/contract/0x<64 hex>`. From round 2 a label, and from round 3 a verified
  name, may replace the short form.
- **Transactions** are normalised the same way and linked as `${CAIRN_EXPLORER_URL}/tx/0x<64 hex>`.
- **Times** are `YYYY-MM-DD HH:MM:SS UTC`.
- **USD (round 3):** `amount × price ÷ 10^(token decimals + pair decimals)`, rounded half up to cents, as
  `$1,234.57`; a non-zero value below a cent is `<$0.01`. Nothing is computed from a stale price or a
  missing one, and never for an unverified token.
- **Prices (round 3):** the exact oracle value with trailing zeros trimmed, with its age in chain time and
  its `num_sources_aggregated`.
- **Logs** go to standard error only, one JSON object per line with at least `level` and `event`, and
  never hold the token, an RPC path or query, or message text.

## Telegram transport

- **Requests:** `POST ${TELEGRAM_API_ROOT}/bot${TELEGRAM_BOT_TOKEN}/<method>` with a JSON body.
- **Updates: long polling only, in every round.** `setWebhook` is never called.
- **Offsets.** `getUpdates` takes `offset` = the last handled `update_id` + 1, and `timeout` =
  `CAIRN_TG_TIMEOUT` in `run` or 0 in `tick`. `tick` ends by confirming the offset with
  `getUpdates{"offset":<last + 1>,"limit":1,"timeout":0}`. An update is never handled twice, across ticks,
  restarts and a SIGKILL.
- **`allowed_updates`:** `["message"]` in round 1. Round 2 adds `"callback_query"` and `"my_chat_member"`.
- **Bot API methods.** This is the complete list; anything else gets 404 from the fake and fails a test.

  | Round | Methods |
  | --- | --- |
  | 1 | `getMe`, `deleteWebhook`, `getUpdates`, `sendMessage`, `setMyCommands`, and `sendChatAction` (optional) |
  | 2 | `answerCallbackQuery`, `editMessageText`, `getChatMember` |
  | 4 | `deleteMessage` (corrections use `sendMessage` with `reply_parameters`) |

- **Errors:**

  | Error | Handling |
  | --- | --- |
  | 429 | Wait exactly `parameters.retry_after`, then send that message once |
  | 403 (blocked or kicked) | Skip that chat and carry on. From round 2 the chat stays paused until it writes again or re-adds the bot |
  | 400 with `migrate_to_chat_id` | (round 2) Move the chat's data to the new id and resend |
  | 400 "message is not modified" | Ignore |
  | 401 | Exit 3 |
  | 409 | Exit 1, "another instance is running" |

  Cairn does not throttle sends in advance: `retry_after` is the signal, and from round 3 the group budget
  protects groups.
- **Groups.** Commands are parsed with `^/(\w+)(@(\w+))?`. Cairn answers `/cmd` and `/cmd@<its username
  from getMe>`, and ignores `/cmd@other_bot` and plain text. Unknown commands get a hint pointing to
  `/help`.
- **Administrators (round 2).** Admin means `getChatMember` returns status `creator` or `administrator`.
  Anonymous administrators count too: the planned rule is that a message whose `sender_chat.id` equals the
  chat id comes from an administrator posting as the group. This rule is to be confirmed before round 2's
  checks are committed.
- **Links and payloads (round 1).** `/start` and `/help` link `https://t.me/<username>?startgroup=setup`.
  A `/start` payload that does not match `^[A-Za-z0-9_-]{1,64}$` gets the plain welcome.
- **Buttons (round 2).** `callback_data` is `<verb>:<server id>`, at most 64 bytes, and never holds a full
  address (66 characters do not fit). Every `callback_query` is answered exactly once.
- **Seeing every message** in a group, which round 4's guards need, requires the bot to be an admin.

## Starknet access

**Transport.** HTTP JSON-RPC 0.10 or later, polled. No WebSocket subscriptions.

**Block ids.** Only `"latest"`, `{"block_number":<n>}` or `{"block_hash":"<h>"}`. Never `"pending"` or
`"pre_confirmed"`: the fake rejects both with -32602. `latest` is accepted on L2, which is final in
practice; pre-confirmed data is never alerted.

### Input validation

- An address is `0x` followed by 1 to 64 hex digits in any case, with 0 < v < 2^251 − 256.
- A hash is `0x` followed by 1 to 64 hex digits, a felt with 0 < v < P = 2^251 + 17·2^192 + 1.
- Values are compared only after normalising.
- An invalid address or hash is refused with a reason, before any call about it.

### RPC hygiene

- At most `CAIRN_RPC_RPS` calls in any 1 s window, each call inside a batch counted.
- On HTTP 429, 5xx or a timeout (`CAIRN_RPC_TIMEOUT_MS`): up to 3 tries with backoff of at least
  `Retry-After`, then a "node busy" reply.
- `starknet_getEvents` filters name at most one address. Round 2's `Transfer`/`Approval` filter names
  none, so it covers every token; round 3's venue filters name one each. `chunk_size` is 1000 (some
  providers refuse more than 1024). Every `continuation_token` is followed, and a continuation token is
  never reused on another endpoint.

### Errors

| Code | Meaning | Cairn's response |
| --- | --- | --- |
| 20 | Contract not found | "not deployed" |
| 21 | Entrypoint not found | Fall back to `balanceOf` |
| 24 | Block not found | Retry on the next pass |
| 29 | Transaction hash not found | "not found" |
| 33 | Invalid continuation token | Restart that range |
| 40 | Contract error | An error for that one item only |

### Methods by round

| Round | Methods |
| --- | --- |
| 1 | `starknet_specVersion`, `starknet_chainId`, `starknet_blockNumber`, `starknet_getBlockWithTxHashes` (header: `timestamp`, `sequencer_address`, `l1_gas_price`, `l1_data_gas_price`, `l2_gas_price`, each read in FRI), `starknet_call`, `starknet_getClassHashAt`, `starknet_getTransactionStatus`, `starknet_getTransactionReceipt` |
| 2 | `starknet_getEvents` (one chain-wide `Transfer`/`Approval` filter); `starknet_getBlockWithTxHashes` by number (the fee rule); `starknet_call` for `symbol` and `decimals` of tokens outside the registry |
| 3 | `starknet_getEvents` on `ekubo_core` (`Swapped`) and `avnu_exchange` (`Swap`); `starknet_call` at `{"block_number"}` (the new-holder flag). No `starknet_getTransactionByHash`: the trader comes from `Transfer` flows |
| 4 | `starknet_getBlockWithTxHashes` by number, to compare block hashes |
| never | `starknet_add*`, WebSocket subscriptions, any host that is not configured |

## Event layouts

Felts are hex strings. `sel` is the event's selector (below), always `keys[0]`.

| Event | Keys | Data |
| --- | --- | --- |
| `Transfer`, modern (STRK, ETH, USDC, USDT) | `[sel, from, to]` | `[low, high]` |
| `Transfer`, legacy (USDC.e, WBTC) | `[sel]` | `[from, to, low, high]` |
| `Approval`, modern | `[sel, owner, spender]` | `[low, high]` |
| `Approval`, legacy | `[sel]` | `[owner, spender, low, high]` |

The amount is the u256 low + high·2^128.

**Decoding by shape (round 2).** The chain-wide filter returns every `Transfer` and `Approval` on Starknet,
from any contract. Each event is decoded by its shape alone:

| Keys | Data | Meaning |
| --- | --- | --- |
| 3 `[sel, a, b]` | 2 `[low, high]` | A modern ERC-20 event |
| 1 `[sel]` | 4 `[a, b, low, high]` | A legacy ERC-20 event when its contract answers `decimals` (0 to 36); otherwise a legacy NFT, which is ignored |
| any other shape | | Ignored, for example an NFT with its token id in the keys (5 keys, no data) |

On mainnet on 13 Oct 2026, 500 blocks held 6,348 `Transfer` 3/2, 1,560 `Approval` 3/2, 322 `Transfer` 1/4,
168 `Approval` 1/4 and 2 `Approval` 5/0 (keys/data).

**The fee payment.** The fee is paid by a STRK `Transfer` from the transaction's sender to the block
header's `sequencer_address`, and it is the last event of its transaction. Its amount equals the receipt's
`actual_fee.amount`. It is never alerted.

**Ekubo Core `Swapped` (round 3).** Keys `[sel]`, 21 data felts:

| Index | Field |
| --- | --- |
| 0 | `locker` (always a router; never the trader) |
| 1, 2 | `token0`, `token1` |
| 3 | `fee` |
| 4 | `tick_spacing` |
| 5 | `extension` |
| 6, 7 | `params.amount` (mag, sign) |
| 8 | `is_token1` |
| 9, 10 | `sqrt_ratio_limit` |
| 11 | `skip_ahead` |
| **12, 13** | **`delta.amount0` (mag, sign)** |
| **14, 15** | **`delta.amount1` (mag, sign)** |
| 16, 17 | `sqrt_ratio_after` |
| 18, 19 | `tick_after` |
| 20 | `liquidity_after` |

A signed amount (i129) is a magnitude felt and a sign felt; sign 1 means negative. **A positive delta means
paid into the pool.**

**AVNU exchange `Swap` (round 3).** Keys `[sel]`; data
`[taker, sell_token, sell_low, sell_high, buy_token, buy_low, buy_high, beneficiary]`. Neither `taker` nor
`beneficiary` identifies the trader: both can be a wrapper contract.

The per-transaction netting rule and the trader rule are in round 3's brief.

## Call layouts

Every call is `starknet_call` with `{"contract_address","entry_point_selector","calldata"}` and a block id
from the list above. A Cairo `Option` is tag 0 for Some (followed by its value) and tag 1 for None (a
single felt).

| Call | Calldata | Result felts |
| --- | --- | --- |
| `token.balance_of(owner)`, or `balanceOf` on error 21 | `[owner]` | `[low, high]` |
| `token.symbol()` | `[]` | One felt for a short string, otherwise a ByteArray `[n_full_words, words…, pending_word, pending_len]` |
| `token.decimals()` | `[]` | `[d]` |
| `token.total_supply()` / `totalSupply()` | `[]` | `[low, high]` |
| `pragma.get_data_median(SpotEntry(pair))` | `[0x0, shortstring(pair)]` | `[price, decimals, last_updated_timestamp, num_sources_aggregated, exp_tag, exp?]` |
| `naming.domain_to_address(domain, hint)` | `[n_labels, encode(label)…, 0]` | `[address]` |
| `naming.address_to_domain(address, hint)` | `[address, 0]` | `[n, label…]` |

- **Short strings** are ASCII bytes read as one big-endian number: USDC.e's `symbol` answers
  `["0x55534443"]` (`USDC`).
- **ByteArray.** Each full word holds 31 bytes; the pending word holds `pending_len` bytes, big-endian. On
  mainnet STRK's `symbol` answers `["0x0", "0x5354524b", "0x4"]` (no full word, `STRK`, 4 bytes).
- **Decimals.** From round 2, a `decimals` answer outside 0 to 36, or an error, means the contract is not
  a coin.
- **Pragma.** The pair is a short string (`STRK/USD` is `0x5354524b2f555344`); `0x0` is the `SpotEntry`
  variant. The price is scaled by the `decimals` in the answer. **A pair Pragma does not have answers
  price 0, decimals 0 and timestamp 0, with no error: that means "no price".**
- **Naming.** The trailing `0` in both calldatas is an empty hint (an array of length 0). **An address of
  0x0 means the name is unknown**, and it is refused. **`[0]` means the address has no name.**

## Selectors

sn_keccak values (`node:crypto` has no keccak, so they are listed here). All thirteen were recomputed and
match.

```text
Transfer            0x0099cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9
Approval            0x0134692b230b9e1ffa39098904722134159652b09c5bc41d88d6698779d228ff
balance_of          0x035a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33
balanceOf           0x02e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e
decimals            0x004c4fb1ab068f6039d5780c68dd0fa2f8742cceb3426d19667778ca7f3518a9
symbol              0x0216b05c387bab9ac31918a3e61672f4618601f3c598a2f3f2710f37053e1ea4
total_supply        0x01557182e4359a1f0c6301278e8f5b35a776ab58d39892581e357578fb287836
totalSupply         0x0080aa9fdbfaf9615e4afc7f5f722e265daca5ccc655360fa5ccacf9c267936d
Swapped (Ekubo)     0x0157717768aca88da4ac4279765f09f4d0151823d573537fbbeb950cdbd9a870
Swap (AVNU)         0x00e316f0d9d2a3affa97de1d99bb2aac0538e2666d0d8545545ead241ef0ccab
get_data_median     0x0024b869ce68dd257b370701ca16e4aaf9c6483ff6805d04ba7661f3a0b6ce59
domain_to_address   0x02e269d930f6d7ab92b15ce8ff9f5e63709391617e3465fff79ba6baf278ce60
address_to_domain   0x038b679fb029cc3f953635ed16ae4123da8214e726943920ba7706a0473e326a
```

Nodes may return felts without leading zeros (`0x99cd8b…`): compare selectors as numbers.

## Starknet ID names (round 3)

A name Cairn accepts is one label of `[a-z0-9-]` followed by `.stark`, such as `ben.stark`. Each label is
one felt, in base 38, little-endian, over the alphabet `abcdefghijklmnopqrstuvwxyz0123456789-`.

**Encoding a label**, for this alphabet:

1. Each character's digit is its index in the alphabet: `a` is 0, `z` 25, `0` 26, `9` 35, `-` 36.
2. The label's value is the sum of digit_i · 38^i, where i counts from 0 at the label's **first**
   character.
3. **The trailing `a` rule:** when the label's last character is `a`, its digit is 37 instead of 0.
   Otherwise a final 0 digit would vanish, and `banana` would encode like `banan`.

**Decoding a felt.** Repeatedly take the remainder and quotient by 38. A remainder from 0 to 36 is that
character. A remainder of 37 is an escape: when the quotient divided by 3 is 0, the quotient's remainder
by 3 gives `a` (0) and decoding stops; otherwise it encodes one of starknetid.js's two extra characters
(`这`, `来`). A name holding those characters can come back from `address_to_domain`; it is shown only if
it resolves back, like any other.

The rule above is settled: it is copied from starknetid.js 5.0.0 (`packages/core/dist/utils.js`, MIT,
Copyright (c) 2023 Starknet.id), whose two functions follow unchanged except for formatting. For a
`[a-z0-9-]` label, `encode` reduces to the three steps above. A domain is encoded label by label in
reading order (`domainLabels = name.replace(".stark","").split(".")`), and `address_to_domain`'s labels
come back in the same order.

```js
const basicAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789-";
const basicSizePlusOne = BigInt(basicAlphabet.length + 1); // 38
const bigAlphabet = "这来";
const basicAlphabetSize = BigInt(basicAlphabet.length); // 37
const bigAlphabetSize = BigInt(bigAlphabet.length); // 2
const bigAlphabetSizePlusOne = BigInt(bigAlphabet.length + 1); // 3

function extractStars(str) {
  let k = 0;
  while (str.endsWith(bigAlphabet[bigAlphabet.length - 1])) {
    str = str.substring(0, str.length - 1);
    k += 1;
  }
  return [str, k];
}

function decode(felt) {
  let decoded = "";
  while (felt !== 0n) {
    const code = felt % basicSizePlusOne;
    felt /= basicSizePlusOne;
    if (code === BigInt(basicAlphabet.length)) {
      const nextSubdomain = felt / bigAlphabetSizePlusOne;
      if (nextSubdomain === 0n) {
        const code2 = felt % bigAlphabetSizePlusOne;
        felt = nextSubdomain;
        if (code2 === 0n) decoded += basicAlphabet[0];
        else decoded += bigAlphabet[Number(code2) - 1];
      } else {
        const code2 = felt % bigAlphabetSize;
        decoded += bigAlphabet[Number(code2)];
        felt /= bigAlphabetSize;
      }
    } else decoded += basicAlphabet[Number(code)];
  }
  const [str, k] = extractStars(decoded);
  if (k)
    decoded = str + (k % 2 === 0
      ? bigAlphabet[bigAlphabet.length - 1].repeat(k / 2 - 1) + bigAlphabet[0] + basicAlphabet[1]
      : bigAlphabet[bigAlphabet.length - 1].repeat((k - 1) / 2 + 1));
  return decoded;
}

function encode(decoded) {
  let encoded = 0n;
  let multiplier = 1n;
  if (!decoded) return encoded;
  if (decoded.endsWith(bigAlphabet[0] + basicAlphabet[1])) {
    const [str, k] = extractStars(decoded.substring(0, decoded.length - 2));
    decoded = str + bigAlphabet[bigAlphabet.length - 1].repeat(2 * (k + 1));
  } else {
    const [str, k] = extractStars(decoded);
    if (k) decoded = str + bigAlphabet[bigAlphabet.length - 1].repeat(1 + 2 * (k - 1));
  }
  for (let i = 0; i < decoded.length; i += 1) {
    const char = decoded[i];
    const index = basicAlphabet.indexOf(char);
    const bnIndex = BigInt(basicAlphabet.indexOf(char));
    if (index !== -1) {
      if (i === decoded.length - 1 && decoded[i] === basicAlphabet[0]) {
        encoded += multiplier * basicAlphabetSize;
        multiplier *= basicSizePlusOne;
        multiplier *= basicSizePlusOne;
      } else {
        encoded += multiplier * bnIndex;
        multiplier *= basicSizePlusOne;
      }
    } else if (bigAlphabet.indexOf(char) !== -1) {
      encoded += multiplier * basicAlphabetSize;
      multiplier *= basicSizePlusOne;
      const newid = (i === decoded.length - 1 ? 1 : 0) + bigAlphabet.indexOf(char);
      encoded += multiplier * BigInt(newid);
      multiplier *= bigAlphabetSize;
    }
  }
  return encoded;
}
```

A label whose encoding is not below P cannot exist on chain; Cairn refuses it like an unknown name.

**Test vectors.** Every vector decodes back to its label. "Mainnet" marks the names checked read-only on
13 Oct 2026 at block 16,314,862 against the mainnet naming contract: `domain_to_address` returned a
non-zero address, and `address_to_domain` of that address returned exactly this felt.

| Label | Felt | Decimal | Mainnet |
| --- | --- | --- | --- |
| `a` | `0x25` | 37 | forward and reverse |
| `b` | `0x1` | 1 | |
| `aa` | `0x57e` | 1406 | forward only (its address's reverse name is another name) |
| `ab` | `0x26` | 38 | |
| `ba` | `0x57f` | 1407 | |
| `ben` | `0x49ed` | 18925 | forward and reverse |
| `alpha` | `0x49f69f6` | 77556214 | forward and reverse |
| `anna` | `0x1f45fa` | 2049530 | forward and reverse |
| `nadia` | `0x49ffb09` | 77593353 | forward and reverse |
| `banana` | `0xb05c1d05` | 2958826757 | forward and reverse |
| `cairn` | `0x1ac06ca` | 28051146 | forward and reverse |
| `starknet` | `0x1fd32dc5fbc` | 2186991656892 | forward and reverse |
| `stark` | `0x14c695c` | 21784924 | |
| `zkorp` | `0x1ebcc55` | 32230485 | |
| `abc-123` | `0x14dc38343e` | 89594016830 | |
| `a1` | `0x402` | 1026 | |
| `1a` | `0x599` | 1433 | |
| `0` | `0x1a` | 26 | |
| `-` | `0x24` | 36 | |

`aa.stark` shows why the round-trip rule exists: it resolves to an address whose reverse name is a
different name, so that address is never shown as `aa.stark`.

**Subdomains** (`x.y.stark`) are not accepted as input in round 3. A reverse name with more than one label
is shown only if `domain_to_address` on the same labels, with an empty hint, returns the same address; an
error from that call means no name.

## Fixed files

| File | Purpose | Round |
| --- | --- | --- |
| `cairn.mjs` | The entry point | 1 |
| `networks/SN_MAIN.json`, `networks/SN_SEPOLIA.json` | The network files | 1 |
| `ARCHITECTURE.md` | This specification | 1 |
| `README.md`, `.env.example` | Placeholders that do not match the token pattern, such as `TELEGRAM_BOT_TOKEN=123456:replace-me` | 1 |
| `package.json`, `package-lock.json` | No dependencies; `"engines":{"node":">=24"}` | 1 |
| `LICENSE` | MIT | 1 |
| `wordlists/bip39-english.txt` | The seed-phrase guard's word list | 4 |
| `blocklist/domains.txt` | The phishing-link guard's starter list: `starknet-bot.com`, `app-stark.online`, `starknet.portal-drops.icu` | 4 |

The licence of the BIP-39 English word list is to be confirmed before round 4's checks are committed.

### Round 4's HTTP endpoint

With `CAIRN_HTTP_PORT` set, Cairn listens on `CAIRN_HTTP_HOST` and serves exactly two routes:

- `GET /healthz`: 200 `{"ok":true,"head":<n>,"lag_s":<n>}`, or 503 `{"ok":false,"reason":"stalled"|"rpc"|"telegram"}`;
- `GET /metrics`: Prometheus text with at least `cairn_head_block`, `cairn_updates_total`,
  `cairn_messages_sent_total`, `cairn_alerts_total` and `cairn_rpc_errors_total`.

Without `CAIRN_HTTP_PORT`, nothing listens.

### Round 2's export

`/export` replies with
`<pre>{"chat_id":…,"watches":[{"address","label","since_block"}],"whales":[{"token","symbol","min"}],"minimums":{"<token address>":"<amount>"},"tracks":[{"hash","since_block"}],"muted":["<token address>"]}</pre>`,
split at 4096 characters. Later rounds add keys; after `/forget` the lists are empty.

## Suggested layout

Only the names above are fixed. A layout that fits them:

```text
cairn.mjs            the command line: run, tick, doctor
src/config.mjs       the environment and the network file, validated before any network call
src/telegram.mjs     the Bot API client: long polling, offsets, 429/403/409 handling
src/rpc.mjs          JSON-RPC: the rate limit, retries, block ids
src/felt.mjs         u256, i129, short strings, ByteArray, address normalisation, Starknet ID encoding
src/format.mjs       HTML, escaping, amounts, addresses, times
src/store.mjs        state in CAIRN_DATA (node:sqlite)
src/commands/        one module per chat command
networks/            the starter network files
```

Round 2 adds a scanner, a decoder and a delivery ledger beside these; round 4 a network module.

## How the checks run

Each round's checks live in `.launchpad/checks/round-<n>/` and run with
`node .launchpad/checks/round-<n>/run.mjs`. They need no network: everything runs on 127.0.0.1.

- **The runner:** Node 24 in a container with `--network none` (loopback works), 2 CPUs and 2 GB. Each
  round's checks finish within 300 s, since every round re-runs all earlier ones.
- **Entries run as child processes.** The checks never import entry code: they run `node cairn.mjs …`
  through the vendored kit in `lib/`, each run in its own process group, killed at the end.
- **A fake Telegram Bot API** (`node:http` only) listens on `127.0.0.1:0` and routes `/bot<token>/<method>`:
  a wrong token gets 401 and an unknown method 404. Its `getUpdates` honours `offset`, `limit`, `timeout`
  and `allowed_updates`, and answers a second concurrent poll with 409. It validates like Telegram: HTML
  tags and entities, 1 to 4096 characters, `callback_data` of at most 64 bytes, and no `web_app` or
  `login_url` button. It injects 429 with `retry_after`, 403, 400 with `migrate_to_chat_id`, "message is
  not modified", and requests that never answer (for kill tests). It records every call.
- **A fake Starknet node** answers one POST route at any path, so that the checks can put a secret marker
  in the URL's path. It accepts batches and named or positional parameters, models blocks, contracts and
  transactions, returns at most 5 events per `getEvents` page with a continuation token (so every entry
  must page), uses the spec's error codes, and rejects `pending` and `pre_confirmed` with -32602. It
  injects 429, 503, delays, garbage, dropped connections, downtime, a frozen head and reorgs. It records
  every request; any `starknet_add*` call is a violation. Its contracts return exactly the layouts above,
  from recorded mainnet felts.
- **A network trap**, passed as `NODE_OPTIONS=--import=<trap>`, logs every `dns.lookup`,
  `dns.promises.lookup`, `net.connect`, `tls.connect` and `Socket.prototype.connect`. A host other than
  the two fakes fails the test; offline, an unknown host fails fast.
- **A test** starts both fakes, writes a network file pointing at the fake contracts, picks a fresh
  `CAIRN_DATA` that does not exist yet, and sets an environment holding a token marker and an RPC secret
  marker. Most tests drive `tick` with no sleeps. `run` tests set `CAIRN_POLL_MS=100` and
  `CAIRN_TG_TIMEOUT=1`, wait with deadline loops, prove that something did not happen with a barrier (a
  later `/status` and its reply), and stop the bot by killing its process group. Rate tests allow at most
  `CAIRN_RPC_RPS` + 1 calls in any 1 s, and a resend no earlier than 900 ms after `retry_after: 1`.
  Ordering is asserted only within a chat.

**Compatibility rules**, so that round n's winner keeps passing rounds 1 to n − 1:

1. Round 1's fakes already serve every method any round uses: the full Bot API list and every RPC method
   above, with empty or plausible answers.
2. Checks assert "at least" for anything later rounds grow: command lists, help text, JSON keys,
   network-file keys, export keys.
3. Checks look only at calls about the input under test, never at total call counts, because later
   rounds add background scanning.
4. Unknown-command tests use `/zz_unknown`.
5. No round adds an outbound host, except through an opt-in `*_URL` variable that is off when unset.
6. Each round copies the fakes into its own folder and extends the copy. Earlier folders never change.
7. Fixture commands from one user are at least 7 s of `message.date` apart, except in round 2's
   rate-limit test (10 commands per 60 s).
8. No earlier check sends more than 3 non-reply messages to one group in one pass. Multi-alert scenarios
   use private chats, because round 3's budget applies to groups.
9. Fixture block timestamps start at 2026-10-20T00:00:00Z and advance about 2 s per block. Nothing before
   round 4 depends on the wall clock, and round 4's stall rule uses the time the head stayed unchanged,
   not block timestamps.
10. No earlier fixture contains a run of 12 or more BIP-39 words, or a link to a blocklisted domain, and
    earlier checks never set a later round's variables.
