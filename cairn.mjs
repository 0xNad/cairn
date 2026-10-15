#!/usr/bin/env node
// Cairn: a read-only Telegram bot for Starknet. `node cairn.mjs run|tick|doctor`; everything else comes
// from the environment (see README.md and ARCHITECTURE.md).
import { main } from "./src/main.mjs";

const code = await main(process.argv.slice(2), process.env);
// Exit now: idle keep-alive connections must not hold the process open once the work is done.
process.stdout.write("", () => process.exit(code));
