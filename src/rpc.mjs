// Starknet JSON-RPC over HTTP: one call per request, at most CAIRN_RPC_RPS calls in any 1 s window, and up
// to 3 tries on HTTP 429, 5xx, a timeout or a dropped connection, waiting at least Retry-After between them.

/** The node answered with a JSON-RPC error: `code` is the spec's (20, 21, 29, 40…). Not retried. */
export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** The node could not answer after every try: callers reply "node busy". */
export class NodeUnavailable extends Error {}

const TRIES = 3;
const BACKOFF_MS = 300;

export const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});

/** At most `max` takes in any `windowMs`; takes are served in order. */
export function rateLimiter(max, windowMs = 1000) {
  const stamps = [];
  let queue = Promise.resolve();
  const slot = async () => {
    for (;;) {
      const now = Date.now();
      while (stamps.length && now - stamps[0] >= windowMs) stamps.shift();
      if (stamps.length < max) {
        stamps.push(now);
        return;
      }
      await sleep(stamps[0] + windowMs - now + 1);
    }
  };
  return { take: () => (queue = queue.then(slot)) };
}

/** Retry-After in milliseconds: seconds or an HTTP date; 0 when absent. */
function retryAfterMs(header) {
  if (!header) return 0;
  if (/^\d+$/.test(header.trim())) return Number(header) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? 0 : Math.max(0, at - Date.now());
}

/** A JSON-RPC client for `url` (a secret: it is never logged; `origin` is). */
export function rpcClient({ url, rps, timeoutMs, log }) {
  const limiter = rateLimiter(rps);
  let id = 0;

  /** One try: { result } or { retry: reason, waitMs }. Throws RpcError and NodeUnavailable (not retried). */
  async function attempt(method, params) {
    await limiter.take();
    const signal = AbortSignal.timeout(timeoutMs);
    let res, body;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal,
      });
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel().catch(() => {});
        return { retry: `HTTP ${res.status}`, waitMs: retryAfterMs(res.headers.get("retry-after")) };
      }
      body = await res.text();
    } catch (e) {
      return { retry: signal.aborted ? `no answer within ${timeoutMs} ms` : `connection failed (${e.cause?.code ?? e.name})` };
    }
    if (!res.ok) throw new NodeUnavailable(`the node answered HTTP ${res.status}`);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      return { retry: "an answer that is not JSON" };
    }
    if (msg?.error) throw new RpcError(Number(msg.error.code), String(msg.error.message ?? "error"), msg.error.data);
    if (!msg || !("result" in msg)) return { retry: "an answer with no result" };
    return { result: msg.result };
  }

  return {
    /** Calls `method` with named `params`; returns its result. Throws RpcError or NodeUnavailable. */
    async call(method, params = {}) {
      let last;
      for (let i = 0; i < TRIES; i++) {
        if (i) await sleep(Math.max(last.waitMs ?? 0, BACKOFF_MS * 2 ** (i - 1)));
        const started = Date.now();
        const r = await attempt(method, params);
        if (!r.retry) {
          log.debug("rpc", { method, ms: Date.now() - started });
          return r.result;
        }
        last = r;
        log.warn("rpc_retry", { method, try: i + 1, of: TRIES, reason: r.retry });
      }
      throw new NodeUnavailable(`${method}: ${last.retry} after ${TRIES} tries`);
    },
  };
}
