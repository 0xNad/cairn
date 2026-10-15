// Refusing bad input with a reason, before any call about it.
import { escapeHtml } from "../format.mjs";

const clip = (s, n = 70) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Turns a parse result ({ value } or { problem }) from felt.mjs into { value } or { refusal: lines }.
 * `what` names the input ("address", "transaction hash"); `example` shows the command in use.
 */
export function refusal(parsed, given, { what, example }) {
  if (!parsed.problem) return { value: parsed.value };
  if (parsed.problem === "missing") return { refusal: [`Put the ${what} after the command, for example: ${escapeHtml(example)}`] };
  return {
    refusal: [
      `<code>${escapeHtml(clip(given))}</code> is not a valid Starknet ${what}: ${escapeHtml(parsed.problem)}.`,
      `The ${what} must be 0x followed by 1 to 64 hex digits, for example: ${escapeHtml(example)}`,
    ],
  };
}
