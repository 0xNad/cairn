// ERC-20 Transfer and Approval events, decoded by their shape alone (ARCHITECTURE.md, "Event layouts").
// Round 1's /tx lists a receipt's registry-token moves with it; round 2's scanner reuses it chain-wide.
import { toBig, u256 } from "./felt.mjs";
import { SEL } from "./selectors.mjs";

/**
 * { kind: "transfer" | "approval", token, from, to, amount } for an ERC-20 event, where `from`/`to` are the
 * owner and spender of an approval; null for anything else. Modern layout: keys [sel, a, b], data
 * [low, high]. Legacy layout: keys [sel], data [a, b, low, high] (also an NFT's shape: its contract decides).
 */
export function decodeTokenEvent(e) {
  try {
    const keys = e.keys.map(toBig), data = e.data.map(toBig);
    const kind = keys[0] === SEL.Transfer ? "transfer" : keys[0] === SEL.Approval ? "approval" : null;
    if (!kind) return null;
    const token = toBig(e.from_address);
    if (keys.length === 3 && data.length === 2) return { kind, token, from: keys[1], to: keys[2], amount: u256(data[0], data[1]), layout: "modern" };
    if (keys.length === 1 && data.length === 4) return { kind, token, from: data[0], to: data[1], amount: u256(data[2], data[3]), layout: "legacy" };
  } catch {}
  return null;
}

/** An approval of at least 2^128 − 1 reads as unlimited. */
export const UNLIMITED = 2n ** 128n - 1n;

/**
 * Whether event `i` of `events` is the fee payment: the last event, a STRK Transfer from the sender to the
 * block's sequencer, of exactly the fee. Never shown as a transfer.
 */
export function isFeePayment(events, i, { strk, sequencer, fee }) {
  if (i !== events.length - 1) return false;
  const t = decodeTokenEvent(events[i]);
  return !!t && t.kind === "transfer" && t.token === strk && (sequencer === undefined || t.to === sequencer) && (fee === undefined || t.amount === fee);
}
