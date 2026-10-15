// Wording shared by the commands. Every outside string is escaped by the caller; everything here is ours.
import { esc } from "../format.mjs";

/** What a user sees when the node cannot answer after the retries. */
export const BUSY = "⏳ The Starknet node is busy or not answering right now. Please try again in a minute.";

/** A refusal of bad input: the reason (plain words from the validators), then how to call the command. */
export function refuse(reason, usage) {
  const sentence = reason.charAt(0).toUpperCase() + reason.slice(1);
  return `❌ ${esc(sentence)}.\nUsage: <code>${esc(usage)}</code>`;
}

/** A settled promise: { ok: true, value } or { ok: false, error }. Shutdown and exit errors still throw. */
export function settle(promise, rethrow) {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error) => {
      if (rethrow(error)) throw error;
      return { ok: false, error };
    },
  );
}
