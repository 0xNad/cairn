// Small helpers shared by every module: abortable sleeping, error classification, synchronous fd writes.
import { writeSync } from "node:fs";

/** The largest delay a timer accepts; anything longer fires at once. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** Resolves after `ms`, or rejects with the signal's reason as soon as `signal` aborts. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.min(Math.max(0, ms), MAX_TIMER_MS));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Whether `e` is what an aborted signal or request throws. */
export const isAbort = (e) => e?.name === "AbortError";

/** A short, secret-free description of a failed fetch: its system error code when it has one. */
export function errorCode(e) {
  return String(e?.cause?.code ?? e?.code ?? e?.name ?? "error").slice(0, 40);
}

/** Random milliseconds in [0, max): keeps retries of many callers from lining up. */
export const jitter = (max) => Math.floor(Math.random() * max);

/**
 * Writes `text` to a file descriptor and waits for the kernel to take it all, so that a process that exits
 * right after still has its output delivered. Pipes may answer EAGAIN: try again.
 */
export function writeFd(fd, text) {
  const buf = Buffer.from(text, "utf8");
  let done = 0;
  for (let tries = 0; done < buf.length && tries < 1000; ) {
    try {
      done += writeSync(fd, buf, done);
    } catch (e) {
      if (e.code === "EAGAIN") {
        tries++;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
        continue;
      }
      return; // a closed pipe (EPIPE) or anything else: there is nobody to tell
    }
  }
}
