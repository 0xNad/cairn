import { TOKENS, token, units, format, address } from "../trading/lib/core.mjs";
import { escapeHtml as html } from "./format.mjs";
const b = (text, action) => ({ text, callback_data: "cw:" + action });
const home = () => [b("‹ Home", "home")];
const reason = (e) =>
  /^(Create a wallet first\.|Fund and activate your wallet first\.|Keep enough STRK for the trade and network fee\.|Not enough (STRK|ETH|USDC|USDC\.e|USDT|WBTC)\.|Insufficient balance after reserving the network fee\.|Wallet is already activated\.|This confirmation expired or was already used\.|Resolve the pending transaction.*|.*fee exceeds the configured ceiling\..*|Activation response unknown\..*)$/.test(
    String(e?.message),
  )
    ? html(e.message)
    : "Could not complete this step. Check your wallet and Activity before retrying.";
const say =
  (lines, keyboard = [home()]) =>
  () => ({ lines: Array.isArray(lines) ? lines : lines.split("\n"), keyboard });
const label = (t) =>
  t.symbol === "USDC"
    ? "USDC · native"
    : t.symbol === "USDC.e"
      ? "USDC.e · bridged"
      : t.symbol;
const grid = (items) => {
  const rows = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return rows;
};
function owner(ctx, uid = ctx.userId) {
  return Number.isSafeInteger(uid) &&
    uid > 0 &&
    ctx.chat?.type === "private" &&
    ctx.chat.id === uid
    ? uid
    : null;
}
function requireOwner(ctx) {
  const id = owner(ctx);
  if (!id)
    throw Error("Open Cairn in your private chat to use your trading wallet.");
  return id;
}
export function custodyHome(ctx) {
  const uid = owner(ctx);
  if (!uid)
    return say("Open your private Cairn chat to create a wallet and trade.", [
      [
        {
          text: "Open Cairn ↗",
          url: `https://t.me/${encodeURIComponent(ctx.username)}?start=trade`,
        },
      ],
    ]);
  const wallet = ctx.custody.wallet(uid);
  const lines = wallet
    ? [
        "<b>Cairn</b> · Starknet",
        "",
        `Trading wallet <code>${html(wallet.address)}</code>`,
        "Choose your next move.",
      ]
    : [
        "<b>Cairn</b> · Trade on Starknet",
        "",
        "Create a trading wallet here. Fund it, then buy and sell with buttons.",
      ];
  return () => {
    ctx.custody.cancelReviews(uid);
    ctx.subs.clearTrade(uid);
    return {
      lines,
      keyboard: wallet
        ? [
            [b("⇄ Buy / Sell", "trade"), b("◉ My wallet", "wallet")],
            [b("▥ Positions", "positions"), b("↗ Withdraw", "withdraw")],
            [
              b("◷ Activity", "history"),
              { text: "Alerts & help", callback_data: "ui:help" },
            ],
          ]
        : [
            [b("+ Create wallet", "new")],
            [
              { text: "Prices", callback_data: "ui:prices" },
              { text: "Help", callback_data: "ui:help" },
            ],
          ],
    };
  };
}
function draft(ctx) {
  const r = ctx.subs.tradeOf(ctx.chat.id);
  if (!r) return null;
  try {
    const d = JSON.parse(r.value);
    return d.userId === ctx.userId && d.expires > Date.now()
      ? { ...d, id: r.id }
      : null;
  } catch {
    return null;
  }
}
function screen(d, id) {
  const cb = (text, a) => b(text, `${id}:${a}`),
    cancel = [b("Cancel", "cancel")];
  if (d.stage === "sell" || d.stage === "buy" || d.stage === "withdraw-token") {
    const ts = TOKENS.filter((t) => d.stage !== "buy" || t.symbol !== d.sell);
    return {
      lines: [
        d.stage === "withdraw-token" ? "<b>Withdraw</b>" : "<b>New trade</b>",
        "",
        d.stage === "sell"
          ? "Pay with which token?"
          : d.stage === "buy"
            ? `Paying ${html(d.sell)}. Which token do you want?`
            : "Which token do you want to withdraw?",
      ],
      keyboard: [...grid(ts.map((t) => cb(label(t), t.symbol))), cancel],
    };
  }
  if (["amount", "withdraw-amount"].includes(d.stage))
    return {
      lines: [
        d.stage === "amount"
          ? `<b>${html(d.sell)} → ${html(d.buy)}</b>`
          : `<b>Withdraw ${html(d.symbol)}</b>`,
        "",
        `Send the amount of <b>${html(d.sell ?? d.symbol)}</b> to ${d.stage === "amount" ? "spend" : "withdraw"}.`,
      ],
      keyboard:
        d.stage === "amount"
          ? [[cb("10", "10"), cb("50", "50"), cb("100", "100")], cancel]
          : [cancel],
    };
  return {
    lines: [
      "<b>Withdrawal destination</b>",
      "",
      `Send a Starknet 0x address for <b>${html(d.amount)} ${html(d.symbol)}</b>.`,
      "Only use a Starknet address. You will review it before confirming.",
    ],
    keyboard: [cancel],
  };
}
function save(d, ctx) {
  return () => {
    const id = ctx.subs.saveTrade(ctx.chat, d, Math.floor(Date.now() / 1000));
    return screen(d, id);
  };
}
export function custodyTrade(ctx) {
  const uid = owner(ctx);
  if (!uid) return custodyHome(ctx);
  if (!ctx.custody.wallet(uid)) return custodyHome(ctx);
  return save(
    { userId: uid, stage: "sell", expires: Date.now() + 900000 },
    ctx,
  );
}
export function parseCustodyReply(message, ctx) {
  if (
    !ctx.custody ||
    !owner(ctx, message.from?.id) ||
    typeof message.text !== "string" ||
    message.text.startsWith("/")
  )
    return null;
  const d = draft({ ...ctx, userId: message.from.id });
  if (d && ["amount", "withdraw-amount", "withdraw-to"].includes(d.stage))
    return { name: "custody-reply", argument: message.text.trim() };
  if (ctx.custody.wallet(message.from.id))
    try {
      const t = token(message.text.trim());
      return { name: "custody-token", argument: t.symbol };
    } catch {}
  return null;
}
function review(i) {
  const p = i.payload;
  let lines;
  if (i.kind === "deploy")
    lines = [
      "<b>Activate trading wallet</b>",
      "",
      "Deploy the account on Starknet. This uses STRK from your trading wallet.",
    ];
  else if (i.kind === "withdraw")
    lines = [
      "<b>Review withdrawal</b>",
      "",
      `Send <b>${html(p.amount)} ${html(p.symbol)}</b>`,
      `To <code>${html(p.to)}</code>`,
    ];
  else {
    const q = p.bundle;
    lines = [
      "<b>Review trade</b>",
      "",
      `Pay <b>${format(q.amount, q.sell.decimals)} ${html(q.sell.symbol)}</b>`,
      `Receive ≈ <b>${format(q.buyAmount, q.buy.decimals, 8)} ${html(q.buy.symbol)}</b>`,
      `Minimum: ${format(q.minimumReceived, q.buy.decimals)} ${html(q.buy.symbol)}`,
      "Slippage: 0.5% · Cairn fee: 0",
    ];
    const ft = TOKENS.find((t) => t.address === q.fee?.token);
    lines.push(
      `AVNU fee: ${ft ? format(q.fee.avnuAmount, ft.decimals) + " " + ft.symbol : "included"}`,
    );
    if (Math.abs(q.priceImpactBps ?? 0) > 100)
      lines.push(
        `⚠ Price impact ${(Math.abs(q.priceImpactBps) / 100).toFixed(2)}%`,
      );
  }
  lines.push(
    `Network fee cap: <b>${format(p.maxFee, 18)} STRK</b>`,
    "",
    "Confirm within 30 seconds. Cairn will sign and submit this transaction.",
  );
  return say(lines, [
    [
      b(
        i.kind === "withdraw"
          ? "Confirm withdrawal"
          : i.kind === "deploy"
            ? "Activate wallet"
            : "Confirm trade",
        "confirm:" + i.id,
      ),
    ],
    [b("Cancel", "cancel:" + i.id)],
  ]);
}
async function getQuote(d, ctx) {
  const uid = requireOwner(ctx);
  const i = await ctx.custody.swapReview(uid, {
    sell: d.sell,
    buy: d.buy,
    amount: d.amount,
    slippageBps: 50,
  });
  return () => {
    ctx.subs.clearTrade(uid);
    return review(i)();
  };
}
export async function custodyReply(value, ctx) {
  const d = draft(ctx);
  if (!d) return say("This draft expired. Tap Buy / Sell to start again.");
  try {
    if (d.stage === "amount") {
      units(value, token(d.sell).decimals);
      return await getQuote({ ...d, amount: value }, ctx);
    }
    if (d.stage === "withdraw-amount") {
      units(value, token(d.symbol).decimals);
      return save({ ...d, amount: value, stage: "withdraw-to" }, ctx);
    }
    if (d.stage === "withdraw-to") {
      if (!/^0x[0-9a-fA-F]{1,64}$/.test(value))
        throw Error("Enter a public Starknet 0x destination.");
      const i = await ctx.custody.withdrawReview(requireOwner(ctx), {
        symbol: d.symbol,
        amount: d.amount,
        to: address(value),
      });
      return () => {
        ctx.subs.clearTrade(ctx.chat.id);
        return review(i)();
      };
    }
  } catch (e) {
    return say(reason(e) + " No transaction was submitted.", [
      [b("My wallet", "wallet")],
      [b("Cancel", "cancel")],
    ]);
  }
  return say("Use the latest buttons.");
}
async function walletView(ctx) {
  const uid = requireOwner(ctx),
    s = await ctx.custody.status(uid);
  if (!s) return custodyHome(ctx);
  const lines = [
    "<b>My trading wallet</b> · Starknet",
    "",
    `<code>${html(s.address)}</code>`,
    "",
    ...s.balances.map(
      (t) =>
        `${html(t.symbol)} · <b>${format(t.amount, token(t.symbol).decimals, 8)}</b>`,
    ),
    "",
    s.deployed ? "✓ Active" : "Fund with STRK on Starknet, then activate.",
    "Key held encrypted by Cairn. Back it up before funding.",
  ];
  if (s.inflight)
    lines.push(
      "A transaction needs checking. Open Activity before another trade.",
    );
  return say(lines, [
    [b("Back up wallet key", "backup")],
    ...(!s.deployed ? [[b("Activate wallet", "activate")]] : []),
    [b("↻ Refresh", "wallet"), b("Buy / Sell", "trade")],
    [b("Withdraw", "withdraw"), b("Activity", "history")],
    home(),
  ]);
}
function result(i) {
  const lines = [
    `<b>${i.kind === "swap" ? "Trade" : i.kind === "deploy" ? "Activation" : "Withdrawal"}</b> · ${html(i.state)}`,
  ];
  if (i.hash) lines.push(`<code>${html(i.hash)}</code>`);
  if (["pending", "signed", "signing", "unknown"].includes(i.state))
    lines.push("Checking the existing transaction. Do not place it again.");
  const keyboard = [[b("↻ Check result", "check:" + i.id)], home()];
  if (i.hash)
    keyboard.splice(1, 0, [
      {
        text: "View on Voyager ↗",
        url: "https://voyager.online/tx/" + i.hash,
      },
    ]);
  return say(lines, keyboard);
}
export async function custodyCallback(query, base) {
  const ctx = { ...base, userId: query.from?.id };
  const uid = owner(ctx);
  const mid = query.message?.message_id;
  const wrap = (fn) => () => ({
    edit: { chat_id: ctx.chat.id, message_id: mid, ...fn() },
  });
  if (!uid || !Number.isSafeInteger(mid))
    return () => ({
      answer: "Trading wallets are available only in your private Cairn chat.",
    });
  const action = String(query.data ?? "").slice(3);
  try {
    if (action === "hide")
      return wrap(
        say("Private key hidden. Keep your saved copy offline.", [
          [b("My wallet", "wallet")],
          home(),
        ]),
      );
    if (action === "home") return wrap(custodyHome(ctx));
    if (action === "new")
      return wrap(
        say(
          [
            "<b>Create a trading wallet</b>",
            "",
            "Cairn will generate and hold its private key, and sign only when you confirm. This is a dedicated trading wallet.",
            "Creating it is free. Funding and account activation use your STRK.",
          ],
          [[b("Create my wallet", "create")], home()],
        ),
      );
    if (action === "create") {
      await ctx.custody.create(uid);
      return wrap(await walletView(ctx));
    }
    if (action === "wallet") return wrap(await walletView(ctx));
    if (action === "positions") {
      const s = await ctx.custody.status(uid);
      if (!s) return wrap(custodyHome(ctx));
      const holdings = s.balances.filter((t) => BigInt(t.amount) > 0n);
      return wrap(
        say(
          [
            "<b>Positions</b>",
            "",
            ...(holdings.length
              ? holdings.map(
                  (t) =>
                    `${html(t.symbol)} · <b>${format(t.amount, token(t.symbol).decimals, 8)}</b>`,
                )
              : ["No funded positions yet. Deposit to your trading wallet."]),
          ],
          [
            ...holdings.map((t) => [
              b("Sell " + label(token(t.symbol)), "sell:" + t.symbol),
            ]),
            [b("Buy tokens", "trade"), b("Deposit", "wallet")],
            home(),
          ],
        ),
      );
    }
    if (/^sell:/.test(action)) {
      const sell = token(action.slice(5));
      return wrap(
        save(
          {
            userId: uid,
            stage: "buy",
            sell: sell.symbol,
            expires: Date.now() + 900000,
          },
          ctx,
        ),
      );
    }
    if (action === "trade") return wrap(custodyTrade(ctx));
    if (action === "backup") {
      if (!ctx.custody.wallet(uid)) return wrap(custodyHome(ctx));
      return wrap(() => {
        const id = ctx.subs.saveTrade(
          ctx.chat,
          { userId: uid, stage: "key-export", expires: Date.now() + 30000 },
          Math.floor(Date.now() / 1000),
        );
        return {
          lines: [
            "<b>Back up your wallet</b>",
            "",
            "Revealing the private key puts it in this Telegram chat. Anyone with the key can move all wallet funds.",
            "Save it privately, then tap Hide key. Never send it to anyone.",
          ],
          keyboard: [[b("Reveal my private key", `${id}:reveal`)], home()],
        };
      });
    }
    if (action === "activate")
      return wrap(review(await ctx.custody.deployReview(uid)));
    if (action === "withdraw") {
      if (!ctx.custody.wallet(uid)) return wrap(custodyHome(ctx));
      return wrap(
        save(
          {
            userId: uid,
            stage: "withdraw-token",
            expires: Date.now() + 900000,
          },
          ctx,
        ),
      );
    }
    if (action === "cancel" || action.startsWith("cancel:"))
      return () => {
        ctx.custody.cancelReviews(uid);
        ctx.subs.clearTrade(uid);
        return {
          edit: {
            chat_id: uid,
            message_id: mid,
            lines: ["Cancelled. No new transaction was submitted."],
            keyboard: [home()],
          },
        };
      };
    if (action === "history") {
      const items = ctx.custody.history(uid);
      return wrap(
        say(
          [
            "<b>Activity</b>",
            "",
            ...(items.length
              ? items.map((i) => `${i.kind} · ${i.state}`)
              : ["No transactions yet."]),
          ],
          [
            ...items
              .filter((i) => i.hash || ["unknown", "signing"].includes(i.state))
              .map((i) => [b(`Check ${i.kind} · ${i.state}`, "check:" + i.id)]),
            home(),
          ],
        ),
      );
    }
    const intent = /^(confirm|check):([0-9a-f]{24})$/.exec(action);
    if (intent)
      return wrap(
        result(
          intent[1] === "confirm"
            ? await ctx.custody.confirm(uid, intent[2])
            : await ctx.custody.check(uid, intent[2]),
        ),
      );
    const step = /^(\d{1,15}):([A-Za-z0-9.]+)$/.exec(action),
      d = draft(ctx);
    if (!step || !d || d.id !== Number(step[1]))
      return () => ({ answer: "That step expired. Use the latest buttons." });
    if (d.stage === "key-export" && step[2] === "reveal") {
      const key = ctx.custody.exportKey(uid);
      return wrap(() => {
        ctx.subs.clearTrade(uid);
        return {
          lines: [
            "<b>Your wallet private key</b>",
            "",
            `<code>${html(key)}</code>`,
            "",
            "Keep this offline and private. Hide this message when saved.",
          ],
          keyboard: [[b("Hide key", "hide")]],
        };
      });
    }
    if (d.stage === "sell") {
      d.sell = token(step[2]).symbol;
      d.stage = "buy";
      return wrap(save(d, ctx));
    }
    if (d.stage === "buy") {
      d.buy = token(step[2]).symbol;
      if (d.buy === d.sell) throw Error();
      d.stage = "amount";
      return wrap(save(d, ctx));
    }
    if (d.stage === "amount") {
      units(step[2], token(d.sell).decimals);
      return wrap(await getQuote({ ...d, amount: step[2] }, ctx));
    }
    if (d.stage === "withdraw-token") {
      d.symbol = token(step[2]).symbol;
      d.stage = "withdraw-amount";
      return wrap(save(d, ctx));
    }
  } catch (e) {
    return wrap(
      say(reason(e) + " No duplicate transaction will be sent.", [
        [b("My wallet", "wallet"), b("Activity", "history")],
        home(),
      ]),
    );
  }
  return () => ({ answer: "Use the latest trade buttons." });
}

export function custodyToken(symbol, ctx) {
  const uid = requireOwner(ctx),
    buy = token(symbol),
    sell = buy.symbol === "USDC" ? "ETH" : "USDC";
  return save(
    {
      userId: uid,
      stage: "amount",
      sell,
      buy: buy.symbol,
      expires: Date.now() + 900000,
    },
    ctx,
  );
}
export async function custodyQuickTrade(command, ctx) {
  if (!command.argument) return custodyTrade(ctx);
  try {
    const [asset, value, pay = "USDC", ...extra] =
      command.argument.split(/\s+/);
    if (extra.length || !value) throw Error();
    const sell = token(command.name === "buy" ? pay : asset),
      buy = token(command.name === "buy" ? asset : pay);
    if (sell === buy) throw Error();
    units(value, sell.decimals);
    return await getQuote(
      { sell: sell.symbol, buy: buy.symbol, amount: value },
      ctx,
    );
  } catch {
    return say("Use the Buy / Sell buttons to choose your tokens and amount.", [
      [b("Buy / Sell", "trade")],
      home(),
    ]);
  }
}
