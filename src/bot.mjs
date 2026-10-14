// The bot: `tick` (one pass over the pending updates), `run` (long polling until SIGTERM or SIGINT) and
// `doctor` (a one-line health check). A pass reads the head, then answers each update in order: the reply is
// computed, the update is recorded as handled, and only then is the reply sent.
import { COMMANDS, botCommands, lookup, nodeBusy, notACommand, parseCommand, unknownCommand } from "./commands/index.mjs";
import { split } from "./format.mjs";
import { NodeUnavailable, RpcError, rpcClient, sleep } from "./rpc.mjs";
import { starknet } from "./starknet.mjs";
import { openStore } from "./store.mjs";
import { TelegramError, telegram } from "./telegram.mjs";

/** Tries per message when Telegram answers 429, 5xx or cannot be reached. */
const SEND_TRIES = 4;

const clients = (cfg, log) => ({
  tg: telegram(cfg),
  sn: starknet(rpcClient({ url: cfg.rpcUrl, rps: cfg.rps, timeoutMs: cfg.rpcTimeoutMs, log })),
});

/** Connects to Telegram (getMe), registers the commands if they changed, and returns the bot. */
async function createBot(cfg, log, store) {
  const { tg, sn } = clients(cfg, log);
  const me = await tg.getMe();
  let chain = null, head = null;

  const list = botCommands();
  if (store.get("commands") !== JSON.stringify(list)) {
    try {
      await tg.setMyCommands(list);
      store.set("commands", JSON.stringify(list));
      log.info("commands_registered", { count: list.length });
    } catch (e) {
      if (e instanceof TelegramError && e.code === 401) throw e;
      log.warn("commands_not_registered", { reason: e.message });
    }
  }

  /** Checks the node's chain and spec once per process. Null while the node cannot be reached; throws WrongNode. */
  async function ensureChain() {
    if (chain) return chain;
    try {
      chain = await sn.checkChain(cfg.chain);
      log.info("node", { rpc: cfg.rpcOrigin, chain: chain.name, spec: chain.spec });
    } catch (e) {
      if (!(e instanceof NodeUnavailable)) throw e;
      log.warn("node_unreachable", { rpc: cfg.rpcOrigin, reason: e.message });
    }
    return chain;
  }

  /** Reads the latest block; null when the node cannot answer (commands then reply "node busy"). */
  async function readHead() {
    head = null;
    if (!(await ensureChain())) return null;
    try {
      head = await sn.head();
      log.debug("head", { block: head.number });
    } catch (e) {
      log.warn("head_unavailable", { rpc: cfg.rpcOrigin, reason: e.message });
    }
    return head;
  }

  /** The reply to a message, as lines, or null when Cairn stays silent. */
  async function reply(msg) {
    if (!msg || typeof msg.text !== "string" || msg.from?.is_bot) return null;
    const command = parseCommand(msg.text, me.username);
    if (!command) return msg.chat?.type === "private" ? notACommand() : null;
    const cmd = lookup(command.name);
    if (!cmd) return unknownCommand(command.name);
    let input = command.args;
    if (cmd.parse) {
      const parsed = cmd.parse(command.args);
      if (parsed.refusal) return parsed.refusal;
      input = parsed.value;
    }
    if (cmd.needsChain && !head) return nodeBusy();
    try {
      return await cmd.run({ cfg, log, sn, me, head, chain }, input, { commands: COMMANDS });
    } catch (e) {
      if (e instanceof NodeUnavailable) return nodeBusy();
      log.error("command_failed", { command: cmd.command, reason: e instanceof RpcError ? `RPC error ${e.code}: ${e.message}` : String(e?.stack ?? e) });
      return [`Something went wrong while answering /${cmd.command}: the operator can find the reason in the logs.`];
    }
  }

  /** Sends one message; "accepted", "blocked" (403: skip the chat) or "failed". */
  async function sendOne(chatId, html, extra) {
    for (let i = 1; ; i++) {
      try {
        await tg.sendMessage(chatId, html, extra);
        return "accepted";
      } catch (e) {
        if (!(e instanceof TelegramError) || e.code === 401) throw e;
        if (e.code === 403) {
          log.info("chat_skipped", { chat: chatId, reason: e.message });
          return "blocked";
        }
        if (!(e.code === 429 || e.code === 0 || e.code >= 500) || i >= SEND_TRIES) {
          log.warn("send_failed", { chat: chatId, code: e.code, reason: e.message });
          return "failed";
        }
        // A 429 waits exactly retry_after, then sends once more: Cairn does not throttle in advance.
        const waitMs = e.code === 429 ? Number(e.parameters?.retry_after ?? 1) * 1000 : 500 * 2 ** (i - 1);
        log.warn("send_retry", { chat: chatId, code: e.code, waitMs });
        await sleep(waitMs);
      }
    }
  }

  /** Sends a reply, split at line breaks; in a group, the first message replies to the command. */
  async function send(msg, lines) {
    let sent = 0;
    const thread = msg.chat.type === "private" ? {} : { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } };
    for (const [i, html] of split(lines).entries()) {
      const r = await sendOne(msg.chat.id, html, i === 0 ? thread : {});
      if (r === "accepted") sent++;
      if (r === "blocked") break;
    }
    return sent;
  }

  return {
    tg, me, readHead,
    /** Handles one update; returns the number of messages Telegram accepted. */
    async handle(update) {
      const msg = update.message;
      const lines = await reply(msg);
      store.handled(update.update_id, lines ? msg.chat : null);
      return lines ? send(msg, lines) : 0;
    },
  };
}

