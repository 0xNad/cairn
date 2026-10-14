// The bot: Telegram, the node and the store, and what `run` and `tick` share. One pass (ARCHITECTURE.md):
//   1. head     the latest block; null when the node cannot be reached (chain commands reply "node busy")
//   2. updates  getUpdates from the saved offset, each handled in order; the offset is saved before the
//               reply is sent, so an update is never answered twice, even after a SIGKILL
//   3. scan     (round 2) blocks since the cursor → pending alerts
//   4. periodic (round 4) stall and reorg checks
//   5. deliver  (round 2) pending alerts → sendMessage, marked sent once Telegram accepts them
//   6. save     (round 2) the cursor and recent block hashes
import { BUSY, COMMANDS, route } from "./commands/index.mjs";
import { Fatal } from "./errors.mjs";
import { pack } from "./format.mjs";
import { log } from "./log.mjs";
import { NodeUnavailable, RpcError, rpcClient } from "./rpc.mjs";
import { starknet } from "./starknet.mjs";
import { openStore } from "./store.mjs";
import { telegramClient } from "./telegram.mjs";

const OOPS = ["⚠️ Something went wrong on my side while answering. The operator can find the details in the logs."];

export class Bot {
  constructor(config, stop) {
    this.config = config;
    this.stop = stop;
    this.tg = telegramClient({ root: config.telegramApiRoot, token: config.token, stop });
    this.chain = starknet(rpcClient({ url: config.rpcUrl, rps: config.rpcRps, timeoutMs: config.rpcTimeoutMs, stop }));
    this.store = null;
    this.me = null;
    this.spec = null; // the node's spec version, once its chain and version are checked
    this.nodeDown = false;
    this.counts = { updates: 0, sent: 0 };
  }

  // Opens the store, then Telegram: getMe (a rejected token exits 3 before anything else happens),
  // deleteWebhook for `run`, and the command list when it changed.
  async connect({ deleteWebhook = false } = {}) {
    this.store = openStore(this.config.dataDir);
    this.me = await this.tg.call("getMe");
    if (deleteWebhook) await this.tg.call("deleteWebhook", { drop_pending_updates: false });
    const commands = COMMANDS.map(({ name, description }) => ({ command: name, description }));
    const json = JSON.stringify(commands);
    if (this.store.commands() !== json) {
      try {
        await this.tg.call("setMyCommands", { commands });
        this.store.setCommands(json);
      } catch (e) {
        if (e instanceof Fatal || this.stop.aborted) throw e;
        log.warn("commands_not_registered", { reason: e.message });
      }
    }
  }

  close() {
    this.store?.close();
  }

  // The head block, or null when the node cannot be reached. The node's chain and spec version are
  // checked first, once per process: a wrong chain or an old spec ends the process (exit 2).
  async readHead() {
    try {
      if (this.spec === null) {
        const { spec } = await this.chain.verify(this.config.chain);
        this.spec = spec;
        log.info("node", { origin: this.config.rpcOrigin, chain: this.config.chain, spec });
      }
      const head = await this.chain.head();
      if (this.nodeDown) log.info("node_back", { origin: this.config.rpcOrigin, head: head.number });
      this.nodeDown = false;
      return head;
    } catch (e) {
      if (!(e instanceof NodeUnavailable) && !(e instanceof RpcError)) throw e;
      if (!this.nodeDown) log.warn("node_down", { origin: this.config.rpcOrigin, reason: e instanceof NodeUnavailable ? e.reason : e.message });
      this.nodeDown = true;
      return null;
    }
  }

  // One getUpdates from the saved offset: `timeout` 0 drains in `tick`, CAIRN_TG_TIMEOUT long-polls in `run`.
  async poll(timeout) {
    const offset = this.store.offset();
    return this.tg.call("getUpdates", { ...(offset ? { offset } : {}), timeout, allowed_updates: ["message"] }, { timeoutMs: (timeout + 15) * 1000 });
  }

  // Handles updates in order. `head` gives the latest block (or null), read at most once per batch.
  async handle(updates, head) {
    for (const u of updates) {
      if (!Number.isSafeInteger(u?.update_id) || u.update_id < this.store.offset()) continue; // already handled
      const replies = await this.respond(u.message, head);
      this.store.setOffset(u.update_id + 1); // saved before the reply is sent: never answered twice
      this.counts.updates++;
      for (const m of replies) if (await this.tg.send(m)) this.counts.sent++;
    }
  }

  // The messages that answer `message`: [] when it is not for Cairn.
  async respond(message, head) {
    if (!message?.chat || typeof message.text !== "string") return [];
    const chat = message.chat;
    const isGroup = chat.type !== "private";
    const bot = this;
    // spec is read when used: the first head() of the process sets it.
    const ctx = { me: this.me, config: this.config, chain: this.chain, head, isGroup, stop: this.stop, get spec() { return bot.spec; } };
    let lines;
    try {
      lines = await route(message.text, ctx);
    } catch (e) {
      if (this.stop.aborted || e instanceof Fatal) throw e;
      if (e instanceof NodeUnavailable) {
        log.warn("lookup_busy", { chat: chat.id, reason: e.reason });
        lines = BUSY;
      } else if (e instanceof RpcError) {
        log.warn("lookup_refused", { chat: chat.id, code: e.code, reason: e.message });
        lines = [`⚠️ The node refused this lookup (JSON-RPC error ${Number(e.code)}). Please try again later.`];
      } else {
        log.error("command_failed", { chat: chat.id, error: String(e?.stack ?? e).slice(0, 1000) });
        lines = OOPS;
      }
    }
    if (!lines.length) return [];
    log.info("answered", { chat: chat.id, type: chat.type, command: /^\/(\w+)/.exec(message.text)?.[1]?.toLowerCase() ?? "text" });
    // In a group the reply quotes the command, so that people see which request it answers; in a forum
    // it stays in the command's topic.
    const thread = message.is_topic_message && message.message_thread_id ? { message_thread_id: message.message_thread_id } : {};
    const quote = isGroup ? { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } } : {};
    return pack(lines).map((text, i) => ({ chat_id: chat.id, text, ...thread, ...(i === 0 ? quote : {}) }));
  }
}

// A head reader for one batch of updates: the block is read on first use, then shared.
export function headOnce(bot) {
  let p = null;
  return () => (p ??= bot.readHead());
}
