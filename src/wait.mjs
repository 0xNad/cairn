// Waiting: abortable sleeps, backoff and Retry-After. The wall clock is used here only (ARCHITECTURE.md:
// "the wall clock is used only for backoff, timeouts, logs").
import { setTimeout as delay } from "node:timers/promises";

// Sleeps `ms`, or rejects as soon as `signal` aborts.
export const sleep = (ms, signal) => delay(Math.max(0, ms), undefined, { signal });

// The pause before try `n + 1` (n from 1): 300 ms, 600 ms, 1.2 s… capped at 10 s.
export const backoff = (n) => Math.min(300 * 2 ** (n - 1), 10_000);

// Retry-After in milliseconds: delay-seconds or an HTTP date; 0 when absent or unreadable.
export function retryAfterMs(header, now = Date.now()) {
  if (header === null || header === undefined || header === "") return 0;
  const s = String(header).trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const at = Date.parse(s);
  return Number.isNaN(at) ? 0 : Math.max(0, at - now);
}