const nextOffset = (store) => {
  const last = store.lastUpdate();
  return last === null ? undefined : last + 1;
};

/** One pass: drains the pending updates, answers them, confirms the offset. Returns tick's JSON line. */
export async function tick(cfg, log) {
  const store = openStore(cfg.dataDir);
  try {
    const bot = await createBot(cfg, log, store);
    const head = await bot.readHead();
    let offset = nextOffset(store), updates = 0, sent = 0;
    for (;;) {
      const batch = await bot.tg.getUpdates({ offset, timeout: 0 });
      if (!batch.length) break;
      for (const u of batch) {
        sent += await bot.handle(u);
        updates++;
        offset = u.update_id + 1;
      }
    }
    if (updates) await bot.tg.getUpdates({ offset, limit: 1, timeout: 0 });
    const line = { updates, sent, head: head?.number ?? null };
    log.info("tick", line);
    return line;
  } finally {
    store.close();
  }
}

/** Long-polls Telegram and answers until SIGTERM or SIGINT; reads the head every CAIRN_POLL_MS. */
export async function run(cfg, log) {
  const store = openStore(cfg.dataDir);
  const stop = new AbortController();
  const onSignal = (signal) => {
    if (stop.signal.aborted) return;
    log.info("stopping", { signal });
    stop.abort();
    // A reply in flight may still wait on the node: exit within 3 s whatever happens. The state is
    // consistent at every point, since an update is recorded before its reply is sent.
    setTimeout(() => {
      log.warn("stopped_before_reply_finished");
      process.exit(0);
    }, 2500).unref();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    const bot = await createBot(cfg, log, store);
    await bot.tg.deleteWebhook();
    log.info("started", { bot: bot.me.username, chain: cfg.chain, rpc: cfg.rpcOrigin });
    let offset = nextOffset(store), nextPass = 0, failures = 0;
    while (!stop.signal.aborted) {
      if (Date.now() >= nextPass) {
        await bot.readHead();
        nextPass = Date.now() + cfg.pollMs;
      }
      // Long-poll until the next pass is due, at most CAIRN_TG_TIMEOUT seconds (0: short polling).
      const timeout = cfg.tgTimeout && Math.min(cfg.tgTimeout, Math.max(1, Math.ceil((nextPass - Date.now()) / 1000)));
      let batch;
      try {
        batch = await bot.tg.getUpdates({ offset, timeout }, { signal: stop.signal });
        failures = 0;
      } catch (e) {
        if (stop.signal.aborted) break;
        if (!(e instanceof TelegramError) || e.code === 401 || e.code === 409) throw e;
        const waitMs = Math.min(30_000, 1000 * 2 ** failures++);
        log.warn("telegram_unreachable", { reason: e.message, retryInMs: waitMs });
        await sleep(waitMs, stop.signal);
        continue;
      }
      if (batch.length) {
        await bot.readHead(); // answers use a fresh head
        nextPass = Date.now() + cfg.pollMs;
        for (const u of batch) {
          if (stop.signal.aborted) break;
          await bot.handle(u);
          offset = u.update_id + 1;
        }
      } else if (!timeout) {
        await sleep(Math.min(cfg.pollMs, 1000), stop.signal);
      }
    }
    log.info("stopped");
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    store.close();
  }
}

/** getMe, the chain and spec check, the block number: doctor's JSON line. */
export async function doctor(cfg, log) {
  const { tg, sn } = clients(cfg, log);
  const me = await tg.getMe();
  const chain = await sn.checkChain(cfg.chain);
  const block = await sn.blockNumber();
  return { bot: me.username, chain: chain.name, block, spec: chain.spec };
}
