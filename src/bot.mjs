// The three commands of the command line (ARCHITECTURE.md, "The command line" and "One pass").
//
//   tick    one pass: the head, every pending update answered in order, the offset confirmed, one JSON line
//   run     a pass every CAIRN_POLL_MS, long-polling getUpdates in between, until SIGTERM or SIGINT
//   doctor  getMe and the node's chain, spec version and head, as one JSON line
//
// A pass reads the head first; commands that need the chain answer "node busy" when it is null. Each update
// is saved as handled before its reply is sent, so none is ever answered twice.
import { MENU, answer } from "./commands/index.mjs";
import { conflict, isAbort, unreachable } from "./errors.mjs";
import { paginate } from "./format.mjs";
import { sleep } from "./http.mjs";
import { NodeUnavailable, RpcError } from "./rpc.mjs";
import { checkNode } from "./starknet.mjs";
import { TelegramError } from "./telegram.mjs";

/** Round 1 asks Telegram for messages only. */
const ALLOWED_UPDATES = ["message"];

export function createBot({ config, log, tg, chain, store, signal }) {
  let me = null, node = null;
  let nodeDownSince = null;

  /** The node check (once per process, before any other chain call), then the head; null when unreachable. */
  async function readHead() {
    try {
      node ??= await checkNode(chain, config.chain);
      // While the node is down, one try per pass keeps replies quick ("node busy") until it is back.
      const head = await chain.header(undefined, nodeDownSince ? { tries: 1 } : undefined);
      if (nodeDownSince) log.info("node_back", { rpc: chain.rpc.origin, down_s: Math.round((Date.now() - nodeDownSince) / 1000) });
      nodeDownSince = null;
      return head;
    } catch (e) {
      if (!(e instanceof NodeUnavailable || e instanceof RpcError)) throw e;
      if (!nodeDownSince) log.warn("node_unavailable", { rpc: chain.rpc.origin, reason: e.reason ?? e.message });
      nodeDownSince ??= Date.now();
      return null;
    }
  }

  /** setMyCommands, whenever the stored command list differs from the current one. */
  async function syncCommands() {
    const json = JSON.stringify(MENU);
    if (store.get("commands") === json) return;
    try {
      await tg.must("setMyCommands", { commands: MENU });
      store.set("commands", json);
      log.info("commands_set", { commands: MENU.map((c) => c.command) });
    } catch (e) {
      if (!(e instanceof TelegramError)) throw e;
      log.warn("commands_not_set", { code: e.code, description: e.description.slice(0, 200) });
    }
  }

  /** getUpdates from the saved offset. 409 exits 1; other failures go through tg.must. */
  async function getUpdates(timeout, limit = 100) {
    const offset = store.offset();
    try {
      const r = await tg.must("getUpdates", { ...(offset ? { offset } : {}), limit, timeout, allowed_updates: ALLOWED_UPDATES }, { timeoutMs: timeout * 1000 + 15_000 });
      return Array.isArray(r) ? r : [];
    } catch (e) {
      if (e instanceof TelegramError && e.code === 409) throw conflict(e.description);
      throw e;
    }
  }

  /** Handles one update: the reply is computed, the update saved as handled, then the reply sent. */
  async function handle(u, head, counts) {
    if (!Number.isSafeInteger(u?.update_id) || u.update_id < store.offset()) return;
    const msg = u.message;
    const blocks = await answer(msg, { config, chain, head, node, me, log });
    signal.throwIfAborted(); // a reply cut short by a shutdown is not saved: the update is answered after a restart
    store.handled(u.update_id);
    counts.updates++;
    if (!blocks) return;
    const group = msg.chat.type !== "private";
    for (const [i, html] of paginate(blocks).entries()) {
      // In a group, the first message replies to the command, so a busy chat can see who asked.
      const extra = {
        ...(group && i === 0 ? { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } } : {}),
        ...(msg.is_topic_message && msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}),
      };
      const sent = await tg.send(msg.chat.id, html, extra);
      if (!sent) break; // refused for good (a 403 skips the chat): the rest of this reply would be too
      counts.sent++;
    }
  }

  async function start() {
    me = await tg.getMe();
    await syncCommands();
  }

  return {
    async tick() {
      await start();
      const head = await readHead();
      const counts = { updates: 0, sent: 0 };
      for (;;) {
        const batch = await getUpdates(0);
        if (!batch.length) break;
        for (const u of batch) await handle(u, head, counts);
      }
      await getUpdates(0, 1); // confirms the offset: {"offset": last + 1, "limit": 1, "timeout": 0}
      return { updates: counts.updates, sent: counts.sent, head: head?.number ?? null };
    },

    async run() {
      await tg.must("deleteWebhook", { drop_pending_updates: false });
      await start();
      log.info("running", { bot: me.username, chain: config.chain, rpc: chain.rpc.origin, poll_ms: config.pollMs });
      const counts = { updates: 0, sent: 0 };
      let head = null, headAt = 0, nextPass = 0, telegramDown = 0;
      while (!signal.aborted) {
        try {
          if (Date.now() >= nextPass) {
            head = await readHead();
            headAt = Date.now();
            nextPass = headAt + config.pollMs;
          }
          // Long-poll until the next pass is due (at least 1 s, at most CAIRN_TG_TIMEOUT); 0 short-polls.
          const wait = config.tgTimeout === 0 ? 0 : Math.min(config.tgTimeout, Math.max(1, Math.ceil((nextPass - Date.now()) / 1000)));
          const batch = await getUpdates(wait);
          telegramDown = 0;
          if (batch.length && Date.now() - headAt > 1000) {
            head = await readHead();
            headAt = Date.now();
          }
          for (const u of batch) await handle(u, head, counts);
          if (!batch.length && wait === 0) await sleep(Math.min(1000, nextPass - Date.now()), signal);
        } catch (e) {
          if (isAbort(e) || signal.aborted) break;
          if (!e.transient) throw e;
          // Telegram is unreachable mid-run: wait it out, longer each time, rather than exit.
          telegramDown = Math.min(60, telegramDown * 2 || 2);
          log.warn("telegram_unavailable", { reason: e.message, retry_in_s: telegramDown });
          await sleep(telegramDown * 1000, signal).catch(() => {});
        }
      }
      log.info("stopped", { updates: counts.updates, sent: counts.sent });
      return null;
    },

    async doctor() {
      me = await tg.getMe();
      let found, block;
      try {
        found = await checkNode(chain, config.chain);
        block = await chain.blockNumber();
      } catch (e) {
        if (e instanceof NodeUnavailable) throw unreachable(`the node at ${chain.rpc.origin} is unreachable (${e.reason}): check STARKNET_RPC_URL`);
        if (e instanceof RpcError) throw unreachable(`the node at ${chain.rpc.origin} answered with an error (${e.message.slice(0, 120)})`);
        throw e;
      }
      return { bot: me.username, chain: found.chain, block: Number(block), spec: found.spec };
    },
  };
}
