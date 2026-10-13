// Replies shared by the commands: refusals of bad input, "node busy", unknown commands.
import { escape } from "../format.mjs";

/**
 * Refuses input that is not `what` ("an address"), before any call about it: what was wrong, and `hint`
 * (HTML) on what would work.
 */
export function invalid(input, reason, what, hint) {
  if (input === undefined) return [`Send ${what} after the command. ${hint}`];
  const shown = input.length > 70 ? `${input.slice(0, 70)}…` : input;
  return [`<code>${escape(shown)}</code> ${escape(reason)}.`, hint];
}

/** The node gave no answer after its retries. */
export const nodeBusy = () => ["⏳ The Starknet node is busy: it did not answer after 3 tries. Try again in a minute."];

export const unknown = (name) => [`Cairn has no /${escape(name)} command. Send /help for the list.`];
