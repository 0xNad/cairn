# Wallet alerts

Run `node cairn.mjs doctor`, then `node cairn.mjs run`, using Node 24 or later. No dependencies
or installation scripts are needed. Supply credentials through the environment, as in the root README.
For groups, add the bot and configure it from an administrator account.

## Commands

| Command | Result |
| --- | --- |
| `/watch <address> [label]` | Watch transfers and owner approvals after the current head. Labels have at most 32 Unicode characters. |
| `/unwatch <address\|label>` | Remove a watch. If a label is ambiguous, use the address. |
| `/list` | Show watches with a Remove button for each. |
| `/whale <SYMBOL\|token address> <amount>` | Transfers at or above an exact decimal threshold, including mints and burns. |
| `/unwhale <SYMBOL\|token address>` | Remove that whale threshold. |
| `/min <SYMBOL\|token address> <amount>` | Set the watch transfer floor for a token. `0` removes the effective floor. |
| `/mute <token address>` | Silence transfers and approvals for this token in this chat. |
| `/unmute <token address>` | Restore future alerts for the token. |
| `/balance <address> [SYMBOL\|token address]` | Select any token, or show registry balances plus nonzero tokens seen moving for a watched wallet. |
| `/track <hash>` | L2 execution and fee, then L1 acceptance or a revert/failure reason. Unknown hashes expire after 600 seconds of chain time. |
| `/export` | JSON containing the chat's subscriptions, settings and operational records. |
| `/forget` | Remove all this chat's local records, including pending alerts. |

In a private chat, paste an address for balances and a Watch button. A recognized transaction hash gets
a transaction lookup and Track button. Addresses and hashes share the same syntax, so an unknown pasted
value is treated as an address; use `/tx` or `/track` explicitly for a hash that the node has not seen.

Groups permit `/list` and the original lookups for every member. Changes, tracking, export and deletion
require a creator or administrator. An anonymous administrator posting as the same group is accepted;
an unrelated `sender_chat` is not. Buttons check the clicking user's current membership, not the author
of the original message. Bot API failures never grant permission. Callback data contains only an opaque,
chat-scoped server ID; every callback is acknowledged, including refused and expired buttons.

Limits are per chat: 20 watches by default, 5 whale thresholds and 10 active tracks. Updating a watch or
threshold consumes no new slot and preserves its starting block. A user may send 10 commands in a rolling
60-second window of `message.date`, across chats. Further commands get one notice, then are ignored until
capacity returns. Numeric IDs and times support this limit; names and usernames are not retained.

## Configuration

The existing configuration and network registry remain valid.

| Variable | Default | Allowed values |
| --- | --- | --- |
| `CAIRN_MAX_WATCHES` | `20` | Decimal integer, 1–200 |
| `CAIRN_MAX_BLOCKS` | `500` | Decimal integer, 1–10000 |

Invalid settings fail before either API is contacted. A pass starts at the previous cursor and scans
at most `CAIRN_MAX_BLOCKS`; subsequent passes finish any backlog. The first start sets the cursor to the
head and never backfills. A subscription starts strictly after the head read when its command is handled,
even if the scanner is still catching up. Re-adding a removed wallet starts a new subscription.

## Alert contents

A transaction is grouped into one message per chat, in block and transaction order. Each matching event
appears once, even if it matches a watch and a whale threshold. Two identical receipt events remain two
lines. A transfer between two watched wallets names both; other transfers show in/out, the counterparty,
exact amount and any label. Approvals name the owner and spender. At least `2^128 - 1` is “unlimited.”
Every transaction message includes its block, UTC block time and explorer link.

An unregistered token is always displayed as `<code>symbol</code> · unverified` and its linked contract.
Symbols are limited to 11 characters, escaped, and stripped of controls and bidi formatting. They never
become links or acquire USD values. A contract spoofing a registry symbol remains unverified.

Zero transfers, NFT shapes, invalid decimals, muted tokens and transfers below a watch's floor produce
no alert. A whale threshold is independent of the watch floor, while mute applies to both. Discovered
holdings are recorded even when a floor or mute suppresses their notifications. Approval events do not
count as holdings.

The fee rule requires STRK, the last receipt event, the block sequencer, the transaction sender, and an
amount equal to `actual_fee.amount` in FRI. An ordinary transfer to the sequencer remains visible. The
implementation makes one read-only `starknet_getTransactionByHash` call only for a possible fee. This
lookup supplies the sender omitted by `getBlockWithTxHashes` and receipts; it is needed to apply the
frozen brief's sender condition without guessing. It is not used to attribute trades.

Telegram has a finite message size. A transaction too large for 4096 characters is split at complete
event lines into contiguous parts, with confirmation persisted for each part. No amount is rounded or
event silently truncated. An export is likewise split into messages; concatenate their text in order
with no separator to reconstruct the JSON.

## Scanner and token metadata

`src/scanner.mjs` retrieves a range with one chain-wide `starknet_getEvents` filter:

```json
{"keys":[["Transfer selector","Approval selector"]],"chunk_size":1000}
```

