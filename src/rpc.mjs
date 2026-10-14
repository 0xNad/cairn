// Starknet JSON-RPC over HTTP: a sliding-window rate limit, retries with backoff, and errors told apart.
// A node that cannot be reached or answers 429, 5xx or garbage is `NodeUnavailable`; a node that answers with
// a JSON-RPC error is `RpcError` (the code is the spec's: 20 contract not found, 21 entrypoint not found...).
// Only "latest", {block_number} and {block_hash} are ever sent as block ids; nothing here can write.
import { errorCode, isAbort, jitter, sleep } from "./util.mjs";

/** The node answered, and the answer is an error of the spec. */
export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

/** The node could not give an answer after every try: "node busy" to the user. */
export class NodeUnavailable extends Error {
  constructor(reason) {
    super(reason);
    this.name = "NodeUnavailable";
  }
}

const TRIES = 3;
const WINDOW_MS = 1000;
const BACKOFF_MS = 250;
const MAX_RETRY_AFTER_S = 30;
const MAX_BODY = 8_000_000;
/** Provider-specific "slow down" code seen in JSON-RPC errors. */
const RATE_LIMITED = -32005;

/** Seconds from a Retry-After header (a number of seconds or an HTTP date), or 0. */
function retryAfterSeconds(value) {
  if (!value) return 0;
  if (/^\d+$/.test(value.trim())) return Math.min(Number(value), MAX_RETRY_AFTER_S);
  const at = Date.parse(value);
  return Number.isNaN(at) ? 0 : Math.min(Math.max(0, Math.ceil((at - Date.now()) / 1000)), MAX_RETRY_AFTER_S);
}

export class Rpc {
  /**
   * @param {{ url: string, rps: number, timeoutMs: number, log: object, signal?: AbortSignal }} options
   *   `url` is a secret: it is never logged, only its origin.
   */
  constructor({ url, rps, timeoutMs, log, signal }) {
    const parsed = new URL(url);
    this.headers = { "content-type": "application/json", accept: "application/json" };
    if (parsed.username || parsed.password) {
      const user = decodeURIComponent(parsed.username);
      const pass = decodeURIComponent(parsed.password);
      this.headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
      parsed.username = "";
      parsed.password = "";
    }
    this.endpoint = parsed.href;
    this.origin = parsed.origin;
    this.rps = rps;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.signal = signal;
    this.nextId = 1;
    this.starts = []; // when the last calls began: the sliding window
  }

  /** Waits for a slot in the rate limit: never more than `rps` calls begin in any 1 s window. */
  async #slot() {
    for (;;) {
      const now = Date.now();
      while (this.starts.length && now - this.starts[0] >= WINDOW_MS) this.starts.shift();
      if (this.starts.length < this.rps) {
        this.starts.push(now);
        return;
      }
      await sleep(this.starts[0] + WINDOW_MS - now + 1, this.signal);
    }
  }

  /** One HTTP exchange. Returns { result } or throws RpcError; throws a `Transient` marker for the retry loop. */
  async #once(method, params) {
    await this.#slot();
    const id = this.nextId++;
    const signals = [AbortSignal.timeout(this.timeoutMs)];
    if (this.signal) signals.push(this.signal);
    let res;
    let text;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.any(signals),
      });
      text = await res.text();
    } catch (e) {
      if (this.signal?.aborted) throw this.signal.reason ?? e;
      throw transient(isAbort(e) || e?.name === "TimeoutError" ? "timeout" : errorCode(e));
    }
    if (res.status === 429 || res.status >= 500 || res.status === 408) {
      throw transient(`http ${res.status}`, retryAfterSeconds(res.headers.get("retry-after")));
    }
    if (res.status !== 200) throw fatal(`http ${res.status}`);
    if (text.length > MAX_BODY) throw transient("oversized answer");
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw transient("not json");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body) || body.jsonrpc !== "2.0") throw transient("not a json-rpc answer");
    if (body.error && typeof body.error === "object") {
      const { code, message, data } = body.error;
      if (code === RATE_LIMITED) throw transient("rate limited by the node");
      throw new RpcError(Number.isInteger(code) ? code : -32603, String(message ?? "error").slice(0, 300), data);
    }
    if (!("result" in body)) throw transient("no result");
    return body.result;
  }

  /**
   * Calls `method` with named `params`: up to 3 tries, backing off at least as long as Retry-After.
   * @throws {RpcError} the node's own error, never retried
   * @throws {NodeUnavailable} after the last try
   */
  async call(method, params = {}) {
    let reason = "error";
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      try {
        return await this.#once(method, params);
      } catch (e) {
        if (e instanceof RpcError) throw e;
        if (!e?.[TRANSIENT]) {
          if (e?.[FATAL]) throw new NodeUnavailable(e.message);
          throw e; // an abort (shutdown)
        }
        reason = e.message;
        this.log.debug("rpc_retry", { method, attempt, reason, node: this.origin });
        if (attempt === TRIES) break;
        const backoff = BACKOFF_MS * 2 ** (attempt - 1) + jitter(100);
        await sleep(Math.max(backoff, e.retryAfter * 1000), this.signal);
      }
    }
    this.log.warn("rpc_unavailable", { method, reason, node: this.origin });
    throw new NodeUnavailable(reason);
  }

  // Typed helpers: one per method Cairn uses, with the block ids Cairn allows.

  /** The latest block's header: number, hash, timestamp, sequencer and the three gas prices. */
  blockLatest() {
    return this.call("starknet_getBlockWithTxHashes", { block_id: "latest" });
  }

  /** `starknet_call` on the latest block; the answer is a list of felts (hex strings). */
  callContract(contractAddress, selector, calldata) {
    return this.call("starknet_call", {
      request: { contract_address: contractAddress, entry_point_selector: selector, calldata },
      block_id: "latest",
    });
  }

  classHashAt(address) {
    return this.call("starknet_getClassHashAt", { block_id: "latest", contract_address: address });
  }

  chainId() {
    return this.call("starknet_chainId", {});
  }

  specVersion() {
    return this.call("starknet_specVersion", {});
  }

  blockNumber() {
    return this.call("starknet_blockNumber", {});
  }

  transactionStatus(hash) {
    return this.call("starknet_getTransactionStatus", { transaction_hash: hash });
  }

  transactionReceipt(hash) {
    return this.call("starknet_getTransactionReceipt", { transaction_hash: hash });
  }
}

const TRANSIENT = Symbol("transient");
const FATAL = Symbol("fatal");
function transient(message, retryAfter = 0) {
  const e = new Error(message);
  e[TRANSIENT] = true;
  e.retryAfter = retryAfter;
  return e;
}
function fatal(message) {
  const e = new Error(message);
  e[FATAL] = true;
  return e;
}
