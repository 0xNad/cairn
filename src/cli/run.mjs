// `node cairn.mjs run`: long-polls Telegram and answers commands until SIGTERM or SIGINT. A flaky Telegram or
// node never stops it; ten failed polls in a row (Telegram unreachable) do, with exit 1.
import { EXIT, ExitError } from "../errors.mjs";
import { TelegramUnreachable } from "../telegram.mjs";
import { openStore } from "../store.mjs";
import { isAbort, sleep } from "../util.mjs";
import { handleBatch, prepare } from "./app.mjs";

const MAX_FAILED_POLLS = 10;
const MAX_BACKOFF_MS = 30_000;

export async function run(app) {
  const { config, log, signal } = app;
  const store = await openStore(config.dataDir, log);
  try {
    const bot = await prepare(app, store);
    log.info("started", { chain: config.chain, tokens: config.network.tokens.length });
    let failed = 0;

    while (!signal.aborted) {
      const began = Date.now();
      let batch;
      try {
        batch = await app.tg.getUpdates({ offset: store.offset() ?? undefined, limit: 100, timeout: config.tgTimeout });
        failed = 0;
      } catch (e) {
        if (!(e instanceof TelegramUnreachable)) throw e;
        if (++failed >= MAX_FAILED_POLLS) throw new ExitError(EXIT.UNREACHABLE, "Telegram has been unreachable for ten polls in a row");
        log.warn("poll_failed", { consecutive: failed });
        await sleep(Math.min(MAX_BACKOFF_MS, 500 * 2 ** failed), signal);
        continue;
      }
      if (batch.length > 0) {
        await handleBatch(bot, app.chain, log, batch);
        continue; // updates came in: ask again at once
      }
      // An empty poll (a short TG timeout) is not repeated faster than CAIRN_POLL_MS.
      const wait = config.pollMs - (Date.now() - began);
      if (wait > 0) await sleep(wait, signal);
    }
    return 0;
  } catch (e) {
    if (isAbort(e) && signal.aborted) return 0; // SIGTERM or SIGINT
    throw e;
  } finally {
    store.close();
  }
}
