// One JSON POST, shared by the Telegram and Starknet clients. It never follows a redirect: Cairn contacts
// only the two hosts it is configured with. Errors say what happened without the URL, which holds secrets.
import { setTimeout as delay } from "node:timers/promises";

/** The longest timer Node keeps: longer ones fire at once. */
const MAX_TIMER = 2 ** 31 - 1;

/** A request that got no HTTP answer: `kind` is "timeout" or "network" (`code` is the socket error). */
export class NoAnswer extends Error {
  constructor(kind, code) {
    super(kind === "timeout" ? "no answer in time" : `connection failed${code ? ` (${code})` : ""}`);
    this.kind = kind;
    this.code = code;
  }
  /** Whether the request surely never reached the server, so sending it again cannot duplicate it. */
  get unsent() {
    return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"].includes(this.code);
  }
}

/** POSTs `body` as JSON; resolves { status, headers, text }, rejects with NoAnswer, or with the abort of `signal`. */
export async function postJson(url, body, { headers = {}, timeoutMs, signal } = {}) {
  const timeout = AbortSignal.timeout(Math.min(timeoutMs, MAX_TIMER));
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    if (timeout.aborted) throw new NoAnswer("timeout");
    throw new NoAnswer("network", e?.cause?.code ?? e?.code);
  }
}

/** Waits `ms`, or rejects at once with the abort of `signal`. */
export const sleep = (ms, signal) => delay(Math.min(Math.max(0, ms), MAX_TIMER), undefined, { signal });
