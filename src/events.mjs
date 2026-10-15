// Decoding ERC-20 events by their shape (ARCHITECTURE.md, "Event layouts"). Round 1 reads the Transfer
// events of one receipt for /tx; round 2's chain-wide scanner decodes with the same function.
import { toBig, u256 } from "./felt.mjs";
import { SELECTOR } from "./starknet.mjs";

// A Transfer as { token, from, to, amount }, or null when the event is not an ERC-20 Transfer:
//   modern: keys [sel, from, to], data [low, high]; legacy: keys [sel], data [from, to, low, high].
export function decodeTransfer(event) {
  const keys = (event?.keys ?? []).map(toBig), data = (event?.data ?? []).map(toBig);
  const token = toBig(event?.from_address);
  if (token === null || keys[0] !== SELECTOR.Transfer || [...keys, ...data].includes(null)) return null;
  if (keys.length === 3 && data.length === 2) return { token, from: keys[1], to: keys[2], amount: u256(data[0], data[1]) };
  if (keys.length === 1 && data.length === 4) return { token, from: data[0], to: data[1], amount: u256(data[2], data[3]) };
  return null;
}

// The token transfers of a receipt, without the fee payment: the fee is a Transfer of the fee token, the
// last event of the transaction, whose amount is the receipt's actual_fee.
export function transfersOf(receipt, feeToken) {
  const events = receipt?.events ?? [];
  const fee = toBig(receipt?.actual_fee?.amount);
  return events
    .map((e, i) => ({ t: decodeTransfer(e), last: i === events.length - 1 }))
    .filter(({ t, last }) => t && !(last && feeToken && t.token === feeToken.address && t.amount === fee))
    .map(({ t }) => t);
}
