// Starknet JSON-RPC over HTTP: at most CAIRN_RPC_RPS calls in any second, a timeout per call, and up to
// 3 tries on HTTP 429, 5xx, timeouts, dropped connections and garbage, waiting at least Retry-After.
// A JSON-RPC error is the node's answer and is never retried: it is thrown as RpcError for the caller.
// Reads are idempotent, so retrying them is always safe.
import { log, reasonOf } from "./log.mjs";
import { backoff, retryAfterMs, sleep } from "./wait.mjs";

const TRIES = 3;
// A Retry-After longer than this is not waited for: the lookup is answered "node busy" instead.
const MAX_RETRY_AFTER_MS = 10_000;

// The node answered with a JSON-RPC error; `code` is the spec's (20 contract not found, 29 tx not found…).
export class RpcError extends Error {
  constructor(code, message, data) {
    super(`JSON-RPC error ${code}: ${message}`);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

// The node could not answer: busy, down or misconfigured. `reason` is for the operator's log.
export class NodeUnavailable extends Error {
  constructor(reason) {
    super(`the Starknet node is unavailable: ${reason}`);
    this.name = "NodeUnavailable";
    this.reason = reason;
  }
}

// One try that may succeed if made again.
class Transient extends Error {
  constructor(reason, waitMs = 0) {
    super(reason);
    this.waitMs = waitMs;
  }
}

// At most `limit` calls in any window of `windowMs`; callers get their slots in the order they asked.
export class RateLimiter {
  constructor(limit, windowMs = 1000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.sent = [];
    this.queue = Promise.resolve();
  }

  take(signal) {
    const turn = this.queue.then(() => this.#wait(signal));
    this.queue = turn.catch(() => {});
    return turn;
  }

  async #wait(signal) {
    for (;;) {
      const now = Date.now();
      while (this.sent.length && this.sent[0] <= now - this.windowMs) this.sent.shift();
      if (this.sent.length < this.limit) {
        this.sent.push(now);
        return;
      }
      await sleep(this.sent[0] + this.windowMs - now + 1, signal);
    }
  }
}

// A client for `url`. `stop` aborts everything in flight (SIGTERM).
export function rpcClient({ url, rps, timeoutMs, stop }) {
  // 50 ms of margin on the window, for the time a request takes to reach the node.
  const limiter = new RateLimiter(rps, 1050);
  let ids = 0;

  async function once(method, params) {
    await limiter.take(stop);
    const id = ++ids;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = stop ? AbortSignal.any([stop, timeout]) : timeout;
    const started = Date.now();
    let res, text;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal });
      text = await res.text();
    } catch (e) {
      if (stop?.aborted) throw stop.reason;
      throw new Transient(timeout.aborted ? `no answer within ${timeoutMs} ms` : `no connection (${reasonOf(e)})`);
    }
    log.debug("rpc_call", { method, status: res.status, ms: Date.now() - started });
    if (res.status === 429 || res.status >= 500) throw new Transient(`HTTP ${res.status}`, retryAfterMs(res.headers.get("retry-after")));
    let msg = null;
    try {
      msg = JSON.parse(text);
    } catch {}
    if (msg?.error && typeof msg.error === "object") throw new RpcError(Number(msg.error.code), String(msg.error.message ?? ""), msg.error.data);
    if (!res.ok) throw new NodeUnavailable(`HTTP ${res.status} (check STARKNET_RPC_URL)`);
    if (!msg || typeof msg !== "object" || !("result" in msg)) throw new Transient("the answer is not a JSON-RPC result");
    return msg.result;
  }

  // Calls `method` with named `params`; returns its result or throws RpcError or NodeUnavailable.
  // `tries` 1 makes a quick probe, for a node already known to be down.
  async function call(method, params = {}, { tries = TRIES } = {}) {
    for (let n = 1; ; n++) {
      try {
        return await once(method, params);
      } catch (e) {
        if (!(e instanceof Transient)) throw e;
        if (n >= tries) throw new NodeUnavailable(`${method}: ${e.message}, ${n} ${n === 1 ? "try" : "tries"}`);
        const wait = Math.max(backoff(n), e.waitMs);
        if (e.waitMs > MAX_RETRY_AFTER_MS) throw new NodeUnavailable(`${method}: ${e.message}, asked to wait ${Math.ceil(e.waitMs / 1000)} s`);
        log.warn("rpc_retry", { method, try: n, reason: e.message, wait_ms: wait });
        await sleep(wait, stop);
      }
    }
  }

  return { call };
}
