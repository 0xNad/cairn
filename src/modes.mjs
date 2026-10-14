// The three commands of the command line. Each resolves to { code, line }: the exit code and the JSON
// object to print on standard output (doctor and tick), or throws Fatal or TelegramUnreachable.
import { Bot, headOnce } from "./bot.mjs";
import { EXIT, Fatal } from "./errors.mjs";
import { log } from "./log.mjs";
import { NodeUnavailable, RpcError, rpcClient } from "./rpc.mjs";
import { starknet } from "./starknet.mjs";
import { TelegramUnreachable, telegramClient } from "./telegram.mjs";
import { backoff, sleep } from "./wait.mjs";

// At most this many pages of getUpdates (100 updates each) in one tick, so that a tick always ends.
const MAX_PAGES = 50;

// doctor: getMe, then the node's chain, spec version and head block. It writes nothing.
export async function doctor(config, stop) {
  const tg = telegramClient({ root: config.telegramApiRoot, token: config.token, stop });
  const chain = starknet(rpcClient({ url: config.rpcUrl, rps: config.rpcRps, timeoutMs: config.rpcTimeoutMs, stop }));
  const me = await tg.call("getMe");
  try {
    const { chain: name, spec } = await chain.verify(config.chain);
    const block = await chain.blockNumber();
    return { code: EXIT.OK, line: { bot: me.username, chain: name, block, spec } };
  } catch (e) {
    if (e instanceof NodeUnavailable) throw new Fatal(EXIT.UNREACHABLE, `cannot use the Starknet node at ${config.rpcOrigin}: ${e.reason}`);
    if (e instanceof RpcError) throw new Fatal(EXIT.UNREACHABLE, `the Starknet node at ${config.rpcOrigin} refused a basic call (${e.message}): is STARKNET_RPC_URL a Starknet JSON-RPC endpoint?`);
    throw e;
  }
}

// tick: one pass. getUpdates with timeout 0 until it answers nothing; that last call, from the offset
// after the last handled update, also confirms the offset to Telegram.
export async function tick(config, stop) {
  const bot = new Bot(config, stop);
  try {
    await bot.connect();
    const head = await bot.readHead();
    const sameHead = () => Promise.resolve(head);
    for (let pages = 1; ; pages++) {
      const updates = await bot.poll(0);
      if (!updates.length) break;
      await bot.handle(updates, sameHead);
      if (pages === MAX_PAGES) {
        await bot.tg.call("getUpdates", { offset: bot.store.offset(), limit: 1, timeout: 0 });
        break;
      }
    }
    return { code: EXIT.OK, line: { updates: bot.counts.updates, sent: bot.counts.sent, head: head?.number ?? null } };
  } finally {
    bot.close();
  }
}

// run: a pass every CAIRN_POLL_MS, long-polling getUpdates in between, until SIGTERM or SIGINT aborts
// `stop`. Telegram being unreachable is waited out; only a Fatal ends it early.
export async function run(config, stop) {
  const bot = new Bot(config, stop);
  try {
    await bot.connect({ deleteWebhook: true });
    log.info("started", { bot: bot.me.username, chain: config.chain, node: config.rpcOrigin, poll_ms: config.pollMs });
    let due = 0, failures = 0;
    while (!stop.aborted) {
      try {
        if (Date.now() >= due) {
          await bot.readHead(); // the pass; round 2 adds the scan and the deliveries here
          due = Date.now() + config.pollMs;
        }
        // Long-poll until the next pass is due (at least 1 s, at most CAIRN_TG_TIMEOUT).
        const timeout = config.tgTimeout === 0 ? 0 : Math.min(config.tgTimeout, Math.max(1, Math.ceil((due - Date.now()) / 1000)));
        const updates = await bot.poll(timeout);
        if (updates.length) await bot.handle(updates, headOnce(bot));
        else if (timeout === 0) await sleep(Math.min(1000, Math.max(50, due - Date.now())), stop);
        failures = 0;
      } catch (e) {
        if (stop.aborted) break;
        if (!(e instanceof TelegramUnreachable)) throw e;
        failures++;
        log.warn("telegram_unreachable", { reason: e.message, retry_in_ms: backoff(failures) });
        await sleep(backoff(failures), stop).catch(() => {});
      }
    }
    log.info("stopped");
    return { code: EXIT.OK };
  } finally {
    bot.close();
  }
}
