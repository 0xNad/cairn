// Tracked transactions (/track): one post when Starknet accepts the transaction (L2), with its execution status
// and fee, then one when Ethereum does (L1) or, instead, when it reverts, with its reason. A transaction already
// that far gets one post saying so. A hash the node does not know 600 s of chain time after /track gets one
// "not found" post. Each post is recorded in the ledger, keyed by chat, hash and stage (in place of an
// event_index), in the same step as the track's progress, so it is posted exactly once.
import { tidy } from './chats.mjs';
import { RpcError } from './errors.mjs';
import { escapeHtml, feeText } from './format.mjs';
import { record } from './ledger.mjs';

export const EXPIRY = 600; // seconds of chain time
const REASON = 1000; // characters of a revert reason shown

/** Checks every chat's tracks against the node and records the posts due. Throws when the node fails. */
export async function followTracks(state, { rpc, head, link, clean }) {
  for (const [id, chat] of Object.entries(state.chats)) {
    for (const track of [...chat.tracks]) {
      const post = await progress(track, { rpc, head, link, clean });
      if (!post) continue;
      record(state, { chat: id, tx: track.hash, indexes: [post.stage], at: head.timestamp, text: post.text });
      if (post.final) chat.tracks.splice(chat.tracks.indexOf(track), 1);
      else track.stage = post.stage;
    }
    tidy(state, id);
  }
}

/** The post a track is due now, { stage, final, text }, or null. */
async function progress(track, { rpc, head, link, clean }) {
  const tx = `tx ${link('tx', track.hash)}`;
  let status;
  try { status = await rpc.call('starknet_getTransactionStatus', { transaction_hash: track.hash }); }
  catch (error) {
    if (!(error instanceof RpcError && error.code === 29)) throw error;
    if (head.timestamp - track.at < EXPIRY) return null;
    return { stage: 'unknown', final: true, text: `❔ Transaction not found within 10 minutes of chain time: tracking stopped.\n${tx}` };
  }
  const onL1 = status?.finality_status === 'ACCEPTED_ON_L1';
  if (!onL1 && status?.finality_status !== 'ACCEPTED_ON_L2') return null; // received, candidate or pre-confirmed: not yet
  if (track.stage === 'l2') return onL1 ? { stage: 'l1', final: true, text: `🏁 Accepted on L1: final.\n${tx}` } : null;
  const receipt = await rpc.call('starknet_getTransactionReceipt', { transaction_hash: track.hash });
  const execution = String(status.execution_status ?? receipt?.execution_status ?? 'unknown');
  const facts = `fee ${feeText(receipt?.actual_fee)}${Number.isSafeInteger(receipt?.block_number) ? ` · block ${receipt.block_number}` : ''}`;
  if (execution === 'REVERTED') {
    const reason = [...clean(String(status.failure_reason ?? receipt?.revert_reason ?? 'none given'))];
    const shown = reason.length > REASON ? `${reason.slice(0, REASON).join('')}…` : reason.join('');
    return { stage: 'reverted', final: true, text: `❌ Reverted · accepted on ${onL1 ? 'L1' : 'L2'} · ${facts}\nRevert reason: ${escapeHtml(shown)}\n${tx}` };
  }
  if (onL1) return { stage: 'l1', final: true, text: `🏁 Accepted on L2 and L1: final · ${escapeHtml(execution)} · ${facts}\n${tx}` };
  return { stage: 'l2', final: false, text: `✅ Accepted on L2 · ${escapeHtml(execution)} · ${facts}\nNext: one post when it is accepted on L1.\n${tx}` };
}
