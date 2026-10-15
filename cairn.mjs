#!/usr/bin/env node
// Cairn: a read-only Telegram bot for Starknet. `node cairn.mjs run | tick | doctor`, configured by the
// environment only. See README.md for setup and ARCHITECTURE.md for the specification.
import { main } from "./src/cli/main.mjs";

const code = await main(process.argv.slice(2), process.env);
process.exit(code);
