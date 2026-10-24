# Round 3 acceptance checks

Run the official gate from the repository root with `--project cairn --round 3`.
The gate runs the 29 round 1 and 36 round 2 checks unchanged, followed by these
35 black-box checks. `check.json` lists every expected result; an incomplete
report fails.

The checks launch `node cairn.mjs tick` or `run` as an unprivileged child, with a
fresh data directory and local fake Telegram and Starknet endpoints. They check
observable replies, persisted behaviour across separate processes, RPC calls,
delivery acceptance and recovery. They do not import implementation modules or
require a particular database schema. No live credentials or chain writes are
used. The HTTP trap rejects unconfigured destinations.

The fixtures are synthetic examples of the event and calldata layouts frozen in
`ARCHITECTURE.md`, not recorded mainnet receipts. They cover signed Ekubo deltas,
AVNU u256 amounts and precedence, netting, transfer-derived trader identity,
historical balances, Pragma answers and Starknet ID calldata vectors. The fake
services implement the earlier rounds' protocol surface as well.

Coverage groups:

- R3-01–08: optional configuration, validation, feed persistence, administration,
  unverified tokens, exact token/USD floors and buy/sell selection.
- R3-09–22: venue layouts, multihop and round-trip netting, relevant AVNU
  precedence, relayers, net-transfer ties, excluded fee/venue addresses, legacy
  transfers and prior-block new-holder detection.
- R3-23–30: price scaling, freshness and failure isolation, wallet USD enrichment,
  forward-name vectors, invalid names and forward-verified reverse names.
- R3-31–35: shared group delivery budget, command exemption, forum topics,
  continuation pages and crash recovery without replay of accepted sends.

The preparation inventory's final regression scenario is exercised by the 65
unchanged cumulative checks, rather than a new always-passing placeholder.
The private reference and mutation variants used to prove these checks remain
outside the published branch.
