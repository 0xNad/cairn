// Real bot handlers + fake Telegram transport + local Starknet fork only.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeTelegram } from "../.launchpad/checks/round-2/fake-telegram.mjs";
import { serve } from "../src/bot.mjs";
import { loadConfig } from "../src/config.mjs";
import { Vault } from "./vault.mjs";
const rpc = "http://127.0.0.1:8501",
  token = "123456:" + "a".repeat(35),
  uid = 919,
  dir = mkdtempSync(join(tmpdir(), "cairn-bot-smoke-"));
const tg = await fakeTelegram({
  token,
  me: {
    id: 99,
    is_bot: true,
    first_name: "Cairn",
    username: "cairn_smoke_bot",
  },
  t0: Math.floor(Date.now() / 1000),
}).listen();
const user = tg.user(uid, "Test"),
  chat = tg.dm(user);
const env = {
  TELEGRAM_BOT_TOKEN: token,
  TELEGRAM_API_ROOT: tg.url,
  STARKNET_RPC_URL: rpc,
  CAIRN_DATA: dir,
  CAIRN_CUSTODY: "1",
  CAIRN_TRADING_URL: "https://cairn-trading.vercel.app",
  CAIRN_RPC_RPS: "100",
};
const tick = () =>
  serve(loadConfig(["tick"], env), new AbortController().signal);
const proof = {
  transport: "fake Telegram; actual bot handlers and local fork",
  publicChainWrites: 0,
  stages: [],
};
let current = null,
  view = null;
async function message(text) {
  tg.say(chat, user, text);
  await tick();
  current = tg.to(uid).at(-1);
  view = current.params;
  proof.stages.push({
    step: text.startsWith("0x") ? "public destination" : text,
    text: current.text,
  });
}
async function press(label) {
  const keyboard = view.reply_markup?.inline_keyboard ?? [];
  const chosen = keyboard.flat().find((b) => b.text === label);
  if (!chosen?.callback_data)
    throw Error("Button missing: " + label + " in " + JSON.stringify(keyboard));
  tg.push({
    callback_query: {
      id: "q" + Date.now(),
      from: user,
      data: chosen.callback_data,
      message: { message_id: current.message_id, chat },
    },
  });
  await tick();
  const edit = tg.callsOf("editMessageText").at(-1);
  if (edit?.params.message_id === current.message_id) {
    view = edit.params;
    proof.stages.push({ step: label, text: view.text });
  } else throw Error("No edit for " + label);
}
try {
  await message("/start");
  await press("+ Create wallet");
  await press("Create my wallet");
  const vault = new Vault(join(dir, "custody")),
    w = vault.wallet(uid);
  vault.close();
  if (!w) throw Error("Wallet creation failed");
  proof.walletCreated = true;
  for (const unit of ["FRI", "WEI"]) {
    const r = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "devnet_mint",
        params: {
          address: w.address,
          amount: JSON.rawJSON(
            unit === "FRI" ? "1000000000000000000000" : "10000000000000000000",
          ),
          unit,
        },
      }),
    });
    if ((await r.json()).error) throw Error("Mint failed");
  }
  await press("↻ Refresh");
  await press("Activate wallet");
  await press("Activate wallet");
  await message("/start");
  await press("⇄ Buy / Sell");
  await press("ETH");
  await press("STRK");
  await message("0.001");
  await press("Confirm trade");
  await message("/start");
  await press("◷ Activity");
  const checker = view.reply_markup.inline_keyboard
    .flat()
    .find((b) => b.text.startsWith("Check swap"));
  if (checker) await press(checker.text);
  const v = new Vault(join(dir, "custody"));
  const trades = v.history(uid);
  proof.transactions = trades;
  proof.swapConfirmed = trades.some(
    (i) => i.kind === "swap" && i.state === "confirmed",
  );
  v.close();
  proof.fiveCommands =
    tg.callsOf("setMyCommands").at(-1).params.commands.length === 5;
  proof.telegramViolations = tg.violations;
  proof.resultMessages = tg
    .to(uid)
    .filter((m) => m.text.includes("swap confirmed")).length;
  if (
    !proof.swapConfirmed ||
    !proof.fiveCommands ||
    proof.telegramViolations.length
  )
    throw Error("Acceptance failed");
} catch (e) {
  proof.error = String(e.message).slice(-1800);
  process.exitCode = 1;
} finally {
  await tg.close();
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(
    process.env.CAIRN_BOT_SMOKE_PROOF ?? "/tmp/cairn-bot-smoke.json",
    JSON.stringify(proof, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      wallet: proof.walletCreated,
      swap: proof.swapConfirmed,
      commands: proof.fiveCommands,
      violations: proof.telegramViolations,
      error: proof.error,
    }),
  );
}
