# Reproduce the user path

With Node.js 24, run from the repository root:

```sh
node scripts/proof.mjs /home/djizus/.launchpad/djAIzus/cairn-1/evidence
```

The optional destination defaults to `../evidence`. Each invocation creates a new directory and keeps it,
including on failure. The script starts local HTTP Telegram and Starknet fakes, launches the actual CLI,
sends chat commands, restarts it, kills it immediately after an accepted reply, and interrupts a long poll.
Assertions check exact amounts, parsed messages, summaries and restart behavior. Only loopback is used.

`actions.json` records user input; `telegram.json` records requests and accepted replies; `rpc.json`
records node requests; `commands.json` records CLI output and exit status; `network.jsonl` records
connections; `data/` preserves the bot's state. `result.json` records success or the actual failure.
The generated credentials belong only to the local fakes.

The complete round checks also run locally with `npm run check`. Official container verification is a
separate step on the final commit.
