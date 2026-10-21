import { normalize, unsigned } from "./felt.mjs";
import { RpcError } from "./errors.mjs";
import { TRANSFER, APPROVAL, same, eventShape } from "./alert-values.mjs";
import { amount, escapeHtml as esc, utc } from "./format.mjs";

const relevantWatches = (c, e, block) =>
  c.watches.filter(
    (w) => block > w.since_block && (w.address === e.a || w.address === e.b),
  );
const matchingReceipt = (a, b) =>
  same(a.from_address, b.from_address) &&
  a.keys?.length === b.keys?.length &&
  a.data?.length === b.data?.length &&
  a.keys.every((v, i) => same(v, b.keys[i])) &&
  a.data.every((v, i) => same(v, b.data[i]));

/** One chain-wide range; only relevant transactions need receipts and block headers. */
export async function scanRange(ctx, head) {
  const { state, config, rpc } = ctx;
  if (state.cursor >= head.block_number) return;
  const from = state.cursor + 1;
  const to = Math.min(head.block_number, state.cursor + config.maxBlocks);
  let events = [],
    continuation,
    invalid = 0;
  const tokens = new Set();
  for (;;) {
    let page;
    try {
      page = await rpc.call("starknet_getEvents", {
        filter: {
          from_block: { block_number: from },
          to_block: { block_number: to },
          keys: [[TRANSFER, APPROVAL]],
          chunk_size: 1000,
          ...(continuation ? { continuation_token: continuation } : {}),
        },
      });
    } catch (error) {
      if (error instanceof RpcError && error.code === 33 && invalid++ < 2) {
        events = [];
        continuation = undefined;
        tokens.clear();
        continue;
      }
      throw error;
    }
    if (!Array.isArray(page?.events)) throw new Error("Invalid events page.");
    events.push(...page.events);
    if (!page.continuation_token) break;
    if (
      typeof page.continuation_token !== "string" ||
      tokens.has(page.continuation_token)
    )
      throw new Error("Repeated or invalid continuation token.");
    tokens.add(page.continuation_token);
    continuation = page.continuation_token;
  }
  // getEvents is chain ordered. Explicit indexes, when supplied, additionally constrain that order.
  events.sort(
    (a, b) =>
      a.block_number - b.block_number ||
      (a.transaction_index ?? 0) - (b.transaction_index ?? 0) ||
      (a.event_index ?? 0) - (b.event_index ?? 0),
  );
  const transactions = new Map();
  for (const event of events) {
    if (
      !Number.isSafeInteger(event.block_number) ||
      event.block_number < from ||
      event.block_number > to
    )
      throw new Error("Event outside requested range.");
    const shape = eventShape(event);
    if (!shape) continue;
    const relevant = Object.values(state.chats).some(
      (c) =>
        relevantWatches(c, shape, event.block_number).length ||
        (shape.isTransfer &&
          c.whales.some(
            (w) =>
              event.block_number > w.since_block &&
              w.token === shape.contract &&
              !c.muted.includes(w.token),
          )),
    );
    if (!relevant) continue;
    const hash = normalize(event.transaction_hash, "hash");
    if (!transactions.has(hash)) transactions.set(hash, []);
    transactions.get(hash).push({ event, shape });
  }
  const headers = new Map();
  for (const [hash, list] of transactions) {
    const block = list[0].event.block_number;
    if (!headers.has(block))
      headers.set(
        block,
        await rpc.call("starknet_getBlockWithTxHashes", {
          block_id: { block_number: block },
        }),
      );
    const header = headers.get(block);
    const receipt = await rpc.call("starknet_getTransactionReceipt", {
      transaction_hash: hash,
    });
    if (!Array.isArray(receipt.events))
      throw new Error("Invalid transaction receipt.");
    const strk = config.tokens.find((t) => t.symbol === "STRK");
    let tx;
    const used = new Set(),
      decoded = [];
    for (const { event, shape } of list) {
      // JSON-RPC events need not include event_index. Match occurrence-by-occurrence against the
      // receipt, comparing numeric felts so different leading-zero encodings remain equivalent.
      const index = receipt.events.findIndex(
        (r, i) => !used.has(i) && matchingReceipt(r, event),
      );
      if (index < 0) throw new Error("Event missing from its receipt.");
      used.add(index);
      const { a, b, value, isTransfer } = shape;
      if (isTransfer && value === 0n) continue;
      if (
        isTransfer &&
        strk?.address === shape.contract &&
        index === receipt.events.length - 1 &&
        same(b, header.sequencer_address) &&
        value === unsigned(receipt.actual_fee.amount)
      ) {
        tx ??= await rpc.call("starknet_getTransactionByHash", {
          transaction_hash: hash,
        });
        if (same(a, tx.sender_address)) continue;
      }
      let token;
      try {
        token = await ctx.token(shape.contract, head);
      } catch (error) {
        // Only a proven non-coin can be skipped. A transient lookup failure leaves the cursor behind.
        if (
          state.tokens[shape.contract]?.coin === false &&
          head.timestamp - state.tokens[shape.contract].at < 604800
        )
          continue;
        throw error;
      }
      decoded.push({ ...shape, token, index, block: event.block_number });
    }
    for (const [chatId, c] of Object.entries(state.chats)) {
      const lines = [],
        indices = [];
      for (const e of decoded) {
        const wa = c.watches.find(
          (w) => w.address === e.a && e.block > w.since_block,
        );
        const wb = c.watches.find(
          (w) => w.address === e.b && e.block > w.since_block,
        );
        // Seen-token discovery is independent of notification floors and mutes.
        if (e.isTransfer)
          for (const watch of [wa, wb].filter(Boolean)) {
            const seen = (c.seen[watch.address] ??= []);
            if (!seen.includes(e.contract)) seen.push(e.contract);
          }
        if (c.muted.includes(e.contract)) continue;
        if (e.isTransfer) {
          const whale = c.whales.some(
            (w) =>
              w.token === e.contract &&
              e.block > w.since_block &&
              e.value >= BigInt(w.amount),
          );
          const floor = c.minimums.find((m) => m.token === e.contract);
          if (
            !(
              whale ||
              ((wa || wb) && (!floor || e.value >= BigInt(floor.amount)))
            )
          )
            continue;
          const direction =
            wa && wb ? "between" : wa ? "out" : wb ? "in" : "whale";
          const label = (w) =>
            w?.label ? ` (${esc(ctx.clean(w.label))})` : "";
          const mintBurn =
            BigInt(e.a) === 0n ? " mint" : BigInt(e.b) === 0n ? " burn" : "";
          lines.push(
            `${direction}${mintBurn}: ${esc(amount(e.value, e.token.decimals, "").trim())} ${ctx.tokenText(e.token)}\n${ctx.link("contract", e.a)}${label(wa)} → ${ctx.link("contract", e.b)}${label(wb)}`,
          );
        } else {
          if (!wa) continue;
          const value =
            e.value >= (1n << 128n) - 1n
              ? "unlimited"
              : esc(amount(e.value, e.token.decimals, "").trim());
          lines.push(
            `Approval: ${ctx.tokenText(e.token)} ${value}\nOwner ${ctx.link("contract", e.a)} → spender ${ctx.link("contract", e.b)}`,
          );
        }
        indices.push(e.index);
      }
      if (lines.length)
        ctx.pending(
          Number(chatId),
          hash,
          [
            `Transaction ${ctx.link("tx", hash)} · block ${block} · ${utc(header.timestamp)}`,
            ...lines,
          ],
          indices,
        );
    }
  }
  state.cursor = to;
  ctx.save();
}
