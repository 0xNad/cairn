// Wallet subscriptions and commands; scanner and durable delivery share one stored state.
import { normalize, unsigned, u256, SELECTORS } from "./felt.mjs";
import { amount, escapeHtml as esc, short, messages } from "./format.mjs";
import { answer, parseCommand } from "./commands.mjs";
import { CairnError, RpcError } from "./errors.mjs";

export const EXTRA_COMMANDS = [
  "watch",
  "unwatch",
  "list",
  "whale",
  "unwhale",
  "min",
  "mute",
  "unmute",
  "track",
  "export",
  "forget",
];
import {
  SYMBOL,
  DECIMALS,
  CACHE_SECONDS,
  same,
  decodeSymbol,
  units,
} from "./alert-values.mjs";
const packet = (text, markup) => ({
  lines: Array.isArray(text) ? text : [esc(text)],
  markup,
});
const fresh = () => ({
  watches: [],
  whales: [],
  minimums: [],
  tracks: [],
  muted: [],
  paused: false,
  seen: {},
});
import { scanRange } from "./alert-scanner.mjs";
export class RoundTwo {
  constructor(context, store, tg) {
    Object.assign(this, context, { store, tg });
    this.state = store.state.round2 ??= {
      cursor: null,
      chats: {},
      tokens: {},
      ledger: {},
      buttons: {},
      rates: {},
      next: 0,
    };
  }
  save() {
    this.store.save();
  }
  chat(id) {
    return (this.state.chats[id] ??= fresh());
  }
  link(kind, id) {
    return `<a href="${esc(this.clean(`${this.config.explorer}/${kind}/${id}`))}">${short(id)}</a>`;
  }
  button(chat, verb, value, label) {
    const existing = Object.entries(this.state.buttons).find(
      ([, b]) => b.chat === chat && b.verb === verb && b.value === value,
    );
    const id = existing?.[0] ?? String(++this.state.next);
    this.state.buttons[id] = { chat, verb, value };
    return { text: label, callback_data: `${verb}:${id}` };
  }
  async admin(message) {
    if (message.chat.type === "private") return true;
    if (message.sender_chat?.id === message.chat.id) return true;
    if (!Number.isSafeInteger(message.from?.id)) return false;
    const member = await this.tg.call("getChatMember", {
      chat_id: message.chat.id,
      user_id: message.from.id,
    });
    return ["creator", "administrator"].includes(member?.status);
  }
  limited(message) {
    const user = message.sender_chat?.id ?? message.from?.id ?? 0,
      now = message.date;
    if (!Number.isSafeInteger(now))
      return packet("Message has no valid timestamp.");
    for (const [key, r] of Object.entries(this.state.rates)) {
      r.dates = r.dates.filter((t) => now - t < 60);
      if (!r.dates.length && (!r.notified || now - (r.notice_at ?? 0) >= 60))
        delete this.state.rates[key];
    }
    const key = `${message.chat.id}:${user}`,
      r = (this.state.rates[key] ??= { dates: [], notified: false });
    const records = Object.entries(this.state.rates)
      .filter(([k]) => k.endsWith(`:${user}`))
      .map(([, r]) => r);
    if (records.reduce((n, r) => n + r.dates.length, 0) < 10) {
      for (const r of records) r.notified = false;
      r.dates.push(now);
      return null;
    }
    if (records.some((r) => r.notified)) return packet([]);
    r.notified = true;
    r.notice_at = now;
    return packet("Slow down: at most 10 commands in 60 seconds.");
  }
  async token(value, head) {
    const known = this.config.tokens.find(
      (t) =>
        t.symbol.toLowerCase() === value.toLowerCase() ||
        (/^0x/i.test(value) && same(t.address, value)),
    );
    if (known) return { ...known, verified: true };
    const address = normalize(value),
      cached = this.state.tokens[address];
    if (
      cached &&
      head.timestamp >= cached.at &&
      head.timestamp - cached.at < CACHE_SECONDS
    ) {
      if (!cached.coin) throw new Error("Contract is not an ERC-20 token.");
      return cached;
    }
    try {
      const call = (entry_point_selector) =>
        this.rpc.call("starknet_call", {
          request: {
            contract_address: address,
            entry_point_selector,
            calldata: [],
          },
          block_id: { block_number: head.block_number },
        });
      const ds = await call(DECIMALS);
      if (!Array.isArray(ds) || ds.length !== 1) throw new Error();
      const decimals = Number(unsigned(ds[0]));
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
        throw new Error();
      const symbol = this.clean(decodeSymbol(await call(SYMBOL)));
      const result = {
        address,
        decimals,
        symbol: [...symbol].slice(0, 11).join(""),
        verified: false,
        coin: true,
        at: head.timestamp,
      };
      this.state.tokens[address] = result;
      return result;
    } catch (error) {
      if (
        (error instanceof RpcError && [20, 21, 40].includes(error.code)) ||
        (!(error instanceof CairnError) && !(error instanceof RpcError))
      ) {
        this.state.tokens[address] = { coin: false, at: head.timestamp };
        throw new Error("Token metadata unavailable or invalid.");
      }
      throw error;
    }
  }
  tokenText(token) {
    return token.verified
      ? esc(token.symbol)
      : `<code>${esc(token.symbol)}</code> unverified ${this.link("contract", token.address)}`;
  }
  async handle(update, head) {
    if (update.my_chat_member) {
      const c = this.chat(update.my_chat_member.chat.id);
      c.paused = ["kicked", "left"].includes(
        update.my_chat_member.new_chat_member?.status,
      );
      return packet([]);
    }
    if (update.callback_query) {
      const q = update.callback_query,
        id = q.message?.chat?.id;
      try {
        const [, key] = String(q.data ?? "").split(":"),
          b = this.state.buttons[key];
        if (!b || b.chat !== id || !String(q.data).startsWith(`${b.verb}:`))
          return packet([]);
        const m = {
          ...q.message,
          sender_chat: undefined,
          entities: undefined,
          from: q.from,
          date: head?.timestamp ?? q.message.date,
          text: `/${b.verb} ${b.value}`,
        };
        const before = this.state.chats[id]?.watches.length;
        const result = await this.handle({ message: m }, head);
        if (
          b.verb === "unwatch" &&
          this.state.chats[id]?.watches.length < before
        )
          await this.tg.call("editMessageText", {
            chat_id: id,
            message_id: q.message.message_id,
            text: "Subscription removed.",
            parse_mode: "HTML",
          });
        return result;
      } finally {
        await this.tg.call("answerCallbackQuery", { callback_query_id: q.id });
      }
    }
    const m = update.message;
    if (!m || !Number.isSafeInteger(m.chat?.id)) return packet([]);
    if (this.state.chats[m.chat.id]) this.state.chats[m.chat.id].paused = false;
    let cmd = parseCommand(m, this.username),
      pasted = false;
    if (
      !cmd &&
      m.chat.type === "private" &&
      /^0x[0-9a-f]{1,64}$/i.test(m.text?.trim() ?? "")
    ) {
      // Both forms are felts: a known transaction is a hash, otherwise show a balance.
      const value = m.text.trim();
      let kind = "balance";
      try {
        await this.rpc.call("starknet_getTransactionStatus", {
          transaction_hash: normalize(value, "hash"),
        });
        kind = "tx";
      } catch {}
      cmd = { name: kind, argument: value };
      pasted = true;
    }
    if (!cmd) return null;
    const limit = this.limited(m);
    if (limit) return limit;
    if (
      !EXTRA_COMMANDS.includes(cmd.name) &&
      cmd.name !== "balance" &&
      !pasted
    ) {
      if (["help", "start"].includes(cmd.name))
        return packet([
          ...(await answer(cmd, { ...this, head })),
          ...EXTRA_COMMANDS.map((x) => `/${x}`),
        ]);
      return null;
    }
    try {
      if (
        EXTRA_COMMANDS.includes(cmd.name) &&
        cmd.name !== "list" &&
        !(await this.admin(m))
      )
        return packet("Only a group administrator may change these settings.");
      if (
        !head &&
        !["export", "forget", "list", "unwatch", "unwhale", "unmute"].includes(
          cmd.name,
        )
      )
        return packet("node busy — try again shortly.");
      const c = this.chat(m.chat.id),
        args = cmd.argument.split(/\s+/).filter(Boolean);
      switch (cmd.name) {
        case "watch": {
          const address = normalize(args.shift()),
            label = this.clean(args.join(" "));
          if ([...label].length > 32)
            throw new Error("Label must be at most 32 characters.");
          if (!c.watches.some((w) => w.address === address)) {
            if (c.watches.length >= this.config.maxWatches)
              throw new Error("Watch limit reached.");
            c.watches.push({ address, label, since_block: head.block_number });
          }
          return packet(
            `Watching ${address}${label ? ` (${label})` : ""} after block ${head.block_number}.`,
          );
        }
        case "unwatch": {
          if (!cmd.argument)
            throw new Error("Usage: /unwatch <address or label>");
          const value = cmd.argument;
          let address;
          try {
            address = normalize(value);
          } catch {}
          c.watches = c.watches.filter(
            (w) => w.address !== address && w.label !== value,
          );
          for (const key of Object.keys(c.seen))
            if (!c.watches.some((w) => w.address === key)) delete c.seen[key];
          return packet("Watch removed.");
        }
        case "list": {
          const keyboard = c.watches.map((w) => [
            this.button(m.chat.id, "unwatch", w.address, "Remove"),
          ]);
          return packet(
            c.watches.length
              ? c.watches
                  .map((w) => `${w.label || "Wallet"} ${w.address}`)
                  .join("\n")
              : "No watches.",
            { inline_keyboard: keyboard },
          );
        }
        case "whale":
        case "min": {
          if (args.length !== 2)
            throw new Error(`Usage: /${cmd.name} <token> <amount>`);
          const t = await this.token(args[0], head),
            value = units(args[1], t.decimals),
            list = cmd.name === "whale" ? c.whales : c.minimums;
          let item = list.find((x) => x.token === t.address);
          if (!item) {
            if (cmd.name === "whale" && list.length >= 5)
              throw new Error("Whale limit is 5.");
            item = { token: t.address, since_block: head.block_number };
            list.push(item);
          }
          item.amount = value;
          return packet(
            `${cmd.name === "whale" ? "Whale threshold" : "Minimum"} set: ${amount(BigInt(value), t.decimals, t.symbol)}.`,
          );
        }
        case "unwhale": {
          if (args.length !== 1) throw new Error("Usage: /unwhale <token>");
          const address =
            this.config.tokens.find(
              (t) => t.symbol.toLowerCase() === args[0].toLowerCase(),
            )?.address ?? normalize(args[0]);
          const t = { address };
          c.whales = c.whales.filter((w) => w.token !== t.address);
          return packet("Whale threshold removed.");
        }
        case "mute":
        case "unmute": {
          if (args.length !== 1)
            throw new Error(`Usage: /${cmd.name} <token address>`);
          const address = normalize(args[0]);
          c.muted = c.muted.filter((a) => a !== address);
          if (cmd.name === "mute") c.muted.push(address);
          return packet(
            cmd.name === "mute" ? "Token muted." : "Token unmuted.",
          );
        }
        case "track": {
          if (args.length !== 1) throw new Error("Usage: /track <hash>");
          const hash = normalize(args[0], "hash");
          if (!c.tracks.some((t) => t.hash === hash)) {
            if (c.tracks.length >= 10) throw new Error("Track limit is 10.");
            c.tracks.push({
              hash,
              since: head.timestamp,
              since_block: head.block_number,
              stages: [],
            });
          }
          return packet(`Tracking ${hash}.`);
        }
        case "export": {
          const data = {
            chat_id: m.chat.id,
            watches: c.watches,
            whales: c.whales.map((w) => ({
              ...w,
              symbol:
                this.config.tokens.find((t) => t.address === w.token)?.symbol ??
                this.state.tokens[w.token]?.symbol ??
                "",
              min: w.amount,
            })),
            minimums: Object.fromEntries(
              c.minimums.map((m) => [m.token, m.amount]),
            ),
            tracks: c.tracks,
            muted: c.muted,
            seen_tokens: c.seen,
            paused: c.paused,
          };
          const chunks = [];
          let text = "";
          for (const char of JSON.stringify(data)) {
            const next = esc(char);
            if (text.length + next.length > 3900) {
              chunks.push(`<pre>${text}</pre>`);
              text = "";
            }
            text += next;
          }
          if (text) chunks.push(`<pre>${text}</pre>`);
          return { lines: [], chunks };
        }
        case "forget": {
          delete this.state.chats[m.chat.id];
          for (const [k, v] of Object.entries(this.state.ledger))
            if (v.chat === m.chat.id) delete this.state.ledger[k];
          for (const [k, v] of Object.entries(this.state.buttons))
            if (v.chat === m.chat.id) delete this.state.buttons[k];
          for (const k of Object.keys(this.state.rates))
            if (k.startsWith(`${m.chat.id}:`)) delete this.state.rates[k];
          return packet("Forgot all stored data for this chat.");
        }
        case "balance": {
          const address = normalize(args[0]);
          if (args.length > 2)
            throw new Error("Usage: /balance <address> [token]");
          if (
            args.length === 1 &&
            !pasted &&
            !c.watches.some((w) => w.address === address)
          )
            return null;
          const tokens = args[1]
            ? [await this.token(args[1], head)]
            : [
                ...this.config.tokens.map((t) => ({ ...t, verified: true })),
                ...(await Promise.all(
                  (c.seen[address] ?? [])
                    .filter(
                      (t) => !this.config.tokens.some((k) => k.address === t),
                    )
                    .map((t) => this.token(t, head)),
                )),
              ];
          const lines = [
            `Balances · ${esc(this.config.chain)} · block ${head.block_number}`,
            this.link("contract", address),
          ];
          for (const t of tokens) {
            try {
              const params = {
                block_id: { block_number: head.block_number },
                request: {
                  contract_address: t.address,
                  entry_point_selector: SELECTORS.balance_of,
                  calldata: [address],
                },
              };
              let result;
              try {
                result = await this.rpc.call("starknet_call", params);
              } catch (e) {
                if (!(e instanceof RpcError && e.code === 21)) throw e;
                params.request.entry_point_selector = SELECTORS.balanceOf;
                result = await this.rpc.call("starknet_call", params);
              }
              const value = u256(result);
              if (value || args[1] || t.verified)
                lines.push(
                  `${esc(amount(value, t.decimals, ""))} ${this.tokenText(t)}`,
                );
            } catch {
              lines.push(`${esc(t.symbol)}: token lookup failed.`);
            }
          }
          return packet(
            lines,
            pasted
              ? {
                  inline_keyboard: [
                    [this.button(m.chat.id, "watch", address, "Watch")],
                  ],
                }
              : undefined,
          );
        }
        case "tx":
          return packet(await answer(cmd, { ...this, head }), {
            inline_keyboard: [
              [
                this.button(
                  m.chat.id,
                  "track",
                  normalize(cmd.argument, "hash"),
                  "Track",
                ),
              ],
            ],
          });
      }
    } catch (error) {
      return packet(this.clean(error.message || "Invalid command; use /help."));
    }
  }
  pending(chat, key, lines, indices = []) {
    const id = `${chat}:${key}`;
    if (this.state.ledger[id]) return;
    this.state.ledger[id] = {
      chat,
      key,
      indices,
      lines,
      sent: false,
      created_at: this.chainTime ?? 0,
    };
  }
  async scan(head) {
    if (!head) return;
    this.chainTime = head.timestamp;
    for (const [id, item] of Object.entries(this.state.ledger))
      if (
        item.sent &&
        head.timestamp - (item.created_at ?? head.timestamp) >= CACHE_SECONDS
      )
        delete this.state.ledger[id];
    for (const [id, t] of Object.entries(this.state.tokens))
      if (head.timestamp - t.at >= CACHE_SECONDS) delete this.state.tokens[id];
    if (this.state.cursor === null) {
      this.state.cursor = head.block_number;
      this.save();
    }
    await scanRange(this, head);
    await this.tracks(head);
    this.save();
  }
  async tracks(head) {
    for (const [id, c] of Object.entries(this.state.chats)) {
      for (const track of [...c.tracks]) {
        let status, receipt;
        try {
          status = await this.rpc.call("starknet_getTransactionStatus", {
            transaction_hash: track.hash,
          });
          receipt = await this.rpc.call("starknet_getTransactionReceipt", {
            transaction_hash: track.hash,
          });
        } catch (error) {
          if (
            error instanceof RpcError &&
            error.code === 29 &&
            head.timestamp - track.since >= 600
          ) {
            this.pending(Number(id), `track:${track.hash}:expired`, [
              `Transaction ${this.link("tx", track.hash)} not found after 600 seconds.`,
            ]);
            c.tracks = c.tracks.filter((t) => t !== track);
          }
          continue;
        }
        let stages = [];
        if (
          (receipt.execution_status ?? status.execution_status) === "REVERTED"
        )
          stages = ["reverted"];
        else if (status.finality_status === "ACCEPTED_ON_L1")
          stages = ["l2", "l1"];
        else if (status.finality_status === "ACCEPTED_ON_L2") stages = ["l2"];
        for (const stage of stages) {
          if (track.stages.includes(stage)) continue;
          this.pending(Number(id), `track:${track.hash}:${stage}`, [
            `Transaction ${this.link("tx", track.hash)} · ${stage === "l1" ? "L1 accepted" : stage === "l2" ? "L2 accepted" : "reverted"} · ${esc(receipt.execution_status ?? "SUCCEEDED")}`,
            `Fee ${esc(amount(unsigned(receipt.actual_fee?.amount ?? "0x0"), 18, "STRK"))}${stage === "reverted" ? ` · ${esc(this.clean(receipt.revert_reason ?? ""))}` : ""}`,
          ]);
          track.stages.push(stage);
        }
        if (stages.includes("l1") || stages.includes("reverted"))
          c.tracks = c.tracks.filter((t) => t !== track);
      }
    }
  }
  migrate(oldId, newId) {
    const source = this.state.chats[oldId] ?? fresh(),
      target = this.state.chats[newId] ?? fresh();
    const merge = (a, b, key) => [
      ...new Map([...a, ...b].map((x) => [x[key], x])).values(),
    ];
    this.state.chats[newId] = {
      ...target,
      ...source,
      watches: merge(target.watches, source.watches, "address"),
      whales: merge(target.whales, source.whales, "token"),
      minimums: merge(target.minimums, source.minimums, "token"),
      tracks: merge(target.tracks, source.tracks, "hash"),
      muted: [...new Set([...target.muted, ...source.muted])],
      seen: { ...target.seen, ...source.seen },
    };
    delete this.state.chats[oldId];
    for (const [id, item] of Object.entries(this.state.ledger))
      if (item.chat === oldId) {
        const key = `${newId}:${item.key}`,
          existing = this.state.ledger[key];
        item.chat = newId;
        this.state.ledger[key] = existing?.sent ? existing : item;
        delete this.state.ledger[id];
      }
    for (const v of Object.values(this.state.buttons))
      if (v.chat === oldId) v.chat = newId;
    for (const [key, r] of Object.entries(this.state.rates))
      if (key.startsWith(`${oldId}:`)) {
        const newKey = `${newId}:${key.slice(String(oldId).length + 1)}`;
        this.state.rates[newKey] = {
          dates: [...(this.state.rates[newKey]?.dates ?? []), ...r.dates].sort(
            (a, b) => a - b,
          ),
          notified: r.notified || this.state.rates[newKey]?.notified,
        };
        delete this.state.rates[key];
      }
    this.save();
  }
  async send(chat, lines, markup, chunks) {
    let accepted = 0;
    for (const text of chunks ?? messages(lines)) {
      const params = {
        chat_id: chat,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        ...(markup ? { reply_markup: markup } : {}),
      };
      let result;
      try {
        result = await this.tg.call("sendMessage", params);
      } catch (error) {
        if (!error.migrate) throw error;
        this.migrate(chat, error.migrate);
        chat = error.migrate;
        result = await this.tg.call("sendMessage", {
          ...params,
          chat_id: chat,
        });
      }
      if (result === null) {
        this.chat(chat).paused = true;
        this.save();
        return { accepted, blocked: true };
      }
      accepted++;
      this.lastMessage = result?.message_id;
    }
    return { accepted, blocked: false };
  }
  async deliver() {
    let alerts = 0;
    for (const item of Object.values(this.state.ledger)) {
      if (item.sent || this.state.chats[item.chat]?.paused) continue;
      item.chunks ??= messages(item.lines);
      item.progress ??= 0;
      item.message_ids ??= [];
      this.save();
      while (item.progress < item.chunks.length) {
        const result = await this.send(item.chat, [item.chunks[item.progress]]);
        if (result.blocked) break;
        item.progress++;
        item.message_ids.push(this.lastMessage);
        alerts += result.accepted;
        this.save();
      }
      if (item.progress === item.chunks.length) {
        item.sent = true;
        item.message_id = this.lastMessage;
        this.save();
      }
    }
    return alerts;
  }
}
