// `node cairn.mjs tick`: one pass. Drains the pending updates, answers them, confirms the offset and prints
// {"updates":<n>,"sent":<n>,"head":<block number>|null} on standard output. Exits 0 when the node is down.
import { NodeUnavailable } from "../rpc.mjs";
import { openStore } from "../store.mjs";
import { writeFd } from "../util.mjs";
import { handleBatch, prepare } from "./app.mjs";

export async function tick(app) {
  const store = await openStore(app.config.dataDir, app.log);
  try {
    const bot = await prepare(app, store);
    const sentBefore = app.tg.sent;
    let updates = 0;
    let head = null;

    for (;;) {
      const before = store.offset();
      const batch = await app.tg.getUpdates({ offset: before ?? undefined, limit: 100, timeout: 0 });
      if (batch.length === 0) break;
      head = (await handleBatch(bot, app.chain, app.log, batch)) ?? head;
      updates += batch.length;
      if (store.offset() === before) break; // no progress: never loop on updates that cannot be consumed
    }
    const offset = store.offset();
    if (offset !== null) await app.tg.getUpdates({ offset, limit: 1, timeout: 0 }); // confirm what was handled

    if (head === null) {
      try {
        head = await app.chain.head();
      } catch (e) {
        if (!(e instanceof NodeUnavailable)) throw e;
        app.log.warn("node_busy", { reason: e.message });
      }
    }
    const line = JSON.stringify({ updates, sent: app.tg.sent - sentBefore, head: head ? head.number : null });
    writeFd(1, `${line}\n`);
    return 0;
  } finally {
    store.close();
  }
}
