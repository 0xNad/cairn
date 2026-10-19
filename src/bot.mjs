import { CairnError, log } from "./errors.mjs";
import { decodeChain } from "./felt.mjs";
import { messages, redactor } from "./format.mjs";
import { answer, COMMANDS, parseCommand } from "./commands.mjs";
import { Store } from "./store.mjs";
import { Rpc, Telegram, sleep } from "./transport.mjs";
import { RoundTwo, EXTRA_COMMANDS } from "./round2.mjs";

async function handshake(rpc, config, clean) {
  const chain = decodeChain(await rpc.call("starknet_chainId"));
  if (chain !== config.chain)
    throw new CairnError(
      `Node reports ${clean(chain)}; expected ${config.chain}.`,
      2,
    );
  const spec = await rpc.call("starknet_specVersion");
  const version =
    typeof spec === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(spec) : null;
  if (!version || !(Number(version[1]) > 0 || Number(version[2]) >= 10)) {
    throw new CairnError(
      `Node spec ${clean(String(spec).slice(0, 100))} is below 0.10.0 or malformed.`,
      2,
    );
  }
  return { chain, spec: clean(spec) };
}
export async function serve(config, signal) {
  const clean = redactor(config),
    rpc = new Rpc(config, signal),
    tg = new Telegram(config, signal);
  const me = await tg.call("getMe");
  if (!/^[A-Za-z0-9_]{1,64}$/.test(me?.username ?? ""))
    throw new CairnError("Telegram returned an invalid bot username.");
  const username = clean(me.username);
  let identity = null;
  try {
    identity = await handshake(rpc, config, clean);
  } catch (error) {
    if (
      signal.aborted ||
      config.mode === "doctor" ||
      (error instanceof CairnError && error.exitCode === 2)
    )
      throw error;
    log(
      "warn",
      "node busy: chain identity will be checked again before chain reads.",
    );
  }
  if (config.mode === "doctor") {
    const block = await rpc.call("starknet_blockNumber");
    if (!Number.isSafeInteger(block) || block < 0)
      throw new CairnError("Node returned an invalid block number.");
    return { bot: username, ...identity, block };
  }
  const store = new Store(config.data);
  const r2 = new RoundTwo(
    { config, rpc, username, clean, spec: identity?.spec, signal },
    store,
    tg,
  );
  try {
    if (config.mode === "run")
      await tg.call("deleteWebhook", { drop_pending_updates: false });
    const allCommands = [
      ...COMMANDS,
      ...EXTRA_COMMANDS.map((command) => ({
        command,
        description: `Wallet alerts: ${command}`,
      })),
    ];
    const commandList = JSON.stringify(allCommands);
    if (store.state.commands !== commandList) {
      await tg.call("setMyCommands", { commands: allCommands });
      store.state.commands = commandList;
      store.save();
    }
    let updates = 0,
      sent = 0,
      head = null,
      alerts = 0;
    const readHead = async () => {
      try {
        identity ??= await handshake(rpc, config, clean);
        const block = await rpc.call("starknet_getBlockWithTxHashes", {
          block_id: "latest",
        });
        if (
          !Number.isSafeInteger(block?.block_number) ||
          block.block_number < 0 ||
          !Number.isSafeInteger(block.timestamp)
        )
          throw new Error("invalid header");
        head = block;
      } catch (error) {
        if (
          signal.aborted ||
          (error instanceof CairnError && error.exitCode === 2)
        )
          throw error;
        head = null;
        log("warn", "node busy: latest header unavailable.");
      }
    };
    await readHead();
    while (!signal.aborted) {
      const batch = await tg.call("getUpdates", {
        offset: store.state.offset,
        limit: 100,
        timeout: config.mode === "tick" ? 0 : config.tgTimeout,
        allowed_updates: ["message", "callback_query", "my_chat_member"],
      });
      if (!Array.isArray(batch))
        throw new CairnError("Telegram returned invalid updates.");
      if (config.mode === "run") await readHead();
      for (const update of batch) {
        if (signal.aborted) break;
        if (!Number.isSafeInteger(update.update_id) || update.update_id < 0)
          throw new CairnError("Telegram returned an invalid update id.");
        if (update.update_id < store.state.offset) continue;
        const message = update.message;
        const command = parseCommand(message, username);
        const extra = await r2.handle(update, head);
        const reply =
          extra?.lines ??
          (command
            ? await answer(command, {
                config,
                rpc,
                username,
                clean,
                head,
                spec: identity?.spec,
                signal,
              })
            : []);
        // Claim durably before sending: Telegram has no idempotency key. A crash can lose a reply,
        // but never replays an accepted one. No chat text or lookup argument is persisted.
        store.state.offset = update.update_id + 1;
        store.save();
        updates++;
        const chatId =
          message?.chat?.id ?? update.callback_query?.message?.chat?.id;
        if (extra && Number.isSafeInteger(chatId)) {
          sent += (await r2.send(chatId, reply, extra.markup, extra.chunks))
            .accepted;
        } else if (command && Number.isSafeInteger(message?.chat?.id)) {
          for (const text of messages(reply)) {
            const accepted = await tg.call("sendMessage", {
              chat_id: message.chat.id,
              text,
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
              ...(Number.isSafeInteger(message.message_thread_id)
                ? { message_thread_id: message.message_thread_id }
                : {}),
            });
            if (accepted === null) break;
            sent++;
          }
        }
      }
      try {
        await r2.scan(head);
      } catch (error) {
        if (signal.aborted) throw error;
        log("warn", "node busy: scan left at its last durable cursor.");
      }
      let delivered = 0;
      try {
        delivered = await r2.deliver();
      } catch (error) {
        if (signal.aborted || config.mode === "tick" || error.exitCode === 3)
          throw error;
        log(
          "warn",
          "Telegram delivery unavailable; pending alerts retained for retry.",
        );
        await sleep(config.pollMs, signal);
      }
      alerts += delivered;
      sent += delivered;
      if (config.mode === "tick" && batch.length === 0) {
        await tg.call("getUpdates", {
          offset: store.state.offset,
          limit: 1,
          timeout: 0,
          allowed_updates: ["message"],
        });
        return {
          updates,
          sent,
          head: head?.block_number ?? null,
          alerts,
          cursor: r2.state.cursor ?? 0,
        };
      }
      if (config.mode === "run" && config.tgTimeout === 0 && !batch.length)
        await sleep(config.pollMs, signal);
    }
  } finally {
    store.close();
  }
}
