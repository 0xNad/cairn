// JSON-RPC over HTTP to the Starknet node (ARCHITECTURE.md, "RPC hygiene"): at most CAIRN_RPC_RPS calls
// in any 1 s window, retries counted; on HTTP 429, 5xx, a timeout or a dropped connection, up to 3 tries
// with backoff of at least Retry-After, then NodeUnavailable, which chat commands answer with "node busy".
import { NoAnswer, postJson, sleep } from "./http.mjs";

/** The node answered with a JSON-RPC error: `code` is the spec's (20 contract not found, 29 tx not found…). */
export class RpcError extends Error {
  constructor(code, message, data) {
    super(`RPC error ${code}: ${message}`);
    this.code = code;
    this.data = data;
  }
}

/** The node gave no usable answer after its tries. `reason` is safe to log: it never holds the URL. */
export class NodeUnavailable extends Error {
  constructor(reason) {
    super(`the node is unavailable: ${reason}`);
    this.reason = reason;
  }
}

const TRIES = 3;
const BACKOFF_MS = [500, 1500];
/** A Retry-After longer than this is not waited for inside a pass: the call fails with "node busy" at once. */
const MAX_WAIT_MS = 10_000;

/**
 * A rate limiter: `acquire()` resolves once one more call fits in the last second's budget. Calls are
 * served in order, and the window is measured from each call's start.
 */
export function rateLimiter(perSecond, { now = Date.now, wait = sleep } = {}) {
  const starts = [];
  let queue = Promise.resolve();
  return (signal) => {
    const turn = queue.then(async () => {
      for (;;) {
        const t = now();
        while (starts.length && starts[0] <= t - 1000) starts.shift();
        if (starts.length < perSecond) return void starts.push(t);
        await wait(starts[0] + 1000 - t + 5, signal);
      }
    });
    queue = turn.catch(() => {});
    return turn;
  };
}

export function createRpc({ url, headers = {}, rps, timeoutMs, log, signal }) {
  const acquire = rateLimiter(rps);
  let id = 0;

  /** One HTTP request for one call: { result }, { error }, or { retry, after } for a transient failure. */
  async function attempt(method, params) {
    let res;
    try {
      res = await postJson(url, { jsonrpc: "2.0", id: ++id, method, params }, { headers, timeoutMs, signal });
    } catch (e) {
      if (e instanceof NoAnswer) return { retry: e.message };
      throw e;
    }
    if (res.status === 429 || res.status >= 500) return { retry: `HTTP ${res.status}`, after: retryAfter(res.headers.get("retry-after")) };
    if (res.status !== 200) return { fatal: `HTTP ${res.status}` };
    let msg;
    try {
      msg = JSON.parse(res.text);
    } catch {
      return { retry: "an answer that is not JSON" };
    }
    if (msg?.error) return { error: new RpcError(msg.error.code, String(msg.error.message ?? ""), msg.error.data) };
    if (!msg || !("result" in msg)) return { retry: "an answer with no result" };
    return { result: msg.result };
  }

  return {
    origin: new URL(url).origin,
    /**
     * Calls `method` with named `params`. Resolves its result; rejects with RpcError (an answer), with
     * NodeUnavailable (no answer after `tries`), or with the shutdown's abort.
     */
    async call(method, params = {}, { tries = TRIES } = {}) {
      let why = "no answer";
      for (let n = 1; n <= tries; n++) {
        await acquire(signal);
        const r = await attempt(method, params);
        if ("result" in r) return r.result;
        if (r.error) throw r.error;
        if (r.fatal) {
          log.warn("rpc_refused", { method, reason: r.fatal });
          throw new NodeUnavailable(r.fatal);
        }
        why = r.retry;
        if (n === tries) break;
        const wait = Math.max(BACKOFF_MS[n - 1] ?? BACKOFF_MS.at(-1), r.after ?? 0);
        if (wait > MAX_WAIT_MS) break;
        log.debug("rpc_retry", { method, try: n, reason: why, wait_ms: wait });
        await sleep(wait, signal);
      }
      throw new NodeUnavailable(why);
    },
  };
}

/** Retry-After in milliseconds, as seconds or as an HTTP date; undefined when absent or unreadable. */
function retryAfter(h) {
  if (!h) return undefined;
  if (/^\d+$/.test(h.trim())) return Number(h.trim()) * 1000;
  const at = Date.parse(h);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}
