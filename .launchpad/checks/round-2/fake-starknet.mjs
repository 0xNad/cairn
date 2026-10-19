// A fake Starknet JSON-RPC 0.10 node for round 2's checks: node:http on 127.0.0.1:0, one POST route at any
// path (so the checks can put a secret marker in the URL), single and batch requests, named or positional
// parameters, spec error codes. It serves every method ARCHITECTURE.md lists for rounds 1 to 4 with plausible
// answers, refuses the `pending` and `pre_confirmed` block ids with -32602, records every request and every
// call, flags any starknet_add* call, and injects HTTP 429/503, delays, garbage, dropped connections and
// outages on demand. Node built-ins only.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

export const P = 2n ** 251n + 17n * 2n ** 192n + 1n;
const MASK128 = 2n ** 128n - 1n;

/** The selectors ARCHITECTURE.md lists (sn_keccak of the names). */
export const SEL = {
  Transfer: 0x0099cd8bde557814842a3121e8ddfd433a539b8c9f14bf31ebf108d12e6196e9n,
  Approval: 0x0134692b230b9e1ffa39098904722134159652b09c5bc41d88d6698779d228ffn,
  balance_of: 0x035a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33n,
  balanceOf: 0x02e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76en,
  decimals: 0x004c4fb1ab068f6039d5780c68dd0fa2f8742cceb3426d19667778ca7f3518a9n,
  symbol: 0x0216b05c387bab9ac31918a3e61672f4618601f3c598a2f3f2710f37053e1ea4n,
  total_supply: 0x01557182e4359a1f0c6301278e8f5b35a776ab58d39892581e357578fb287836n,
  totalSupply: 0x0080aa9fdbfaf9615e4afc7f5f722e265daca5ccc655360fa5ccacf9c267936dn,
};

/** A felt as the node writes it: 0x and lowercase hex without leading zeros. */
export const felt = (v) => `0x${BigInt(v).toString(16)}`;
/** A felt as 0x and 64 lowercase hex digits. */
export const hex64 = (v) => `0x${BigInt(v).toString(16).padStart(64, "0")}`;
/** A u256 as Cairo returns it: [low, high]. */
export const u256 = (v) => [BigInt(v) & MASK128, BigInt(v) >> 128n];
/** A Cairo short string (at most 31 ASCII characters) as a felt. */
export const shortString = (s) => BigInt(`0x${Buffer.from(s, "latin1").toString("hex") || "0"}`);
/** A deterministic felt below 2^248 from a name: fixture addresses and hashes. */
export const feltOf = (name) => BigInt(`0x00${createHash("sha256").update(name).digest("hex").slice(2)}`);

/** A JSON-RPC error with a spec code, thrown by call handlers and by the node. */
export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}
export const ERR = {
  contractNotFound: () => new RpcError(20, "Contract not found"),
  entrypointNotFound: () => new RpcError(21, "Requested entrypoint does not exist in the contract"),
  blockNotFound: () => new RpcError(24, "Block not found"),
  txNotFound: () => new RpcError(29, "Transaction hash not found"),
  pageTooBig: () => new RpcError(31, "Requested page size is too big"),
  badToken: () => new RpcError(33, "The supplied continuation token is invalid or unknown"),
  tooManyKeys: () => new RpcError(34, "Too many keys provided in a filter"),
  contractError: (why = "Execution failed") => new RpcError(40, "Contract error", { revert_error: why }),
  params: (why) => new RpcError(-32602, `Invalid params: ${why}`),
};

// Positional parameter names, in order, for every method the node serves.
const PARAMS = {
  starknet_specVersion: [], starknet_chainId: [], starknet_blockNumber: [], starknet_blockHashAndNumber: [], starknet_syncing: [],
  starknet_getBlockWithTxHashes: ["block_id"], starknet_getBlockWithTxs: ["block_id"], starknet_getBlockWithReceipts: ["block_id"],
  starknet_getStateUpdate: ["block_id"], starknet_getBlockTransactionCount: ["block_id"],
  starknet_call: ["request", "block_id"], starknet_getClassHashAt: ["block_id", "contract_address"],
  starknet_getClassAt: ["block_id", "contract_address"], starknet_getClass: ["block_id", "class_hash"],
  starknet_getNonce: ["block_id", "contract_address"], starknet_getStorageAt: ["contract_address", "key", "block_id"],
  starknet_getTransactionStatus: ["transaction_hash"], starknet_getTransactionReceipt: ["transaction_hash"],
  starknet_getTransactionByHash: ["transaction_hash"], starknet_getTransactionByBlockIdAndIndex: ["block_id", "index"],
  starknet_getEvents: ["filter"],
};
export const METHODS = Object.keys(PARAMS);