No contract address is set. Every continuation page is collected before anything is committed. Error 33
restarts the range once within the pass; persistent errors retry on a later pass. Repeated continuation
tokens are refused. The scanner fetches headers and receipts only for relevant transactions.

Receipt positions supply canonical `event_index` values, because real event pages need not include
indexes. This also tolerates overlapping pages without collapsing genuinely identical receipt events.
Block transaction lists establish delivery order. A mismatched receipt or missing transaction in its
block postpones the range.

`src/alerts.mjs` decodes modern 3-key/2-data and legacy 1-key/4-data shapes and applies chat rules.
`src/tokens.mjs` resolves verified registry tokens and lazily reads other contracts' decimals and symbol.
Short strings and Cairo ByteArrays are supported; malformed symbols use `TOKEN`, still unverified.
Invalid decimals or explicit contract/entrypoint errors cache “not a coin.” Transport and transient block
errors defer the scan, so an RPC outage never permanently classifies a real coin as an NFT.

Metadata is persisted for seven days of chain time, including negative entries, and refreshed on demand.
Tokens never relevant to a watch or whale do not trigger metadata calls. Amounts, thresholds and balances
use BigInt throughout.

## Durable delivery and crash boundaries

`src/ledger.mjs` owns the outbox. State changes, receipt indexes, pending messages and the new cursor
are written in a single atomic snapshot. Each snapshot is written to `state.next`, fsynced, renamed to
`state.json`, then the directory is fsynced. If a range fails, the entire range's staged changes roll back.
State version 2 imports the version 1 offset and command registration. Invalid persisted structures
are refused rather than repaired by discarding data.

| Interruption | Recovery |
| --- | --- |
| Before a scan snapshot commits | Cursor stays behind the range. Rescan it. |
| After commit, before a send | Pending alert is already durable. Send it after restart. |
| Telegram explicitly rejects a send | Retry permitted rejections; retain the pending alert if retries fail. |
| Telegram confirms, then local confirmation commits | Retain `message_id`; never resend the confirmed part. |
| Telegram accepts, but acknowledgement or the local confirmation is lost | Retry pending data; a duplicate is possible. |

There is no way to close the last interval with Telegram's `sendMessage`: it has no idempotency key and
no API to recover a message by a client delivery ID. The outbox chooses retry over silent loss. It
guarantees recovery before acceptance and deduplication after durable confirmation; it does not promise
universal exactly-once delivery. The regression suite explicitly exercises this ambiguity.

Command updates preserve the original policy: the mutation and offset commit before a reply is sent.
An interrupted command may lose its reply but will not replay its mutation. Callback acknowledgements
have the same limitation at a process kill; retries of the same update are not performed after its offset
has committed.

The instance lock is a separate SQLite exclusive transaction. The operating system releases it on a
kill; a second process cannot take the same data directory concurrently. SIGINT and SIGTERM abort RPC,
polling and retry waits. No child workers or external queue service are used.

403 pauses only the affected chat. Other chats continue. A new message or `my_chat_member` re-addition
resumes pending deliveries. Migration merges subscriptions and delivery records into the destination,
invalidates old button capabilities, and retries there. Confirmed destination records win collisions.

## Privacy and retention

`/export` has the required `chat_id`, `watches`, `whales`, `minimums`, `tracks` and `muted` keys. It also
includes `paused`, `callbacks`, `rates` and `deliveries` so that no hidden per-chat state is excluded.
Watches contain their starting block and discovered token addresses. Deliveries contain transaction
hashes, receipt indexes or track stages, creation chain time, pending generated alert text, and confirmed
message IDs. Incoming message bodies and Telegram identity names are never saved.

Confirmed ledger records expire after seven chain days; pending records are not discarded on a timer.
Confirmed text is removed as soon as its message ID is saved. Expired metadata is removed. Rate records
are cleaned using subsequent message dates. Pasted-input capabilities are limited to the latest 20
buttons per chat; Remove capabilities are removed with their subscription.

`/forget` removes the chat object, including pending alerts and all capabilities, and clears the public
metadata cache. It commits deletion before replying. Other chats remain. The shared update offset,
command menu, schema version, chain cursor and instance lock remain because they belong to the bot,
not the deleted chat. The JSON store keeps no application backup or data journal. Filesystem snapshots,
operator backups and already delivered Telegram messages are outside local deletion; those copies need
their own retention policy.

## Tests and operating limits

Run, sequentially:

```sh
node .launchpad/checks/round-1/run.mjs
node .launchpad/checks/round-2/run.mjs
node --test --test-concurrency=1 test/*.test.mjs
```

The first two suites exercise the CLI against loopback services. Additional tests cover metadata
failures, malformed ByteArrays, exact numeric boundaries, overlapping and failed pages, receipts without
indexes, sender-sensitive fees, restarts, blocking, migration collisions, callback authorization,
complete deletion, large exports, retention and acknowledgement loss.

The atomic JSON store is intended for a single modest bot deployment. A very large set of busy chats
increases snapshot costs and pending storage during long Telegram outages. Run one process per token
and data directory; keep durable local storage, monitor disk capacity, and back it up while stopped.
Reorganizations, RPC failover and alert corrections remain future work. No live-chain transaction is
required by these deterministic tests.
