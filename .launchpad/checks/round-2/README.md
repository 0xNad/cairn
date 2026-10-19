# Round 2: Wallet alerts, every token

Run from the entry root:

```sh
node .launchpad/checks/round-2/run.mjs
```

The 36 test names in `check.json` are the acceptance contract. Every scenario runs Cairn as a child process against private loopback Telegram and Starknet fixtures, using fresh state. Earlier round checks are unchanged and run separately through the cumulative gate.

Coverage includes watch and whale limits, input validation, administrator and callback authorization, message-time rate limits, pasted inputs and buttons, scan ranges and continuation pages, both ERC-20 layouts, exact u256 amounts, unknown-token metadata and its chain-time cache, noise suppression, floors and mutes, approval boundaries, token balances, transaction tracking, export/forget, migration, blocked chats, kills, and failed pagination. Every successful scenario also checks outbound destinations, read-only RPC, secret redaction and user-name privacy.

The two fakes are copied from Round 1. The Telegram copy adds arbitrary update injection and a hold before send acceptance. The Starknet copy adds JSON-RPC error injection and updates transaction status without duplicating the transaction in its block. The entry runner and reporting kit are vendored unchanged.

## Delivery evidence

The crash scenarios exercise a pending send killed **before** Telegram accepts it and a restart **after** a confirmed delivery has been durably recorded. They require recovery of the pending alert and no replay of the confirmed alert. Ordinary restarts, failed continuation pages and invalid continuation tokens must not lose or duplicate events.

These are bounded failure scenarios. Telegram `sendMessage` has no idempotency key, so no offline test suite can prove the brief's universal exactly-once claim across a crash after remote acceptance but before local confirmation. These checks do not claim to prove that ambiguous interval. The brief itself is unchanged.

## Creator validation

Use the published gate script and this round's pinned runner image, with this checks commit as `--base`. The base without Round 2 implementation must fail all 36 new checks; a private reference must pass both rounds. Validate broken copies as well, including an empty successful process, escaping removed, invalid amounts accepted, pagination skipped, admin checks removed and delivery confirmation ignored. Keep reference implementations and mutation artifacts private, outside this directory.
