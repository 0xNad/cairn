import {
  TOKENS,
  token,
  units,
  format,
  address,
  validateBundle,
} from "../trading/lib/core.mjs";
import { escapeHtml as html, short } from "./format.mjs";
const now = () => Math.floor(Date.now() / 1000),
  TTL = 900;
const button = (text, data) => ({ text, callback_data: data });
const cancel = () => [button("Cancel", "bt:cancel")];
const say =
  (text, keyboard = []) =>
  () => ({ lines: text.split("\n"), keyboard });
function screen(d, id) {
  const cb = (text, action) => button(text, `bt:${id}:${action}`);
  const labels = (t) =>
    t.symbol === "USDC"
      ? "USDC · native"
      : t.symbol === "USDC.e"
        ? "USDC.e · bridged"
        : t.symbol;
  const choices = TOKENS.filter(
    (t) => d.stage !== "buy" || t.symbol !== d.sell,
  ).map((t) => cb(labels(t), t.symbol));
  const grid = [];
  for (let i = 0; i < choices.length; i += 2)
    grid.push(choices.slice(i, i + 2));
  if (d.stage === "sell")
    return {
      lines: [
        "<b>New trade</b> · 1 of 4",
        "",
        "Which token are you paying with?",
      ],
      keyboard: [...grid, cancel()],
    };
  if (d.stage === "buy")
    return {
      lines: [
        "<b>New trade</b> · 2 of 4",
        "",
        `Paying with <b>${html(d.sell)}</b>. Which token do you want?`,
      ],
      keyboard: [...grid, cancel()],
    };
  if (d.stage === "amount")
    return {
      lines: [
        "<b>New trade</b> · 3 of 4",
        "",
        `${html(d.sell)} → ${html(d.buy)}`,
        `Send the amount of <b>${html(d.sell)}</b> to spend, or choose below.`,
      ],
      keyboard: [[cb("10", "10"), cb("50", "50"), cb("100", "100")], cancel()],
    };
  return {
    lines: [
      "<b>New trade</b> · 4 of 4",
      "",
      `Pay <b>${html(d.amount)} ${html(d.sell)}</b> → ${html(d.buy)}`,
      "Send the public Starknet wallet address you will sign with.",
      "Never send a recovery phrase or private key.",
    ],
    keyboard: [cancel()],
  };
}
function save(d, ctx) {
  return () => {
    const id = ctx.subs.saveTrade(ctx.chat, d, now());
    return screen(d, id);
  };
}
export function startTrade(ctx) {
  if (ctx.chat?.type !== "private" || !Number.isSafeInteger(ctx.userId))
    return say("Open Cairn privately to set up your trade.", [
      [
        {
          text: "Open Cairn ↗",
          url: `https://t.me/${encodeURIComponent(ctx.username)}?start=trade`,
        },
      ],
    ]);
  return save({ userId: ctx.userId, stage: "sell", expires: now() + TTL }, ctx);
}
function current(ctx, userId) {
  const row = ctx.subs.tradeOf(ctx.chat.id);
  if (!row) return null;
  try {
    const d = JSON.parse(row.value);
    return d.userId === userId && d.expires > now()
      ? { ...d, id: row.id }
      : null;
  } catch {
    return null;
  }
}
export function parseTradeReply(message, ctx) {
  if (
    !ctx.config.tradingUrl ||
    ctx.chat?.type !== "private" ||
    typeof message.text !== "string" ||
    message.text.startsWith("/")
  )
    return null;
  const d = current(ctx, message.from?.id);
  if (!d || !["amount", "wallet"].includes(d.stage)) return null;
  return { name: "trade-reply", argument: message.text.trim() };
}
async function quote(d, ctx) {
  const request = {
    sell: d.sell,
    buy: d.buy,
    amount: d.amount,
    owner: d.owner,
    slippageBps: 50,
  };
  try {
    const url = new URL(ctx.config.tradingUrl);
    url.pathname = url.pathname.replace(/\/$/, "") + "/api/quote";
    const r = await (ctx.tradeFetch ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
      redirect: "error",
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) throw Error("unavailable");
    const raw = await r.text();
    if (raw.length > 512000) throw Error("oversized");
    const b = JSON.parse(raw);
    validateBundle(b, request);
    const link = new URL(ctx.config.tradingUrl);
    for (const [k, v] of Object.entries(request))
      link.searchParams.set(k, String(v));
    const feeToken = TOKENS.find((t) => t.address === b.fee?.token);
    const lines = [
      "<b>Your trade</b> · Quote preview",
      "",
      `Pay <b>${html(d.amount)} ${html(d.sell)}</b>`,
      `Receive ≈ <b>${format(b.buyAmount, b.buy.decimals, 8)} ${html(d.buy)}</b>`,
      `Minimum: ${format(b.minimumReceived, b.buy.decimals)} ${html(d.buy)}`,
      "Slippage: 0.5% · Cairn fee: 0",
      `AVNU fee: ${feeToken ? format(b.fee.avnuAmount, feeToken.decimals, 8) + " " + feeToken.symbol : "included in quote"}`,
      `Network fee: ${b.gasEstimate ? format(b.gasEstimate, 18, 8) + " STRK estimate" : "shown by wallet"}`,
      `Wallet: <code>${html(short(d.owner))}</code>`,
    ];
    if (Math.abs(b.priceImpactBps ?? 0) > 100)
      lines.push(
        `⚠ Price impact: ${(Math.abs(b.priceImpactBps) / 100).toFixed(2)}%`,
      );
    lines.push(
      "",
      "Final quote refreshes on the approval screen. Nothing has been sent.",
    );
    return () => {
      ctx.subs.clearTrade(ctx.chat.id);
      return {
        lines,
        keyboard: [
          [{ text: "Open wallet approval ↗", url: link.href }],
          [
            button("Start another trade", "bt:new"),
            button("‹ Home", "ui:home"),
          ],
        ],
      };
    };
  } catch {
    return () => {
      const id = ctx.subs.saveTrade(ctx.chat, d, now());
      return {
        lines: [
          "Quote unavailable. Nothing was submitted. Try again or cancel.",
        ],
        keyboard: [[button("Try quote again", `bt:${id}:retry`)], cancel()],
      };
    };
  }
}
export async function tradeReply(value, ctx) {
  const d = current(ctx, ctx.userId);
  if (!d)
    return say("This trade expired. Start a fresh one.", [
      [button("New trade", "bt:new")],
    ]);
  try {
    if (d.stage === "amount") {
      units(value, token(d.sell).decimals);
      return save({ ...d, amount: value, stage: "wallet" }, ctx);
    }
    if (d.stage === "wallet") {
      if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw Error("address");
      d.owner = address(value);
      return quote(d, ctx);
    }
  } catch {
    return say(
      d.stage === "amount"
        ? "Send a positive decimal amount, such as 25 or 0.1."
        : "Send a public 0x wallet address, not keys or a recovery phrase.",
      [cancel()],
    );
  }
  return say("Use the latest trade buttons.");
}
export async function tradeCallback(query, ctx) {
  const chat = query.message?.chat,
    id = query.message?.message_id;
  const asCallback = (commit) => () => {
    const v = commit();
    return { edit: { chat_id: chat.id, message_id: id, ...v } };
  };
  if (!Number.isSafeInteger(chat?.id) || !Number.isSafeInteger(id))
    return () => ({ answer: "Open /trade for a fresh trade." });
  if (query.data === "bt:new")
    return asCallback(startTrade({ ...ctx, userId: query.from?.id }));
  if (chat.type !== "private")
    return () => ({
      answer: "Trading setup is available in your private Cairn chat.",
    });
  if (query.data === "bt:cancel")
    return () => {
      ctx.subs.clearTrade(chat.id);
      return {
        edit: {
          chat_id: chat.id,
          message_id: id,
          lines: ["Trade cancelled. Nothing was submitted."],
          keyboard: [[button("‹ Home", "ui:home")]],
        },
      };
    };
  const m = /^bt:(\d{1,15}):([A-Za-z0-9.]+)$/.exec(String(query.data));
  const d = current(ctx, query.from?.id);
  if (!d || !m || d.id !== Number(m[1]))
    return () => ({
      answer: "That step expired. Use the latest trade message or /trade.",
    });
  try {
    if (d.stage === "sell") {
      d.sell = token(m[2]).symbol;
      d.stage = "buy";
      return asCallback(save(d, ctx));
    }
    if (d.stage === "buy") {
      d.buy = token(m[2]).symbol;
      if (d.buy === d.sell) throw Error();
      d.stage = "amount";
      return asCallback(save(d, ctx));
    }
    if (d.stage === "amount") {
      units(m[2], token(d.sell).decimals);
      d.amount = m[2];
      d.stage = "wallet";
      return asCallback(save(d, ctx));
    }
    if (d.stage === "wallet" && d.owner && m[2] === "retry")
      return asCallback(await quote(d, ctx));
  } catch {
    return () => ({ answer: "Choose a supported token or positive amount." });
  }
  return () => ({ answer: "Send the requested value in this private chat." });
}
