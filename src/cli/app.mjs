// Wires the pieces of one process: the clients, the chain layer and the steps run and tick share.
import { createBot } from "../chat/bot.mjs";
import { BOT_COMMANDS } from "../chat/commands/index.mjs";
import { Chain } from "../chain.mjs";
import { EXIT, ExitError } from "../errors.mjs";
import { NodeUnavailable, Rpc } from "../rpc.mjs";
import { Telegram } from "../telegram.mjs";

/** The clients for one configuration. `signal` aborts every request in flight (shutdown). */
export function createApp(config, { log, signal }) {
  const tg = new Telegram({ root: config.telegramRoot, token: config.token, log, signal });
  const rpc = new Rpc({ url: config.rpcUrl, rps: config.rpcRps, timeoutMs: config.rpcTimeoutMs, log, signal });
  const chain = new Chain({ rpc, expected: config.chain, log });
  return { config, log, signal, tg, rpc, chain };
}

/** Everything in the configuration that must never be printed, for the logger's redactor. */
export function secretsOf(config) {
  const out = [config.token, config.token.slice(config.token.indexOf(":") + 1), config.rpcUrl];
  const url = new URL(config.rpcUrl);
  out.push(`${url.pathname}${url.search}`, url.password, url.username);
  for (const part of url.pathname.split("/")) out.push(decodeURIComponent(part));
  for (const [, value] of url.searchParams) out.push(value);
  return out.filter((s) => s.length >= 8);
}

/**
 * The head block, fetched at most once per batch of updates and only if a command asks for it.
 * A busy node gives null (the commands then say so); a node on another chain still ends the process.
 */
export function headGetter(chain, log) {
  let pending = null;
  let latest = null;
  const get = () =>
    (pending ??= chain.head().then(
      (head) => (latest = head),
      (e) => {
        if (!(e instanceof NodeUnavailable)) throw e;
        log.warn("node_busy", { reason: e.message });
        return null;
      },
    ));
  get.latest = () => latest;
  return get;
}

/** Answers a batch of updates, in order. Returns the head it read, if any. */
export async function handleBatch(bot, chain, log, updates) {
  const getHead = headGetter(chain, log);
  for (const update of updates) await bot.handle(update, getHead);
  return getHead.latest();
}

/** Registers the commands when Telegram's list differs from the stored one. */
async function syncCommands(app, store) {
  const key = JSON.stringify(BOT_COMMANDS);
  if (store.commandsKey() === key) return;
  try {
    await app.tg.setMyCommands(BOT_COMMANDS);
    store.setCommandsKey(key);
  } catch (e) {
    if (e?.name !== "TelegramError") throw e;
    app.log.warn("set_commands_failed", { code: e.code });
  }
}

/**
 * What `run` and `tick` do first: who the bot is, no webhook, the node checked (if it answers), the commands.
 * @returns the bot, ready to handle updates
 */
export async function prepare(app, store) {
  const me = await app.tg.getMe();
  if (typeof me?.username !== "string" || !/^\w+$/.test(me.username)) {
    throw new ExitError(EXIT.UNREACHABLE, "Telegram's getMe answered without a bot username");
  }
  await app.tg.deleteWebhook();
  try {
    await app.chain.verify();
  } catch (e) {
    if (!(e instanceof NodeUnavailable)) throw e;
    app.log.warn("node_unreachable", { note: "the chain check is repeated with the next command that needs the node" });
  }
  await syncCommands(app, store);
  return createBot({ config: app.config, tg: app.tg, chain: app.chain, store, log: app.log, username: me.username });
}