const big = (v, what) => {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
    if (typeof v === "string" && /^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(v)) return BigInt(v);
  } catch {}
  throw ERR.params(`${what} is not a felt: ${JSON.stringify(v)?.slice(0, 80)}`);
};

/**
 * A fake node. `chainId` is the hex chain id, `spec` the spec version; the chain starts with blocks
 * `first`..`head`, the first at `t0` (seconds) and one every 2 s, each with `gas` (FRI and WEI prices).
 */
export function fakeStarknet({ chainId = "0x534e5f4d41494e", spec = "0.10.3", first = 4_200_000, head = 4_200_010,
  t0 = Math.floor(Date.parse("2026-10-20T00:00:00Z") / 1000), gas } = {}) {
  const requests = [], calls = [], violations = [], rules = [], contracts = new Map(), txs = new Map(), blocks = [];
  let server = null, url = null, downUntil = 0, sockets = new Set();
  const g = gas ?? { l1: [41_234_567_890_123n, 9_876_543_210n], l1Data: [987_654n, 321n], l2: [12_000_000_001n, 4_000_000n] };
  const sequencer = feltOf("sequencer");
  const addBlock = () => {
    const n = blocks.length ? blocks.at(-1).number + 1 : first;
    blocks.push({ number: n, hash: feltOf(`block ${n}`), parent: blocks.length ? blocks.at(-1).hash : feltOf("genesis"), timestamp: t0 + 2 * (n - first), txs: [] });
  };
  for (let n = first; n <= head; n++) addBlock();

  const header = (b) => ({
    status: "ACCEPTED_ON_L2", block_hash: felt(b.hash), parent_hash: felt(b.parent), block_number: b.number,
    new_root: felt(feltOf(`root ${b.number}`)), timestamp: b.timestamp, sequencer_address: felt(sequencer),
    l1_gas_price: { price_in_fri: felt(g.l1[0]), price_in_wei: felt(g.l1[1]) },
    l1_data_gas_price: { price_in_fri: felt(g.l1Data[0]), price_in_wei: felt(g.l1Data[1]) },
    l2_gas_price: { price_in_fri: felt(g.l2[0]), price_in_wei: felt(g.l2[1]) },
    l1_da_mode: "BLOB", starknet_version: "0.14.4",
  });
  /** The block a block id names: "latest", {block_number}, {block_hash}; refuses pending and pre_confirmed. */
  const blockOf = (id, method) => {
    if (id === "pending" || id === "pre_confirmed") {
      violations.push(`${method} used the block id ${JSON.stringify(id)}`);
      throw ERR.params(`block id ${JSON.stringify(id)} is not allowed`);
    }
    if (id === "latest" || id === "l1_accepted") return blocks.at(-1);
    if (id && typeof id === "object" && !Array.isArray(id)) {
      if ("block_number" in id) {
        const b = blocks.find((x) => BigInt(x.number) === big(id.block_number, "block_number"));
        if (!b) throw ERR.blockNotFound();
        return b;
      }
      if ("block_hash" in id) {
        const b = blocks.find((x) => x.hash === big(id.block_hash, "block_hash"));
        if (!b) throw ERR.blockNotFound();
        return b;
      }
    }
    throw ERR.params(`bad block id ${JSON.stringify(id)?.slice(0, 80)}`);
  };
  const contractAt = (address) => contracts.get(big(address, "contract_address"));
  const txOf = (hash) => {
    const t = txs.get(big(hash, "transaction_hash"));
    if (!t) throw ERR.txNotFound();
    return t;
  };
  const receipt = (t) => ({
    type: "INVOKE", transaction_hash: felt(t.hash), actual_fee: { amount: felt(t.fee), unit: "FRI" },
    execution_status: t.execution, finality_status: t.finality, block_hash: felt(blocks.find((b) => b.number === t.block)?.hash ?? 0n),
    block_number: t.block, messages_sent: [], events: t.events ?? [],
    execution_resources: { l1_gas: 0, l1_data_gas: 192, l2_gas: 1_200_000 },
    ...(t.execution === "REVERTED" ? { revert_reason: t.revert } : {}),
  });
  const txObject = (t) => ({
    transaction_hash: felt(t.hash), type: "INVOKE", version: "0x3", sender_address: felt(t.sender ?? feltOf("sender")),
    calldata: [], signature: [], nonce: "0x1", resource_bounds: { l1_gas: { max_amount: "0x0", max_price_per_unit: "0x0" }, l1_data_gas: { max_amount: "0x0", max_price_per_unit: "0x0" }, l2_gas: { max_amount: "0x0", max_price_per_unit: "0x0" } },
    tip: "0x0", paymaster_data: [], account_deployment_data: [], nonce_data_availability_mode: "L1", fee_data_availability_mode: "L1",
  });

  const methods = {
    starknet_specVersion: () => spec,
    starknet_chainId: () => chainId,
    starknet_syncing: () => false,
    starknet_blockNumber: () => blocks.at(-1).number,
    starknet_blockHashAndNumber: () => ({ block_hash: felt(blocks.at(-1).hash), block_number: blocks.at(-1).number }),
    starknet_getBlockWithTxHashes: (p, m) => {
      const b = blockOf(p.block_id, m);
      return { ...header(b), transactions: b.txs.map((h) => felt(h)) };
    },
    starknet_getBlockWithTxs: (p, m) => {
      const b = blockOf(p.block_id, m);
      return { ...header(b), transactions: b.txs.map((h) => txObject(txs.get(h))) };
    },
    starknet_getBlockWithReceipts: (p, m) => {
      const b = blockOf(p.block_id, m);
      return { ...header(b), transactions: b.txs.map((h) => ({ transaction: txObject(txs.get(h)), receipt: receipt(txs.get(h)) })) };
    },
    starknet_getBlockTransactionCount: (p, m) => blockOf(p.block_id, m).txs.length,
    starknet_getStateUpdate: (p, m) => {
      const b = blockOf(p.block_id, m);
      return { block_hash: felt(b.hash), new_root: felt(feltOf(`root ${b.number}`)), old_root: felt(feltOf(`root ${b.number - 1}`)),
        state_diff: { storage_diffs: [], deprecated_declared_classes: [], declared_classes: [], deployed_contracts: [], replaced_classes: [], nonces: [] } };
    },
    starknet_call: (p, m) => {
      const b = blockOf(p.block_id, m);
      const r = p.request ?? {};
      const c = contractAt(r.contract_address);
      if (!c) throw ERR.contractNotFound();
      const h = c.calls?.[felt(big(r.entry_point_selector, "entry_point_selector"))];
      if (!h) throw ERR.entrypointNotFound();
      const data = (Array.isArray(r.calldata) ? r.calldata : []).map((x) => big(x, "calldata"));
      return h(data, b).map((x) => felt(x));
    },
    starknet_getClassHashAt: (p, m) => {
      blockOf(p.block_id, m);
      const c = contractAt(p.contract_address);
      if (!c) throw ERR.contractNotFound();
      return felt(c.class_hash);
    },
    starknet_getClassAt: (p, m) => {
      blockOf(p.block_id, m);
      if (!contractAt(p.contract_address)) throw ERR.contractNotFound();
      return { sierra_program: ["0x1"], contract_class_version: "0.1.0", entry_points_by_type: { CONSTRUCTOR: [], EXTERNAL: [], L1_HANDLER: [] }, abi: "[]" };
    },
    starknet_getClass: (p, m) => {
      blockOf(p.block_id, m);
      return { sierra_program: ["0x1"], contract_class_version: "0.1.0", entry_points_by_type: { CONSTRUCTOR: [], EXTERNAL: [], L1_HANDLER: [] }, abi: "[]" };
    },
    starknet_getNonce: (p, m) => {
      blockOf(p.block_id, m);
      if (!contractAt(p.contract_address)) throw ERR.contractNotFound();
      return "0x1";
    },
    starknet_getStorageAt: (p, m) => {
      blockOf(p.block_id, m);
      if (!contractAt(p.contract_address)) throw ERR.contractNotFound();
      return "0x0";
    },
    starknet_getTransactionStatus: (p) => {
      const t = txOf(p.transaction_hash);
      return { finality_status: t.finality, execution_status: t.execution, ...(t.execution === "REVERTED" ? { failure_reason: t.revert } : {}) };
    },
    starknet_getTransactionReceipt: (p) => receipt(txOf(p.transaction_hash)),
    starknet_getTransactionByHash: (p) => txObject(txOf(p.transaction_hash)),
    starknet_getTransactionByBlockIdAndIndex: (p, m) => {
      const b = blockOf(p.block_id, m);
      const h = b.txs[Number(p.index)];
      if (h === undefined) throw new RpcError(27, "Invalid transaction index in a block");
      return txObject(txs.get(h));
    },
    starknet_getEvents: (p, m) => {
      const f = p.filter ?? {};
      const size = Number(f.chunk_size);
      if (!Number.isInteger(size) || size < 1) throw ERR.params("chunk_size must be a positive integer");
      if (size > 1024) throw ERR.pageTooBig();
      const from = f.from_block === undefined ? blocks[0].number : blockOf(f.from_block, m).number;
      const to = f.to_block === undefined ? blocks.at(-1).number : blockOf(f.to_block, m).number;
      const keys = Array.isArray(f.keys) ? f.keys : [];
      if (keys.length > 16) throw ERR.tooManyKeys();
      const all = [];
      for (const b of blocks) {
        if (b.number < from || b.number > to) continue;
        for (const h of b.txs) {
          (txs.get(h).events ?? []).forEach((e, i) => {
            if (f.address !== undefined && big(e.from_address, "address") !== big(f.address, "address")) return;
            const ok = keys.every((alts, k) => !Array.isArray(alts) || alts.length === 0 || (e.keys[k] !== undefined && alts.some((a) => big(a, "key") === big(e.keys[k], "key"))));
            if (ok) all.push({ ...e, block_number: b.number, block_hash: felt(b.hash), transaction_hash: felt(h), transaction_index: b.txs.indexOf(h), event_index: i });
          });
        }
      }
      let start = 0;
      if (f.continuation_token !== undefined) {
        const t = /^ct-(\d+)$/.exec(String(f.continuation_token));
        if (!t || Number(t[1]) > all.length) throw ERR.badToken();
        start = Number(t[1]);
      }
      const page = Math.min(size, 5); // at most 5 per page, whatever is asked: every entry must page
      const events = all.slice(start, start + page);
      return { events, ...(start + page < all.length ? { continuation_token: `ct-${start + page}` } : {}) };
    },
  };

  const answer = (m, req) => {
    const id = m && typeof m === "object" && "id" in m ? m.id : null;
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string") return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
    let params = m.params ?? {};
    const names = PARAMS[m.method];
    if (Array.isArray(params) && names) params = Object.fromEntries(names.map((n, i) => [n, params[i]]));
    const call = { method: m.method, params, at: req.at, path: req.path };
    calls.push(call);
    if (m.method.startsWith("starknet_add")) {
      violations.push(`called the write method ${m.method}`);
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    }
    const h = methods[m.method];
    if (!h) return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
    try {
      return { jsonrpc: "2.0", id, result: h(params, m.method) };
    } catch (e) {
      call.error = e instanceof RpcError ? e.code : -32603;
      if (e instanceof RpcError) return { jsonrpc: "2.0", id, error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } };
      return { jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } };
    }
  };

  function handle(req, res) {
    const arrived = Date.now(); // when the request arrived: what the rate limit is measured on
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const u = new URL(req.url, "http://fake");
      const r = { method: req.method, path: u.pathname, query: u.search, url: req.url, headers: req.headers, body: raw, at: arrived, calls: [] };
      requests.push(r);
      const send = (code, body, headers = {}) => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(code, { "content-type": "application/json", ...headers });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      };
      if (req.method !== "POST") return send(405, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "POST only" } });
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return send(200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
      const list = Array.isArray(msg) ? msg : [msg];
      r.calls = list.map((m) => ({ method: m?.method, params: normParams(m) }));
      const rule = rules.find((x) => x.times > 0 && list.some((m) => m && x.when({ method: m.method, params: normParams(m), path: r.path })));
      if (rule) {
        rule.times--;
        r.injected = rule.label;
        if (rule.delayMs) await new Promise((ok) => setTimeout(ok, rule.delayMs));
        if (rule.drop || rule.garbage || rule.http) {
          // The calls are recorded as made, with no answer: they count toward the rate limit.
          for (const m of list) calls.push({ method: m?.method, params: normParams(m), at: r.at, path: r.path, injected: rule.label });
        }
        if (rule.rpcError) {
          for (const m of list) calls.push({ method: m.method, params: normParams(m), at: r.at, error: rule.rpcError.code });
          const errors = list.map(m => ({ jsonrpc: "2.0", id: m.id, error: rule.rpcError }));
          return send(200, Array.isArray(msg) ? errors : errors[0]);
        }
        if (rule.drop) return req.socket.destroy();
        if (rule.garbage) return send(200, "<html>bad gateway</html>", { "content-type": "text/html" });
        if (rule.http) return send(rule.http, rule.http === 429 ? "Too Many Requests" : "Service Unavailable", { "content-type": "text/plain", ...(rule.retryAfter !== undefined ? { "retry-after": String(rule.retryAfter) } : {}) });
      }
      const out = list.map((m) => answer(m, r));
      if (Array.isArray(msg) && msg.length === 0) return send(200, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      send(200, Array.isArray(msg) ? out : out[0]);
    });
  }
  const normParams = (m) => {
    let params = m?.params ?? {};
    const names = PARAMS[m?.method];
    if (Array.isArray(params) && names) params = Object.fromEntries(names.map((n, i) => [n, params[i]]));
    return params;
  };

  const node = {
    requests, calls, violations, blocks, sequencer,
    get url() { return url; },
    get port() { return url ? Number(new URL(url).port) : undefined; },
    get head() { return blocks.at(-1); },
    /** A contract: { class_hash, calls: { [selector felt]: (calldata bigints, block) => result felts } }. */
    contract(address, c) {
      contracts.set(BigInt(address), { class_hash: c.class_hash ?? feltOf(`class ${address}`), calls: Object.fromEntries(Object.entries(c.calls ?? {}).map(([k, v]) => [felt(BigInt(k)), v])) });
    },
    /** A transaction in block `block`: { hash, finality, execution, fee (FRI), revert, events }. */
    tx(t) {
      const b = blocks.find((x) => x.number === t.block);
      if (!b) throw new Error(`no block ${t.block} for the fixture transaction`);
      txs.set(BigInt(t.hash), { ...t, hash: BigInt(t.hash) });
      if (!b.txs.includes(BigInt(t.hash))) b.txs.push(BigInt(t.hash));
    },
    addBlock,
    /**
     * Fails the next `times` requests holding a call for which `when({method, params})` holds: `http` (429
     * with `retryAfter`, or 503), `delayMs` before answering normally, `garbage`, or `drop`.
     */
    fail(rule) {
      rules.push({ times: 1, label: rule.http ? `HTTP ${rule.http}` : rule.drop ? "dropped" : rule.garbage ? "garbage" : `delay ${rule.delayMs} ms`, ...rule });
    },
    clearFailures: () => rules.splice(0),
    /** Refuses every connection for `ms` (dropped as soon as accepted). */
    down(ms) {
      downUntil = Date.now() + ms;
      for (const s of sockets) s.destroy();
    },
    callsOf: (method) => calls.filter((c) => c.method === method),
    listen(path = "/") {
      server = createServer(handle);
      server.keepAliveTimeout = 2000;
      server.on("connection", (s) => {
        if (Date.now() < downUntil) return s.destroy();
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
      });
      return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
        url = `http://127.0.0.1:${server.address().port}${path}`;
        resolve(node);
      }));
    },
    close() {
      return new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
  return node;
}

/** An ERC-20 fixture: `balances` maps owner → amount; `layout` "modern" answers balance_of and balanceOf, "legacy" only balanceOf. */
export function erc20({ symbol, decimals, balances = new Map(), layout = "modern", failFor = new Map() }) {
  const balance = ([owner]) => {
    if (failFor.has(owner)) throw failFor.get(owner)();
    return u256(balances.get(owner) ?? 0n);
  };
  const calls = {
    [SEL.balanceOf]: balance,
    [SEL.decimals]: () => [BigInt(decimals)],
    [SEL.symbol]: () => [shortString(symbol)],
    [SEL.totalSupply]: () => u256(10n ** 30n),
  };
  if (layout === "modern") Object.assign(calls, { [SEL.balance_of]: balance, [SEL.total_supply]: () => u256(10n ** 30n) });
  return { calls };
}
