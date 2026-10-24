import { RpcError } from './errors.mjs';
import { unsigned } from './felt.mjs';
import { amount, escapeHtml, short } from './format.mjs';
import { STAGE } from './ledger.mjs';

export const TRACK_EXPIRY = 600; // seconds of chain time before an unknown hash is "not found"
const REASON_MAX = 1500;

/**
 * One step of a tracked transaction: posts once on L2 acceptance (execution status and fee), then once on L1
 * acceptance or on a revert with its reason, and "not found" after 600 s of chain time. Returns null (nothing
 * new) or { delivery, stage } where stage is the track's next stage, or "done" to drop it.
 */
export async function trackStep(track, { rpc, head, fmt }) {
  let status;
  try { status = await rpc.call('starknet_getTransactionStatus', { transaction_hash: track.hash }); }
  catch (error) {
    if (!(error instanceof RpcError && error.code === 29)) throw error;
    if (head.timestamp - track.since_time < TRACK_EXPIRY) return null;
    return { stage: 'done', delivery: delivery(track, STAGE.missing, head,
      `❔ <b>Not found</b> after 10 minutes: ${short(track.hash)}. Check the hash and the network; Cairn stopped tracking it.`) };
  }
  const finality = String(status?.finality_status ?? ''), execution = String(status?.execution_status ?? '');
  if (finality === 'REJECTED') {
    return { stage: 'done', delivery: delivery(track, STAGE.final, head, `⛔ <b>Rejected</b>: the sequencer did not include it.\n${fmt.tx(track.hash, 'View transaction')}`) };
  }
  const accepted = finality === 'ACCEPTED_ON_L2' || finality === 'ACCEPTED_ON_L1';
  if (track.stage === 0 && accepted) {
    let receipt;
    try { receipt = await rpc.call('starknet_getTransactionReceipt', { transaction_hash: track.hash }); }
    catch (error) {
      if (error instanceof RpcError && error.code === 29) return null; // accepted, receipt not served yet
      throw error;
    }
    const fee = receipt?.actual_fee?.unit === 'FRI' ? amount(unsigned(receipt.actual_fee.amount), 18, 'STRK')
      : receipt?.actual_fee?.unit === 'WEI' ? amount(unsigned(receipt.actual_fee.amount), 18, 'ETH') : 'not available';
    const where = `Fee: ${fee} · block ${Number.isSafeInteger(receipt?.block_number) ? receipt.block_number : 'pending'}\n${fmt.tx(track.hash, 'View transaction')}`;
    const run = escapeHtml(receipt?.execution_status ?? execution);
    if ((receipt?.execution_status ?? execution) === 'REVERTED') {
      const reason = String(receipt?.revert_reason ?? status?.failure_reason ?? 'not given');
      const cut = reason.length > REASON_MAX ? `${reason.slice(0, REASON_MAX)}… (full reason: /tx ${track.hash})` : reason;
      return { stage: 'done', delivery: delivery(track, STAGE.accepted, head,
        `⚠️ <b>Reverted on L2</b> · ${run}\n${where}\nRevert reason:\n${escapeHtml(cut)}`) };
    }
    if (finality === 'ACCEPTED_ON_L1') {
      return { stage: 'done', delivery: delivery(track, STAGE.accepted, head, `🏁 <b>Accepted on L2 and L1</b> · ${run}: final on Ethereum.\n${where}`) };
    }
    return { stage: 1, delivery: delivery(track, STAGE.accepted, head, `✅ <b>Accepted on L2</b> · ${run}\n${where}`) };
  }
  if (track.stage === 1 && finality === 'ACCEPTED_ON_L1') {
    return { stage: 'done', delivery: delivery(track, STAGE.final, head, `🏁 <b>Accepted on L1</b>: final on Ethereum.\n${fmt.tx(track.hash, 'View transaction')}`) };
  }
  return null;
}

const delivery = (track, eventIndex, head, body) => ({ chatId: track.chat_id, txHash: track.hash, eventIndex, kind: 'track', chainTime: head.timestamp, body });
