import { amount, escapeHtml, textLines } from './format.mjs';
import { unsigned } from './felt.mjs';
import { RpcError, log } from './errors.mjs';
import { enqueue } from './ledger.mjs';

export async function trackTransactions(context) {
  const { store, head, rpc, clean, signal } = context;
  if (!head) return;
  for (const id of Object.keys(store.state.chats)) {
    const hashes = store.state.chats[id].tracks.map(t => t.hash);
    for (const hash of hashes) {
      const before = structuredClone(store.state);
      const chat = store.state.chats[id], track = chat.tracks.find(t => t.hash === hash);
      const link = `<a href="${escapeHtml(clean(`${context.config.explorer}/tx/${hash}`))}">View transaction</a>`;
      try {
        const status = await rpc.call('starknet_getTransactionStatus', { transaction_hash: hash });
        let receipt;
        const finality = status.finality_status;
        const accepted = ['ACCEPTED_ON_L2', 'ACCEPTED_ON_L1'].includes(finality);
        const failed = status.execution_status === 'REVERTED' || finality === 'REJECTED';
        if (accepted || failed) {
          try { receipt = await rpc.call('starknet_getTransactionReceipt', { transaction_hash: hash }); }
          catch (error) {
            if (!(error instanceof RpcError && error.code === 29 && failed && !accepted)) throw error;
          }
        }
        if (accepted && !track.l2) {
          const fee = receipt?.actual_fee;
          const feeText = ['FRI', 'WEI'].includes(fee?.unit) ?
            amount(unsigned(fee.amount), 18, fee.unit === 'FRI' ? 'STRK' : 'ETH') : 'not yet available';
          enqueue(chat, `track:${hash}:l2`, [...textLines(`L2 accepted · ${receipt?.execution_status ?? status.execution_status ?? 'unknown execution'}\nFee: ${feeText}`, clean), link], { hash, stage: 'l2', at: head.timestamp });
          track.l2 = true;
        }
        if (failed || receipt?.execution_status === 'REVERTED') {
          enqueue(chat, `track:${hash}:failed`, [...textLines(`Transaction reverted / failed\n${receipt?.revert_reason ?? status.failure_reason ?? 'Reason unavailable.'}`, clean), link], { hash, stage: 'failed', at: head.timestamp });
          chat.tracks = chat.tracks.filter(t => t !== track);
        } else if (finality === 'ACCEPTED_ON_L1') {
          enqueue(chat, `track:${hash}:l1`, ['L1 accepted · transaction final', link], { hash, stage: 'l1', at: head.timestamp });
          chat.tracks = chat.tracks.filter(t => t !== track);
        }
        store.save();
      } catch (error) {
        store.state = before;
        if (signal.aborted) throw error;
        const current = store.state.chats[id];
        if (error instanceof RpcError && error.code === 29 && head.timestamp - track.since_time >= 600) {
          enqueue(current, `track:${hash}:missing`, ['Transaction not found after 600 seconds of chain time.', link], { hash, stage: 'missing', at: head.timestamp });
          current.tracks = current.tracks.filter(t => t.hash !== hash);
          store.save();
        } else if (!(error instanceof RpcError && error.code === 29)) {
          log('warn', 'Transaction tracking deferred; node response unavailable.');
        }
      }
    }
  }
}
