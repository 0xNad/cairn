import { normalize, SELECTORS, unsigned } from './felt.mjs';
import { RpcError } from './errors.mjs';
import { decodeEvent, eventAddress, relevant, alertLine, transactionFooter, transactionMessages } from './alerts.mjs';
import { enqueueParts } from './ledger.mjs';

async function pages(rpc, from, to) {
  // An invalid token restarts the whole range once. Nothing is committed or sent until it is complete.
  for (let restart = 0; restart < 2; restart++) {
    const events = [], tokens = new Set();
    let continuation;
    try {
      do {
        const page = await rpc.call('starknet_getEvents', { filter: {
          from_block: { block_number: from }, to_block: { block_number: to },
          keys: [[SELECTORS.Transfer, SELECTORS.Approval]], chunk_size: 1000,
          ...(continuation === undefined ? {} : { continuation_token: continuation }),
        } });
        if (!Array.isArray(page?.events)) throw new Error('Invalid events page.');
        events.push(...page.events);
        continuation = page.continuation_token || undefined;
        if (continuation !== undefined) {
          if (typeof continuation !== 'string' || tokens.has(continuation)) throw new Error('Non-progressing event pagination.');
          tokens.add(continuation);
        }
      } while (continuation !== undefined);
      return events;
    } catch (error) {
      if (!(error instanceof RpcError && error.code === 33 && restart === 0)) throw error;
    }
  }
}

export async function scan(context) {
  const { store, head, rpc, config, tokens } = context;
  if (!head) return;
  if (store.state.cursor === null) {
    store.state.cursor = head.block_number;
    store.save();
    return;
  }
  const from = store.state.cursor + 1;
  const to = Math.min(head.block_number, store.state.cursor + config.maxBlocks);
  if (from > to) return;
  const before = structuredClone(store.state);
  try {
    const events = await pages(rpc, from, to);
    const groups = new Map();
    for (const raw of events) {
      if (!Number.isSafeInteger(raw.block_number) || raw.block_number < from || raw.block_number > to) throw new Error('Event outside requested range.');
      const event = decodeEvent(raw, raw.event_index);
      if (!event || !Object.values(store.state.chats).some(c => relevant(c, event, raw.block_number))) continue;
      const hash = normalize(raw.transaction_hash, 'hash');
      if (groups.has(hash) && groups.get(hash).number !== raw.block_number) throw new Error('Transaction moved during scan.');
      groups.set(hash, { hash, number: raw.block_number });
    }
    const blocks = new Map();
    for (const { number } of groups.values()) {
      if (!blocks.has(number)) {
        const block = number === head.block_number ? head :
          await rpc.call('starknet_getBlockWithTxHashes', { block_id: { block_number: number } });
        if (block?.block_number !== number || !Number.isSafeInteger(block.timestamp) || !Array.isArray(block.transactions)) throw new Error('Invalid block.');
        blocks.set(number, { ...block, order: new Map(block.transactions.map((h, i) => [normalize(h, 'hash'), i])) });
      }
    }
    const ordered = [...groups.values()].sort((a, b) => a.number - b.number ||
      blocks.get(a.number).order.get(a.hash) - blocks.get(b.number).order.get(b.hash));
    for (const { hash, number } of ordered) {
      const block = blocks.get(number);
      if (!block.order.has(hash)) throw new Error('Transaction missing from block.');
      const receipt = await rpc.call('starknet_getTransactionReceipt', { transaction_hash: hash });
      if (!Array.isArray(receipt?.events) || receipt.block_number !== number ||
          receipt.transaction_hash && normalize(receipt.transaction_hash, 'hash') !== hash ||
          receipt.block_hash && block.block_hash && normalize(receipt.block_hash, 'hash') !== normalize(block.block_hash, 'hash')) throw new Error('Invalid receipt.');
      // Receipt positions are canonical, including when getEvents has no indexes or pages overlap.
      const decoded = receipt.events.map(decodeEvent).filter(Boolean);
      let sender;
      const strk = config.tokens.find(t => t.symbol === 'STRK')?.address;
      const last = decoded.find(e => e.index === receipt.events.length - 1);
      if (last?.kind === 'Transfer' && last.address === strk &&
          last.to === eventAddress(block.sequencer_address) && receipt.actual_fee?.unit === 'FRI' &&
          last.value === unsigned(receipt.actual_fee.amount)) {
        const tx = await rpc.call('starknet_getTransactionByHash', { transaction_hash: hash });
        // Read-only sender lookup is necessary to distinguish a fee from a third-party transfer.
        sender = tx.sender_address ? normalize(tx.sender_address) : null;
      }
      const outputs = new Map();
      for (const event of decoded) {
        if (event.kind === 'Transfer' && (event.value === 0n || event === last && sender === event.from)) continue;
        const chats = Object.entries(store.state.chats).filter(([, c]) => relevant(c, event, number));
        if (!chats.length) continue;
        const token = await tokens.get(event.address);
        if (!token) continue;
        for (const [id, chat] of chats) {
          const line = alertLine(chat, event, token, number, context);
          if (!line) continue;
          if (!outputs.has(id)) outputs.set(id, { lines: [], indexes: [] });
          outputs.get(id).lines.push(line);
          outputs.get(id).indexes.push(event.index);
        }
      }
      for (const [id, output] of outputs) {
        enqueueParts(store.state.chats[id], `tx:${hash}`, transactionMessages(output.lines, transactionFooter(hash, block, context)),
          { hash, event_indexes: output.indexes, block: number, at: head.timestamp });
      }
    }
    store.state.cursor = to;
    store.save();
  } catch (error) {
    store.state = before;
    throw error;
  }
}
