// .launchpad/checks/round-1/run.mjs: round 1's checks, "Lookups". Run them from the repository's root:
//   node .launchpad/checks/round-1/run.mjs
// Cairn runs only in child processes (`node cairn.mjs tick|run|doctor`), against a fake Telegram Bot API
// (fake-telegram.mjs) and a fake Starknet node (fake-starknet.mjs) that this check starts on 127.0.0.1, with
// the network trap (trap.mjs) loaded through NODE_OPTIONS. Every test builds its own "world": both fakes, a
// network file of fixture tokens, a fresh CAIRN_DATA under the kit's scratch directory and the environment.
// Fixture values (addresses, amounts, hashes, times) are made up: they only have to be valid.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, harness } from "./lib/harness.mjs";
import { ROOT, entry, input, workspace } from "./lib/entry.mjs";
import { fakeTelegram, linksOf } from "./fake-telegram.mjs";
import { ERR, P, SEL, erc20, feltOf, fakeStarknet, hex64 } from "./fake-starknet.mjs";

const { test, done } = harness();
const cairn = entry("node", ["cairn.mjs"]);
/** The checks stop starting runs after this, so that a hanging entry still gets a report within check.json's 300 s. */
const DEADLINE = Date.now() + 270_000;
const budget = (ms) => {
  const left = DEADLINE - Date.now();
  if (left < 1000) throw new Error("the checks ran out of time (270 s): earlier runs were too slow");
  return Math.min(ms, left);
};

// ---- fixtures ----------------------------------------------------------------------------------------

/**
 * A fake token of Telegram's shape (^\d+:[A-Za-z0-9_-]{30,}$); the part after the colon is the secret the
 * checks look for everywhere. It is not a real token, and its secret does not start with "AA" as real ones
 * do, so that secret scanners leave this public file alone.
 */
const TOKEN = "7700112233:check-TOKEN-MARKER-zz9Qx7Lw3Vb5Nt1Rp0";
const TOKEN_SECRET = TOKEN.slice(TOKEN.indexOf(":") + 1);
/** The RPC URL's secrets: a key in its path and one in its query, as providers do. */
const RPC_SECRET = "SECRET-RPC-KEY-7f3a";
const RPC_QUERY_SECRET = "QUERY-SECRET-2b9d";
const RPC_PATH = `/rpc/v0_10/${RPC_SECRET}?key=${RPC_QUERY_SECRET}`;
const ME = { id: 7700112233, is_bot: true, first_name: "Cairn Check", username: "cairn_check_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
const EXPLORER = "https://scan.cairn-check.example";
const TRAP = fileURLToPath(new URL("./trap.mjs", import.meta.url));
const T0 = Math.floor(Date.parse("2026-10-20T00:00:00Z") / 1000);
const HEAD = 4_200_010;
const SN_MAIN = "0x534e5f4d41494e", SN_SEPOLIA = "0x534e5f5345504f4c4941";

const token = (symbol, decimals, layout = "modern") => ({ symbol, decimals, layout, address: feltOf(`token ${symbol}`) });
/** The registry the checks give Cairn (CAIRN_NETWORK_FILE), in this order. */
const TOKENS = [token("STRK", 18), token("ETH", 18), token("USDC", 6), token("WBTC", 8, "legacy"), token("BIG", 18)];
const [STRK, ETH, USDC, WBTC, BIG] = TOKENS;
const RICH = feltOf("owner rich"); // 0x00…: has leading zeros to drop
const UNDEPLOYED = feltOf("owner undeployed");
const FAILING = feltOf("owner whose USDC call fails");
const E18 = 10n ** 18n;
const BALANCES = new Map([
  [RICH, [1234n * E18 + E18 / 2n, 1n, 1_000_000n, 2_100_000_001n, 2n ** 128n + 5n]],
  [UNDEPLOYED, [5n * E18, 0n, 0n, 0n, 0n]],
  [FAILING, [7n * E18, 0n, 0n, 3n * 10n ** 8n, 0n]],
]);
/** What /balance of RICH must show, in registry order. */
const RICH_SHOWS = [["1234.5", "STRK"], ["0.000000000000000001", "ETH"], ["1", "USDC"], ["21.00000001", "WBTC"], ["340282366920938463463.374607431768211461", "BIG"]];

const TX_OK = feltOf("tx ok"), TX_L1 = feltOf("tx accepted on l1"), TX_REV = feltOf("tx reverted"), TX_LONG = feltOf("tx long revert");
const TX_UNKNOWN = feltOf("tx nobody sent");
const REVERT = "Error in the called contract: 'u256_sub Overflow' <b>&lt;x&gt;</b> & <x> \"quoted\"";
const LONG_REVERT = Array.from({ length: 140 }, (_, i) => `#${i} contract ${hex64(feltOf(`c${i}`))} pc=0:${1000 + i}: assert(a < b) & <felt ${i}>`).join("\n");

/** Builds the fixture chain: the registry's contracts, the owners, the transactions. */
function chain(node) {
  TOKENS.forEach((t, i) => {
    const balances = new Map([...BALANCES].map(([owner, list]) => [owner, list[i]]));
    const failFor = t === USDC ? new Map([[FAILING, () => ERR.contractError("Failure reason: 0x753235365f737562204f766572666c6f77 ('u256_sub Overflow')")]]) : new Map();
    node.contract(t.address, erc20({ symbol: t.symbol, decimals: t.decimals, balances, layout: t.layout, failFor }));
  });
  for (const a of [RICH, FAILING]) node.contract(a, { class_hash: feltOf("account class"), calls: {} });
  node.tx({ hash: TX_OK, block: 4_200_007, finality: "ACCEPTED_ON_L2", execution: "SUCCEEDED", fee: 1_234_567_890_000_000_000n });
  node.tx({ hash: TX_L1, block: 4_200_003, finality: "ACCEPTED_ON_L1", execution: "SUCCEEDED", fee: 50_000_000_000_000_000n });
  node.tx({ hash: TX_REV, block: 4_200_009, finality: "ACCEPTED_ON_L2", execution: "REVERTED", fee: 2_000_000_000_000_000n, revert: REVERT });
  node.tx({ hash: TX_LONG, block: 4_200_009, finality: "ACCEPTED_ON_L2", execution: "REVERTED", fee: 3_000_000_000_000_000n, revert: LONG_REVERT });
}

/** A network file: the given tokens plus keys round 1 must ignore. */
const network = (tokens = TOKENS, chainName = "SN_MAIN") => ({
  chain: chainName,
  tokens: tokens.map((t) => ({ symbol: t.symbol, address: hex64(t.address), decimals: t.decimals, pragma_pair: `${t.symbol.toUpperCase().replace(/\W/g, "")}/USD` })),
  contracts: { pragma: hex64(feltOf("pragma")), naming: hex64(feltOf("naming")) },
  note: "keys other than chain and tokens are ignored in round 1",
});

// ---- worlds ------------------------------------------------------------------------------------------

const ws = workspace();
const TRAP_DIR = join(ws.scratch, "trap");
mkdirSync(TRAP_DIR);
chmodSync(TRAP_DIR, 0o1777);
const BEFORE = snapshot(); // what exists before Cairn ever runs: see "writes only inside CAIRN_DATA"
const worlds = [];
const live = new Set();
process.on("exit", () => {
  for (const pid of live) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }
});

/** The kit's clean environment, as entry() builds it. */
const cleanEnv = () => ({ PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: ws.home, TMPDIR: ws.scratch, LANG: "C.UTF-8", TZ: "UTC" });

/**
 * A world: a fake Telegram and a fake node on loopback, the fixture chain, a network file, a CAIRN_DATA that
 * does not exist yet, a trap log, and the environment pointing at all of them. Every run is recorded, so the
 * security tests can read every output, request and file a world saw.
 */
async function world({ chainId = SN_MAIN, spec = "0.10.3", me = ME, tgToken = TOKEN, env = {}, tokens = TOKENS, chainName = "SN_MAIN", head = HEAD, gas } = {}) {
  const n = worlds.length + 1;
  const tg = await fakeTelegram({ token: tgToken, me, t0: T0 }).listen();
  const node = fakeStarknet({ chainId, spec, head, t0: T0, gas });
  chain(node);
  await node.listen(RPC_PATH);
  const w = {
    n, tg, node, spec, me, head,
    data: join(ws.scratch, `data-${n}`),
    trapLog: join(TRAP_DIR, `trap-${n}.log`),
    runs: [],
  };
  w.env = {
    TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_API_ROOT: tg.url, STARKNET_RPC_URL: node.url, CAIRN_CHAIN: chainName,
    CAIRN_NETWORK_FILE: input(network(tokens, chainName), `network-${n}.json`), CAIRN_DATA: w.data, CAIRN_EXPLORER_URL: EXPLORER,
    CAIRN_POLL_MS: "100", CAIRN_TG_TIMEOUT: "1", CAIRN_RPC_RPS: "100", CAIRN_RPC_TIMEOUT_MS: "1500",
    NODE_OPTIONS: TRAP.includes(" ") ? `--import="${TRAP}"` : `--import=${TRAP}`, CAIRN_TRAP_LOG: w.trapLog, ...env,
  };
  /** `node cairn.mjs <args>` once, to its exit, recorded. `unset` lists variables to leave out. */
  w.cairn = async (args, { env: extra = {}, unset = [], timeoutMs = 20_000 } = {}) => {
    const e = { ...w.env, ...extra };
    for (const k of unset) delete e[k];
    const r = await cairn(args, { env: e, timeoutMs: budget(timeoutMs) });
    w.runs.push(r);
    return r;
  };
  /** A tick that must exit 0 and print its summary line: returns the summary. */
  w.tick = async (o = {}) => summary(await w.cairn(["tick"], o));
  w.close = () => Promise.all([tg.close(), node.close()]);
  worlds.push(w);
  return w;
}

/** Runs `fn(w)` in a new world and closes the fakes whatever happens. */
async function within(opts, fn) {
  const w = await world(opts);
  try {
    return await fn(w);
  } finally {
    await w.close();
  }
}

/** Starts `node cairn.mjs <args>` in its own process group (for run, and for kills mid-tick). */
function start(w, args, extra = {}) {
  budget(1000);
  const child = spawn(process.execPath, ["cairn.mjs", ...args], { cwd: ROOT, env: { ...cleanEnv(), ...w.env, ...extra }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  if (child.pid) live.add(child.pid);
  const rec = { cmd: `node cairn.mjs ${args.join(" ")}`, out: "", err: "", code: null, signal: null };
  w.runs.push(rec);
  child.stdout.on("data", (d) => (rec.out = (rec.out + d).slice(-1_000_000)));
  child.stderr.on("data", (d) => (rec.err = (rec.err + d).slice(-1_000_000)));
  const exited = new Promise((resolve) => child.on("close", (code, signal) => {
    rec.code = code;
    rec.signal = signal;
    live.delete(child.pid);
    resolve(rec);
  }));
  child.on("error", () => {});
  const kill = (sig = "SIGKILL") => {
    try {
      process.kill(-child.pid, sig);
    } catch {}
  };
  return { child, rec, exited, kill, running: () => rec.code === null && rec.signal === null };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Waits until `cond()` is truthy; throws `what` after `ms`. */
async function until(cond, ms, what) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const v = await cond();
    if (v) return v;
    await sleep(20);
  }
  throw new Error(what);
}

const show = (v, n = 300) => JSON.stringify(v)?.slice(0, n);
const why = (r) => `${r.cmd} exited with ${r.code ?? r.signal}${r.err?.trim() ? `: ${r.err.trim().slice(-400)}` : ""}`;

/** The one JSON line tick prints, checked: {"updates","sent","head"} at least. */
function summary(r) {
  check(r.code === 0, why(r));
  const lines = r.out.trim().split("\n");
  check(r.out.trim() !== "" && lines.length === 1, `tick should print exactly one line on stdout, printed ${show(r.out)}`);
  let s;
  try {
    s = JSON.parse(lines[0]);
  } catch {
    throw new Error(`tick's line is not JSON: ${show(lines[0])}`);
  }
  check(s && typeof s === "object" && !Array.isArray(s), `tick's line is not a JSON object: ${show(lines[0])}`);
  check(Number.isInteger(s.updates) && s.updates >= 0, `tick's "updates" should be a count: ${show(s)}`);
  check(Number.isInteger(s.sent) && s.sent >= 0, `tick's "sent" should be a count: ${show(s)}`);
  check(s.head === null || Number.isInteger(s.head), `tick's "head" should be a block number or null: ${show(s)}`);
  return s;
}

/** A refusal: exit code `code`, nothing on stdout, a reason on stderr. */
function refused(r, code, what) {
  check(r.code === code, `${what}: ${r.cmd} should exit ${code}, exited with ${r.code ?? r.signal}${r.err.trim() ? ` (stderr: ${r.err.trim().slice(0, 200)})` : ""}`);
  check(r.out === "", `${what}: printed something on stdout: ${show(r.out)}`);
  check(r.err.trim() !== "", `${what}: no reason on stderr`);
}

// ---- reading replies ---------------------------------------------------------------------------------

/** Text as the checks compare it: tags gone and entities decoded (the fake did that), white space collapsed, no commas inside numbers. */
const norm = (s) => String(s).replace(/[    ]/g, " ").replace(/\s+/g, " ").replace(/(\d),(?=\d)/g, "$1").trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether `text` shows `amount symbol` as a whole amount (not part of a longer number or symbol). */
const hasAmount = (text, amount, symbol) => new RegExp(`(^|[^0-9.])${esc(amount)} ${esc(symbol)}(?![A-Za-z0-9]|\\.[A-Za-z0-9])`).test(norm(text));
/** Every accepted message to a chat, joined. */
const textTo = (w, chat) => w.tg.to(chat.id).map((m) => m.text).join("\n");
const htmlTo = (w, chat) => w.tg.to(chat.id).map((m) => m.html).join("\n");
/** What a reply is, for order checks. */
function kind(w, text) {
  const t = norm(text);
  if (t.includes(w.spec) && t.includes(String(w.head))) return "status";
  if (hasAmount(t, "1234.5", "STRK")) return "balance";
  if (hasAmount(t, "1.23456789", "STRK")) return "tx";
  if (/\/help/.test(t)) return "hint";
  return "other";
}
const kinds = (w, chat) => w.tg.to(chat.id).map((m) => kind(w, m.text));
/** Waits for a new message to `chat` beyond the first `seen`. */
const reply = (w, chat, seen, ms, what) => until(() => w.tg.to(chat.id)[seen], ms, what);

const short = (v) => `${hex64(v).slice(0, 6)}…${hex64(v).slice(-4)}`;

let ids = 1000;
/** A user and their private chat. */
function dm(w, name = "Sam") {
  const u = w.tg.user(++ids, name);
  return { u, chat: w.tg.dm(u) };
}

// Calls about an input: what the RPC log says Cairn asked about an address or a hash.
const feltEq = (a, b) => {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
};
const isCall = (c, sel) => c.method === "starknet_call" && feltEq(c.params?.request?.entry_point_selector, sel);
const callOwner = (c) => c.params?.request?.calldata?.[0];
const callContract = (c) => c.params?.request?.contract_address;
const TX_METHODS = ["starknet_getTransactionStatus", "starknet_getTransactionReceipt", "starknet_getTransactionByHash"];
const aboutTx = (c, h) => TX_METHODS.includes(c.method) && feltEq(c.params?.transaction_hash, h);

// ---- the security record -----------------------------------------------------------------------------

/** The trap's lines for a world: { pid, kind, dest }. */
function trapOf(w) {
  if (!existsSync(w.trapLog)) return [];
  return readFileSync(w.trapLog, "utf8").split("\n").filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { kind: "unreadable", dest: l.slice(0, 100) };
    }
  });
}
/** What the trap saw beyond loading: connections and lookups. */
const contacts = (w) => trapOf(w).filter((t) => t.kind !== "loaded");
/** A world's counters, to tell whether a run contacted anything. */
const marks = (w) => ({ tg: w.tg.requests.length, rpc: w.node.requests.length, trap: contacts(w).length });
function contactedNothing(w, before, what) {
  const tg = w.tg.requests.slice(before.tg), rpc = w.node.requests.slice(before.rpc), trap = contacts(w).slice(before.trap);
  check(tg.length === 0, `${what}: called Telegram before exiting: ${show(tg.map((r) => r.url.replace(TOKEN, "<token>")))}`);
  check(rpc.length === 0, `${what}: called the node before exiting: ${show(rpc.map((r) => r.calls.map((c) => c.method)))}`);
  check(trap.length === 0, `${what}: opened connections or looked up hosts before exiting: ${show(trap)}`);
}

/** Every file under `dir`, recursively: [path, lstat]. */
function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    let list = [];
    try {
      list = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const p = join(d, e.name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      out.push([p, st]);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

/** Path → "type size mtime" for the entry's tree, HOME and TMPDIR (minus CAIRN_DATA directories and the trap's logs). */
function snapshot() {
  const map = new Map();
  const skip = new Set([join(ROOT, ".git"), join(ROOT, "node_modules"), join(ROOT, ".launchpad", "checks"), TRAP_DIR]);
  const walk = (d) => {
    let list = [];
    try {
      list = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const p = join(d, e.name);
      if (skip.has(p) || (d === ws.scratch && /^data-\d+$/.test(e.name))) continue;
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      map.set(p, st.isDirectory() ? "dir" : `${st.isSymbolicLink() ? "link" : "file"} ${st.size} ${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  for (const d of [ROOT, ws.home, ws.scratch]) walk(d);
  return map;
}

// ---- the tests ---------------------------------------------------------------------------------------

await test("a bad command line exits 2 with a reason on stderr, nothing on stdout and no network call", () => within({}, async (w) => {
  for (const args of [[], ["frobnicate"], ["tick", "now"], ["doctor", "--verbose"], ["run", "--once"]]) {
    const before = marks(w);
    const r = await w.cairn(args);
    refused(r, 2, `node cairn.mjs ${args.join(" ")}`.trim());
    contactedNothing(w, before, `node cairn.mjs ${args.join(" ")}`.trim());
  }
  // An entry that refuses everything does not pass: the same environment with a good command line works.
  const ok = await w.cairn(["doctor"]);
  check(ok.code === 0, `doctor with a good environment: ${why(ok)}`);
}));

await test("a missing or malformed token, API root, RPC URL, chain or numeric setting exits 2 and contacts nothing", () => within({}, async (w) => {
  const rpcOrigin = new URL(w.node.url).origin;
  const cases = [
    ["no TELEGRAM_BOT_TOKEN", "tick", {}, ["TELEGRAM_BOT_TOKEN"]],
    ["a token without its secret", "doctor", { TELEGRAM_BOT_TOKEN: "7700112233" }],
    ["a token whose id is not a number", "tick", { TELEGRAM_BOT_TOKEN: `x7700112233:${TOKEN_SECRET}` }],
    ["a token whose secret is too short", "tick", { TELEGRAM_BOT_TOKEN: "7700112233:short-secret" }],
    ["an ftp API root", "tick", { TELEGRAM_API_ROOT: w.tg.url.replace("http:", "ftp:") }],
    ["an API root with a path", "doctor", { TELEGRAM_API_ROOT: `${w.tg.url}/bot` }],
    ["an API root that is not a URL", "tick", { TELEGRAM_API_ROOT: "telegram please" }],
    ["no STARKNET_RPC_URL", "tick", {}, ["STARKNET_RPC_URL"]],
    ["an ftp RPC URL", "doctor", { STARKNET_RPC_URL: w.node.url.replace("http:", "ftp:") }],
    ["an RPC URL with no scheme", "tick", { STARKNET_RPC_URL: rpcOrigin.replace("http://", "") }],
    ["CAIRN_CHAIN=SN_GOERLI", "tick", { CAIRN_CHAIN: "SN_GOERLI" }],
    ["CAIRN_POLL_MS=49", "run", { CAIRN_POLL_MS: "49" }],
    ["CAIRN_POLL_MS=10abc", "tick", { CAIRN_POLL_MS: "10abc" }],
    ["CAIRN_POLL_MS=1e3", "doctor", { CAIRN_POLL_MS: "1e3" }],
    ["CAIRN_TG_TIMEOUT=51", "run", { CAIRN_TG_TIMEOUT: "51" }],
    ["CAIRN_TG_TIMEOUT=-1", "tick", { CAIRN_TG_TIMEOUT: "-1" }],
    ["CAIRN_RPC_RPS=0", "tick", { CAIRN_RPC_RPS: "0" }],
    ["CAIRN_RPC_RPS=101", "doctor", { CAIRN_RPC_RPS: "101" }],
    ["CAIRN_RPC_RPS=2.5", "tick", { CAIRN_RPC_RPS: "2.5" }],
    ["CAIRN_RPC_TIMEOUT_MS=99", "tick", { CAIRN_RPC_TIMEOUT_MS: "99" }],
    ["CAIRN_RPC_TIMEOUT_MS=fast", "doctor", { CAIRN_RPC_TIMEOUT_MS: "fast" }],
  ];
  for (const [what, cmd, env, unset = []] of cases) {
    const before = marks(w);
    const r = await w.cairn([cmd], { env, unset, timeoutMs: 10_000 });
    refused(r, 2, `${cmd} with ${what}`);
    contactedNothing(w, before, `${cmd} with ${what}`);
  }
  await w.tick(); // and the good environment works
}));

await test("a bad network file exits 2 naming the bad entry's path", () => within({}, async (w) => {
  const base = network();
  const variant = (f) => {
    const v = structuredClone(base);
    f(v);
    return v;
  };
  const tooMany = Array.from({ length: 51 }, (_, i) => ({ symbol: `T${i}`, address: hex64(feltOf(`many ${i}`)), decimals: 18 }));
  const cases = [
    ["decimals above 36", variant((v) => (v.tokens[2].decimals = 37)), "tokens[2].decimals"],
    ["fractional decimals", variant((v) => (v.tokens[1].decimals = 6.5)), "tokens[1].decimals"],
    ["no decimals", variant((v) => delete v.tokens[0].decimals), "tokens[0].decimals"],
    ["a symbol with a space", variant((v) => (v.tokens[3].symbol = "W BTC")), "tokens[3].symbol"],
    ["a 12-character symbol", variant((v) => (v.tokens[3].symbol = "ABCDEFGHIJKL")), "tokens[3].symbol"],
    ["a symbol repeated in another case", variant((v) => (v.tokens[2].symbol = "strk")), "tokens[2].symbol"],
    ["an address that is not hex", variant((v) => (v.tokens[1].address = "0xZZ12")), "tokens[1].address"],
    ["an address of 65 digits", variant((v) => (v.tokens[1].address = `0x1${"0".repeat(64)}`)), "tokens[1].address"],
    ["an address of 2^251", variant((v) => (v.tokens[1].address = hex64(2n ** 251n))), "tokens[1].address"],
    ["an address repeated once normalised", variant((v) => (v.tokens[4].address = `0x${STRK.address.toString(16).toUpperCase()}`)), "tokens[4].address"],
    ["a chain other than CAIRN_CHAIN", variant((v) => (v.chain = "SN_SEPOLIA")), "chain"],
    ["no tokens", variant((v) => (v.tokens = [])), "tokens"],
    ["51 tokens", variant((v) => (v.tokens = tooMany)), "tokens"],
  ];
  // ARCHITECTURE.md: "<file>: <JSON path>: <reason>", and "<file>: <reason>" for a file that is missing or not JSON.
  let k = 0;
  for (const [what, file, path] of cases) {
    const before = marks(w);
    const name = `bad-network-${++k}.json`;
    const r = await w.cairn(["tick"], { env: { CAIRN_NETWORK_FILE: input(file, name) } });
    refused(r, 2, `a network file with ${what}`);
    check(new RegExp(`${esc(name)}: ${esc(path)}: \\S`).test(r.err), `a network file with ${what}: stderr should say "<file>: ${path}: <reason>", said ${show(r.err.trim())}`);
    contactedNothing(w, before, `a network file with ${what}`);
  }
  for (const [what, name, make] of [["that is not JSON", "broken.json", () => input("{ nope", "broken.json")], ["that does not exist", "missing.json", () => join(ws.inputs, "missing.json")]]) {
    const before = marks(w);
    const r = await w.cairn(["tick"], { env: { CAIRN_NETWORK_FILE: make() } });
    refused(r, 2, `a network file ${what}`);
    check(new RegExp(`${esc(name)}: \\S`).test(r.err), `a network file ${what}: stderr should say "<file>: <reason>", said ${show(r.err.trim())}`);
    contactedNothing(w, before, `a network file ${what}`);
  }
  await w.tick(); // the good file, with keys round 1 ignores, works
}));

await test("a node on another chain than CAIRN_CHAIN, or with an RPC spec below 0.10, exits 2 naming what it found", async () => {
  for (const [what, opts, cmd, names] of [
    ["a Sepolia node", { chainId: SN_SEPOLIA }, "doctor", ["SN_SEPOLIA"]],
    ["a Sepolia node", { chainId: SN_SEPOLIA }, "tick", ["SN_SEPOLIA"]],
    ["a node of another chain", { chainId: "0x4b4154414e41" }, "doctor", ["KATANA", "0x4b4154414e41"]],
    ["a node with spec 0.9.0", { spec: "0.9.0" }, "doctor", ["0.9.0"]],
    ["a node with spec 0.8.1", { spec: "0.8.1" }, "tick", ["0.8.1"]],
  ]) {
    await within(opts, async (w) => {
      const r = await w.cairn([cmd]);
      refused(r, 2, `${cmd} against ${what}`);
      check(names.some((x) => r.err.includes(x)), `${cmd} against ${what}: stderr should name ${names.join(" or ")}, said ${show(r.err.trim())}`);
    });
  }
  // The same checks pass a Sepolia node with CAIRN_CHAIN=SN_SEPOLIA, and specs 0.10.0 and 0.11.2.
  await within({ chainId: SN_SEPOLIA, chainName: "SN_SEPOLIA", spec: "0.10.0" }, async (w) => {
    const r = await w.cairn(["doctor"]);
    check(r.code === 0, `doctor on Sepolia with CAIRN_CHAIN=SN_SEPOLIA and spec 0.10.0: ${why(r)}`);
    check(r.out.includes('"SN_SEPOLIA"'), `doctor on Sepolia should print "chain":"SN_SEPOLIA": ${show(r.out)}`);
  });
  await within({ spec: "0.11.2" }, async (w) => {
    const r = await w.cairn(["doctor"]);
    check(r.code === 0, `doctor against a node with spec 0.11.2: ${why(r)}`);
  });
});

await test("doctor prints the bot's username, the chain, the head block and the RPC spec version as one JSON line", async () => {
  for (const [opts, want] of [
    [{}, { bot: "cairn_check_bot", chain: "SN_MAIN", block: HEAD, spec: "0.10.3" }],
    [{ me: { ...ME, username: "cairn_doctor_bot" }, head: 4_200_123, spec: "0.10.1" }, { bot: "cairn_doctor_bot", chain: "SN_MAIN", block: 4_200_123, spec: "0.10.1" }],
  ]) {
    await within(opts, async (w) => {
      const r = await w.cairn(["doctor"]);
      check(r.code === 0, why(r));
      const lines = r.out.trim().split("\n");
      check(r.out.trim() !== "" && lines.length === 1, `doctor should print exactly one line on stdout, printed ${show(r.out)}`);
      let d;
      try {
        d = JSON.parse(lines[0]);
      } catch {
        throw new Error(`doctor's line is not JSON: ${show(lines[0])}`);
      }
      for (const [k, v] of Object.entries(want)) check(d?.[k] === v, `doctor should print ${show({ [k]: v })}, printed ${show(lines[0])}`);
      check(w.tg.callsOf("getMe").length > 0, "doctor did not call getMe");
      for (const m of ["starknet_chainId", "starknet_specVersion", "starknet_blockNumber"]) check(w.node.callsOf(m).length > 0, `doctor did not call ${m}`);
    });
  }
});

await test("a token Telegram rejects exits 3 with the token nowhere in the output, and a 409 conflict exits 1", async () => {
  await within({ tgToken: "1234567:a-token-the-fake-accepts-instead-of-yours" }, async (w) => {
    for (const cmd of ["tick", "doctor", "run"]) {
      const r = await w.cairn([cmd], { timeoutMs: 10_000 });
      refused(r, 3, `${cmd} with a token Telegram rejects`);
      check(!`${r.out}${r.err}`.includes(TOKEN_SECRET), `${cmd} with a token Telegram rejects printed the token`);
    }
  });
  await within({}, async (w) => {
    w.tg.fail("getUpdates", { code: 409, description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running", times: 1000 });
    for (const cmd of ["tick", "run"]) {
      const r = await w.cairn([cmd], { timeoutMs: 10_000 });
      refused(r, 1, `${cmd} when getUpdates answers 409`);
      check(/instance|conflict|409/i.test(r.err), `${cmd} when getUpdates answers 409: stderr should say another instance is running, said ${show(r.err.trim())}`);
    }
  });
  await within({}, (w) => w.tick()); // and the accepted token works
});

await test("tick answers every pending update in order within each chat and prints its JSON summary", () => within({}, async (w) => {
  const a = dm(w, "Alice"), b = dm(w, "Bob");
  w.tg.say(a.chat, a.u, "/status");
  w.tg.say(b.chat, b.u, `/tx ${hex64(TX_OK)}`);
  w.tg.say(a.chat, a.u, `/balance ${hex64(RICH)}`);
  w.tg.say(b.chat, b.u, `/balance ${hex64(RICH)}`);
  // More than Telegram returns at once (100), so tick must drain getUpdates until it is empty.
  const fillers = Array.from({ length: 100 }, (_, i) => dm(w, `Filler ${i}`));
  for (const f of fillers) w.tg.say(f.chat, f.u, "/zz_unknown");
  w.tg.say(a.chat, a.u, `/tx ${hex64(TX_OK)}`);
  const last = w.tg.say(b.chat, b.u, "/status");
  const s = await w.tick({ timeoutMs: 30_000 });
  // These replies are short: one message each.
  check(show(kinds(w, a.chat)) === show(["status", "balance", "tx"]), `Alice sent /status, /balance, /tx and got, in order: ${show(kinds(w, a.chat))}`);
  check(show(kinds(w, b.chat)) === show(["tx", "balance", "status"]), `Bob sent /tx, /balance, /status and got, in order: ${show(kinds(w, b.chat))}`);
  const unanswered = fillers.filter((f) => !textTo(w, f.chat).includes("/help")).length;
  check(unanswered === 0, `${unanswered} of the 100 chats that sent /zz_unknown got no hint pointing to /help: tick should drain every pending update`);
  check(s.updates === 106, `tick handled 106 updates, its line says "updates":${s.updates}`);
  check(s.sent === w.tg.accepted.length, `Telegram accepted ${w.tg.accepted.length} messages, tick's line says "sent":${s.sent}`);
  check(s.head === HEAD, `the head is ${HEAD}, tick's line says "head":${s.head}`);
  check(w.tg.acked >= last.update_id, `tick should confirm the offset (a getUpdates with offset ${last.update_id + 1}); Telegram's confirmed offset is ${w.tg.acked + 1}`);
}));

await test("a handled update is never answered twice, across ticks, restarts and a SIGKILL after its reply", () => within({}, async (w) => {
  // Across ticks.
  const a = dm(w, "Alice");
  w.tg.say(a.chat, a.u, "/status");
  await w.tick();
  check(w.tg.to(a.chat.id).length >= 1, "the first tick did not answer /status");
  const once = w.tg.to(a.chat.id).length;
  await w.tick();
  await w.tick();
  check(w.tg.to(a.chat.id).length === once, `/status was answered again by a later tick: ${w.tg.to(a.chat.id).length} messages instead of ${once}`);

  // Across a restart: run answers, stops, and a tick after it does not answer again.
  const b = dm(w, "Bob");
  const bot = start(w, ["run"]);
  try {
    await until(() => w.tg.callsOf("getUpdates").length > 0 || !bot.running(), 5000, "run made no getUpdates call within 5 s");
    w.tg.say(b.chat, b.u, "/status");
    await reply(w, b.chat, 0, 5000, "run did not answer /status within 5 s");
    await sleep(300);
    bot.child.kill("SIGTERM");
    await Promise.race([bot.exited, sleep(4000)]);
  } finally {
    bot.kill();
  }
  const bobs = w.tg.to(b.chat.id).length;
  await w.tick();
  check(w.tg.to(b.chat.id).length === bobs, "a tick after run answered run's update again");

  // Across a SIGKILL right after Telegram accepted the reply, before the pass could finish.
  const c = dm(w, "Carol");
  w.tg.say(c.chat, c.u, "/status");
  const killed = start(w, ["tick"]);
  let hit = false;
  w.tg.onSent((m) => {
    if (m?.chat_id === c.chat.id && !hit) {
      hit = true;
      killed.kill("SIGKILL");
    }
  });
  try {
    await Promise.race([killed.exited, sleep(15_000)]);
  } finally {
    killed.kill();
  }
  check(hit, `the tick that was to be killed never answered /status${killed.rec.err.trim() ? `: ${killed.rec.err.trim().slice(-300)}` : ""}`);
  w.tg.say(c.chat, c.u, `/balance ${hex64(RICH)}`);
  await w.tick();
  const got = kinds(w, c.chat);
  check(show(got) === show(["status", "balance"]), `after a SIGKILL right after its /status reply, the next tick should answer only the new /balance; Carol got ${show(kinds(w, c.chat))}`);
}));

await test("registers at least its own commands with setMyCommands", () => within({}, async (w) => {
  await w.tick();
  const want = ["start", "help", "status", "balance", "tx"];
  const calls = w.tg.callsOf("setMyCommands");
  check(calls.length > 0, "tick never called setMyCommands");
  const okCalls = calls.filter((c) => c.status === 200);
  check(okCalls.length > 0, `Telegram refused every setMyCommands: ${show(calls.map((c) => c.error ?? c.status))}`);
  const has = okCalls.some((c) => want.every((x) => c.params.commands.some((k) => String(k.command).replace(/^\//, "") === x)));
  check(has, `setMyCommands should register at least ${want.join(", ")}; registered ${show(okCalls.map((c) => c.params.commands.map((k) => k.command)))}`);
}));

await test("in groups it answers only commands addressed to it, and ignores plain text and other bots' commands", () => within({}, async (w) => {
  const g1 = w.tg.group(-1001000000001, "Stark Devs", "group"), g2 = w.tg.group(-1001000000002, "Cairn Club");
  const u = (n) => w.tg.user(++ids, n);
  w.tg.say(g1, u("Ann"), "/status");
  w.tg.say(g1, u("Ben"), "/status@cairn_check_bot");
  w.tg.say(g1, u("Cy"), "/status@other_bot");
  w.tg.say(g1, u("Di"), "gm everyone, what is the head block?");
  w.tg.say(g1, u("Ed"), "/zz_unknown@other_bot");
  w.tg.say(g1, u("Flo"), `/balance@cairn_check_bot ${hex64(RICH)}`);
  w.tg.say(g2, u("Gus"), `/tx@other_bot ${hex64(TX_OK)}`);
  w.tg.say(g2, u("Hal"), "status please");
  w.tg.say(g2, u("Ida"), `/tx ${hex64(TX_OK)}`);
  await w.tick();
  check(show(kinds(w, g1)) === show(["status", "status", "balance"]), `in a group, /status, /status@cairn_check_bot and /balance@cairn_check_bot should get one reply each, and /status@other_bot, /zz_unknown@other_bot and plain text none; the group got ${show(kinds(w, g1))}`);
  check(show(kinds(w, g2)) === show(["tx"]), `in a supergroup, /tx should get one reply, and /tx@other_bot and plain text none; it got ${show(kinds(w, g2))}`);
}));

await test("/start and /help list the commands, say the replies are on-chain facts and not financial advice, say they cover public balances and transfers only, and link to adding the bot to a group", () =>
  within({ me: { ...ME, username: "cairn_help_check_bot" } }, async (w) => {
    const a = dm(w, "Alice"), b = dm(w, "Bob"), g = w.tg.group(-1001000000003, "Help Group");
    w.tg.say(a.chat, a.u, "/start");
    w.tg.say(b.chat, b.u, "/help");
    w.tg.say(g, w.tg.user(++ids, "Cy"), "/help@cairn_help_check_bot");
    await w.tick();
    const link = "https://t.me/cairn_help_check_bot?startgroup=setup";
    for (const [what, chat] of [["/start", a.chat], ["/help", b.chat], ["/help in a group", g]]) {
      const t = norm(textTo(w, chat));
      check(t !== "", `${what} got no reply`);
      for (const c of ["/status", "/balance", "/tx", "/help"]) check(t.includes(c), `${what} should list ${c}: ${show(t, 600)}`);
      for (const s of ["On-chain facts, not financial advice.", "Public balances and transfers only."]) check(t.includes(s), `${what} should say "${s}": ${show(t, 600)}`);
      const html = htmlTo(w, chat);
      check(linksOf(html).includes(link) || t.includes(link), `${what} should link ${link} (the username from getMe): ${show(html, 600)}`);
    }
  }));

await test("an unknown command gets a hint pointing to /help, and a malformed /start payload gets the plain welcome", () => within({}, async (w) => {
  const plain = dm(w, "Sam");
  w.tg.say(plain.chat, plain.u, "/start");
  const bad = [`/start ${"a".repeat(65)}`, "/start bad$payload", "/start <b>x</b>", "/start ab/cd"];
  const chats = bad.map((text) => {
    const c = dm(w, "Sam");
    w.tg.say(c.chat, c.u, text);
    return [text, c.chat];
  });
  const unknown = dm(w, "Una"), g = w.tg.group(-1001000000004, "Hint Group"), st = dm(w, "Stu");
  w.tg.say(unknown.chat, unknown.u, "/zz_unknown");
  w.tg.say(g, w.tg.user(++ids, "Gil"), "/zz_unknown@cairn_check_bot");
  w.tg.say(st.chat, st.u, "/status");
  await w.tick();
  const welcome = norm(textTo(w, plain.chat));
  check(welcome !== "", "/start got no reply");
  for (const [text, chat] of chats) check(norm(textTo(w, chat)) === welcome, `${show(text)} should get the plain welcome (the reply to /start), got ${show(norm(textTo(w, chat)), 400)}`);
  for (const [what, chat] of [["/zz_unknown", unknown.chat], ["/zz_unknown@cairn_check_bot in a group", g]]) {
    check(norm(textTo(w, chat)).includes("/help"), `${what} should get a hint pointing to /help, got ${show(norm(textTo(w, chat)))}`);
  }
  check(show(kinds(w, st.chat)) === show(["status"]), `/status in the same tick should get the status, got ${show(norm(textTo(w, st.chat)))}`);
}));

await test("/status shows the chain, the head block, its UTC time, the three gas prices in FRI and the node's spec version", async () => {
  for (const [opts, time, prices] of [
    [{}, "2026-10-20 00:00:20 UTC", ["41234567890123", "987654", "12000000001"]],
    [{ head: 4_200_050, spec: "0.10.2", gas: { l1: [55_000_000_000_001n, 7n], l1Data: [1_500n, 8n], l2: [9_999_999_999n, 9n] } }, "2026-10-20 00:01:40 UTC", ["55000000000001", "1500", "9999999999"]],
  ]) {
    await within(opts, async (w) => {
      const a = dm(w, "Alice");
      w.tg.say(a.chat, a.u, "/status");
      await w.tick();
      const t = norm(textTo(w, a.chat));
      check(t !== "", "/status got no reply");
      check(/SN_MAIN|mainnet/i.test(t), `/status should show the chain (SN_MAIN): ${show(t, 600)}`);
      for (const [what, v] of [["the head block", String(w.head)], ["its time", time], ["the L1 gas price", prices[0]], ["the L1 data gas price", prices[1]], ["the L2 gas price", prices[2]], ["the unit", "FRI"], ["the spec version", w.spec]]) {
        check(new RegExp(`(^|[^0-9])${esc(v)}([^0-9]|$)`).test(t), `/status should show ${what}, ${v}: ${show(t, 600)}`);
      }
    });
  }
});

await test("/balance calls balance_of on every registry token in registry order and prints exact amounts, including a u256 above 2^128 and 1 wei", () => within({}, async (w) => {
  const a = dm(w, "Alice");
  w.tg.say(a.chat, a.u, `/balance ${hex64(RICH)}`);
  await w.tick();
  const t = norm(textTo(w, a.chat));
  check(t !== "", "/balance got no reply");
  let at = -1;
  for (const [amount, symbol] of RICH_SHOWS) {
    check(hasAmount(t, amount, symbol), `/balance should show ${amount} ${symbol}: ${show(t, 800)}`);
    const i = norm(t).search(new RegExp(`(^|[^0-9.])${esc(amount)} ${esc(symbol)}`));
    check(i > at, `/balance should list the tokens in registry order (${TOKENS.map((x) => x.symbol).join(", ")}): ${show(t, 800)}`);
    at = i;
  }
  const asked = w.node.calls.filter((c) => isCall(c, SEL.balance_of) && feltEq(callOwner(c), RICH));
  for (const tok of TOKENS) check(asked.some((c) => feltEq(callContract(c), tok.address)), `/balance never called balance_of on ${tok.symbol} (${hex64(tok.address)}) for the address`);
}));

await test("/balance falls back to balanceOf, flags an undeployed address, and shows an error for one failing token without hiding the others", () => within({}, async (w) => {
  const a = dm(w, "Alice"), b = dm(w, "Bob"), c = dm(w, "Carol");
  w.tg.say(a.chat, a.u, `/balance ${hex64(RICH)}`);
  w.tg.say(b.chat, b.u, `/balance ${hex64(UNDEPLOYED)}`);
  w.tg.say(c.chat, c.u, `/balance ${hex64(FAILING)}`);
  await w.tick();
  const rich = norm(textTo(w, a.chat)), undeployed = norm(textTo(w, b.chat)), failing = norm(textTo(w, c.chat));
  check(hasAmount(rich, "21.00000001", "WBTC"), `WBTC has no balance_of (error 21): /balance should show its balanceOf, 21.00000001 WBTC: ${show(rich, 800)}`);
  check(w.node.calls.some((x) => isCall(x, SEL.balanceOf) && feltEq(callContract(x), WBTC.address) && feltEq(callOwner(x), RICH)), "/balance never called balanceOf on WBTC after balance_of answered 21");
  check(!/not deployed/i.test(rich), `a deployed address should not be flagged "not deployed": ${show(rich, 800)}`);
  check(/not deployed/i.test(undeployed), `an address getClassHashAt answers 20 for should be flagged "not deployed": ${show(undeployed, 800)}`);
  check(hasAmount(undeployed, "5", "STRK"), `an undeployed address should still show its balances (5 STRK): ${show(undeployed, 800)}`);
  check(hasAmount(failing, "7", "STRK") && hasAmount(failing, "3", "WBTC"), `one failing token should not hide the others (7 STRK, 3 WBTC): ${show(failing, 800)}`);
  check(/USDC/.test(failing) && !/(^|[^0-9.])[0-9][0-9.]* USDC(?![A-Za-z0-9])/.test(failing), `USDC's balance_of fails with error 40 for this address: /balance should show an error for USDC, not an amount: ${show(failing, 800)}`);
  check(/error|fail|unavailable|could ?n[o']t|unable|n\/a/i.test(failing), `USDC's failed call should be shown as an error: ${show(failing, 800)}`);
}));

await test("an invalid address or hash is explained and makes no call about it", () => within({}, async (w) => {
  const bad = [
    ["/balance 0xZZZ", /address/i], ["/balance 0x", /address/i], ["/balance", /address/i], [`/balance 0x1${"0".repeat(64)}`, /address/i],
    [`/balance ${hex64(2n ** 251n)}`, /address/i], ["/balance 0x0", /address/i], ["/balance hello", /address/i],
    ["/tx 0xnothex", /hash|transaction/i], [`/tx ${hex64(P)}`, /hash|transaction/i], ["/tx 0x0", /hash|transaction/i], ["/tx", /hash|transaction/i],
  ];
  const chats = bad.map(([text, reason]) => {
    const c = dm(w, "Sam");
    w.tg.say(c.chat, c.u, text);
    return [text, reason, c.chat];
  });
  const ok1 = dm(w, "Alice"), ok2 = dm(w, "Bob");
  w.tg.say(ok1.chat, ok1.u, `/balance ${hex64(RICH)}`);
  w.tg.say(ok2.chat, ok2.u, `/tx ${hex64(TX_OK)}`);
  await w.tick();
  for (const [text, reason, chat] of chats) {
    const t = norm(textTo(w, chat));
    check(t !== "", `${show(text)} got no reply`);
    check(reason.test(t) && !/not found/i.test(t), `${show(text)} should be refused with a reason about the ${reason.source.split("|")[0].replace(/\W/g, "")}, got ${show(t, 300)}`);
  }
  // The only addresses and hashes looked up are the valid ones.
  const strays = w.node.calls.filter((c) => (TX_METHODS.includes(c.method) && !feltEq(c.params?.transaction_hash, TX_OK)) ||
    (["starknet_getClassHashAt", "starknet_getClassAt", "starknet_getNonce"].includes(c.method) && !feltEq(c.params?.contract_address, RICH)) ||
    ((isCall(c, SEL.balance_of) || isCall(c, SEL.balanceOf)) && !feltEq(callOwner(c), RICH)));
  check(strays.length === 0, `invalid input made calls about it: ${show(strays.map((c) => ({ method: c.method, params: c.params })), 600)}`);
  check(hasAmount(textTo(w, ok1.chat), "1234.5", "STRK"), `a valid /balance in the same tick should work: ${show(norm(textTo(w, ok1.chat)))}`);
  check(hasAmount(textTo(w, ok2.chat), "1.23456789", "STRK"), `a valid /tx in the same tick should work: ${show(norm(textTo(w, ok2.chat)))}`);
}));

await test("/tx shows finality, execution status, block, fee in STRK and an explorer link built from CAIRN_EXPLORER_URL", () => within({}, async (w) => {
  const a = dm(w, "Alice"), b = dm(w, "Bob");
  w.tg.say(a.chat, a.u, `/tx ${hex64(TX_OK)}`);
  w.tg.say(b.chat, b.u, `/tx ${hex64(TX_L1)}`);
  await w.tick();
  for (const [chat, hash, finality, block, fee] of [[a.chat, TX_OK, /ACCEPTED_ON_L2|accepted on L2/i, "4200007", "1.23456789"], [b.chat, TX_L1, /ACCEPTED_ON_L1|accepted on L1/i, "4200003", "0.05"]]) {
    const t = norm(textTo(w, chat));
    const what = `/tx ${short(hash)}`;
    check(t !== "", `${what} got no reply`);
    check(finality.test(t), `${what} should show its finality (${finality.source}): ${show(t, 600)}`);
    check(/SUCCEEDED|succeeded|success/i.test(t), `${what} should show its execution status, SUCCEEDED: ${show(t, 600)}`);
    check(new RegExp(`(^|[^0-9])${block}([^0-9]|$)`).test(t), `${what} should show its block, ${block}: ${show(t, 600)}`);
    check(hasAmount(t, fee, "STRK"), `${what} should show its fee, ${fee} STRK: ${show(t, 600)}`);
    const link = `${EXPLORER}/tx/${hex64(hash)}`;
    check(linksOf(htmlTo(w, chat)).includes(link), `${what} should link ${link}: links ${show(linksOf(htmlTo(w, chat)))}`);
  }
}));

await test("/tx of a reverted transaction shows its revert reason HTML-escaped, and an unknown hash says it was not found", () => within({}, async (w) => {
  const a = dm(w, "Alice"), b = dm(w, "Bob");
  w.tg.say(a.chat, a.u, `/tx ${hex64(TX_REV)}`);
  w.tg.say(b.chat, b.u, `/tx ${hex64(TX_UNKNOWN)}`);
  await w.tick();
  const rev = norm(textTo(w, a.chat)), unknown = norm(textTo(w, b.chat));
  check(rev !== "", `/tx of a reverted transaction got no reply${w.tg.callsOf("sendMessage").some((c) => c.status === 400) ? `: Telegram refused it: ${show(w.tg.callsOf("sendMessage").find((c) => c.status === 400).error)}` : ""}`);
  check(/REVERTED|reverted/i.test(rev), `a reverted transaction should show REVERTED: ${show(rev, 600)}`);
  check(rev.includes(norm(REVERT)), `the revert reason should appear as is, escaped: expected ${show(REVERT)} in ${show(rev, 600)}`);
  check(/not found/i.test(unknown), `an unknown hash should say it was not found: ${show(unknown, 300)}`);
  check(!/not found/i.test(rev), `a known transaction should not say "not found": ${show(rev, 300)}`);
}));

await test("addresses and hashes are accepted in any case, with or without leading zeros, and shown normalised", () => within({}, async (w) => {
  const forms = [hex64(RICH), `0x${RICH.toString(16).toUpperCase()}`, `0x${RICH.toString(16).replace(/[a-f]/g, (c, i) => (i % 2 ? c.toUpperCase() : c))}`];
  const chats = forms.map((f) => {
    const c = dm(w, "Sam");
    w.tg.say(c.chat, c.u, `/balance ${f}`);
    return [f, c.chat];
  });
  const t1 = dm(w, "Tia");
  w.tg.say(t1.chat, t1.u, `/tx 0x${TX_OK.toString(16).toUpperCase()}`);
  await w.tick();
  const link = `${EXPLORER}/contract/${hex64(RICH)}`;
  for (const [f, chat] of chats) {
    const t = norm(textTo(w, chat));
    check(hasAmount(t, "1234.5", "STRK"), `/balance ${f} should show the address's balances: ${show(t, 400)}`);
    check(t.includes(short(RICH)), `/balance ${f} should show the address as ${short(RICH)}: ${show(t, 400)}`);
    check(linksOf(htmlTo(w, chat)).includes(link), `/balance ${f} should link ${link}: links ${show(linksOf(htmlTo(w, chat)))}`);
  }
  const tx = norm(textTo(w, t1.chat));
  check(hasAmount(tx, "1.23456789", "STRK"), `/tx with an upper-case hash without leading zeros should find it: ${show(tx, 400)}`);
  check(linksOf(htmlTo(w, t1.chat)).includes(`${EXPLORER}/tx/${hex64(TX_OK)}`), `/tx should link the normalised hash, ${EXPLORER}/tx/${hex64(TX_OK)}: links ${show(linksOf(htmlTo(w, t1.chat)))}`);
}));

await test("an RPC 429, 5xx or timeout is retried with backoff, then answered with a node-busy reply, and tick still exits 0", async () => {
  await within({}, async (w) => {
    const strk = (c) => isCall(c, SEL.balance_of) && feltEq(callContract(c), STRK.address) && feltEq(callOwner(c), RICH);
    const eth = (c) => isCall(c, SEL.balance_of) && feltEq(callContract(c), ETH.address) && feltEq(callOwner(c), RICH);
    w.node.fail({ when: strk, http: 429, retryAfter: 1, times: 1 });
    w.node.fail({ when: (c) => aboutTx(c, TX_OK), http: 503, times: 2 });
    w.node.fail({ when: eth, delayMs: 2500, times: 1 });
    const a = dm(w, "Alice"), b = dm(w, "Bob");
    w.tg.say(a.chat, a.u, `/balance ${hex64(RICH)}`);
    w.tg.say(b.chat, b.u, `/tx ${hex64(TX_OK)}`);
    const s = await w.tick({ timeoutMs: 60_000 });
    check(s.head === HEAD, `tick's head should be ${HEAD}: ${show(s)}`);
    const bal = norm(textTo(w, a.chat)), tx = norm(textTo(w, b.chat));
    check(hasAmount(bal, "1234.5", "STRK"), `STRK's balance_of answered 429 once (Retry-After: 1): it should be retried and shown, 1234.5 STRK: ${show(bal, 600)}`);
    check(hasAmount(bal, "0.000000000000000001", "ETH"), `ETH's balance_of timed out once: it should be retried and shown: ${show(bal, 600)}`);
    check(hasAmount(tx, "1.23456789", "STRK"), `the transaction's lookups answered 503 twice: the third try should succeed and be shown: ${show(tx, 600)}`);
    const tries = w.node.requests.filter((r) => r.calls.some(strk));
    check(tries.length >= 2, "STRK's balance_of was not retried after the 429");
    const gap = tries[1].at - tries[0].at;
    check(gap >= 900, `the retry after a 429 with Retry-After: 1 came ${gap} ms later, before Retry-After`);
  });
  await within({}, async (w) => {
    w.node.fail({ when: () => true, http: 503, times: 1e9 });
    const a = dm(w, "Alice"), b = dm(w, "Bob");
    w.tg.say(a.chat, a.u, "/status");
    w.tg.say(b.chat, b.u, `/balance ${hex64(RICH)}`);
    const s = await w.tick({ timeoutMs: 60_000 });
    check(s.head === null, `with a node that answers 503 to everything, tick's head should be null: ${show(s)}`);
    for (const [what, chat] of [["/status", a.chat], ["/balance", b.chat]]) check(/busy/i.test(textTo(w, chat)), `${what} against a node that answers 503 should get a "node busy" reply, got ${show(norm(textTo(w, chat)))}`);
    const byMethod = new Map();
    for (const c of w.node.calls) byMethod.set(c.method, (byMethod.get(c.method) ?? 0) + 1);
    check([...byMethod.values()].some((n) => n >= 2), `a node answering 503 was never retried: ${show(Object.fromEntries(byMethod))}`);
  });
});

await test("never makes more RPC calls in any one second than CAIRN_RPC_RPS", () => within({ env: { CAIRN_RPC_RPS: "2" } }, async (w) => {
  const a = dm(w, "Alice"), b = dm(w, "Bob");
  w.tg.say(a.chat, a.u, `/balance ${hex64(RICH)}`);
  w.tg.say(b.chat, b.u, `/tx ${hex64(TX_OK)}`);
  await w.tick({ timeoutMs: 60_000 });
  check(hasAmount(textTo(w, a.chat), "1234.5", "STRK") && hasAmount(textTo(w, a.chat), "21.00000001", "WBTC"), `/balance should still be answered in full under CAIRN_RPC_RPS=2: ${show(norm(textTo(w, a.chat)), 600)}`);
  check(hasAmount(textTo(w, b.chat), "1.23456789", "STRK"), `/tx should still be answered under CAIRN_RPC_RPS=2: ${show(norm(textTo(w, b.chat)), 600)}`);
  // Each call in a batch counts. At most RPS + 1 calls, in a window of 900 ms: 100 ms for delivery jitter.
  const at = w.node.calls.map((c) => c.at).sort((x, y) => x - y);
  let worst = 0, when = 0;
  for (let i = 0; i < at.length; i++) {
    let j = i;
    while (j < at.length && at[j] - at[i] < 900) j++;
    if (j - i > worst) [worst, when] = [j - i, at[i] - at[0]];
  }
  check(worst <= 3, `CAIRN_RPC_RPS=2, but the node received ${worst} calls within one second (${when} ms after the first of ${at.length} calls)`);
}));

await test("a Telegram 429 is retried after retry_after and the message is sent exactly once", () => within({}, async (w) => {
  const a = dm(w, "Alice"), b = dm(w, "Bob");
  w.tg.fail("sendMessage", { chat: a.chat.id, code: 429, description: "Too Many Requests: retry after 1", parameters: { retry_after: 1 }, times: 1 });
  w.tg.say(a.chat, a.u, "/status");
  w.tg.say(b.chat, b.u, "/status");
  await w.tick({ timeoutMs: 30_000 });
  const tries = w.tg.callsOf("sendMessage").filter((c) => c.params.chat_id === a.chat.id);
  check(w.tg.to(a.chat.id).length === 1, `Alice's /status should be answered exactly once after a 429, Telegram accepted ${w.tg.to(a.chat.id).length} messages`);
  check(tries.length === 2, `after one 429, the message should be sent once more: ${tries.length} sendMessage calls to the chat`);
  const gap = tries[1].at - tries[0].at;
  check(gap >= 900, `the resend came ${gap} ms after a 429 with retry_after 1`);
  check(kinds(w, b.chat).includes("status"), "Bob's /status was not answered");
}));

await test("a chat that blocked the bot is skipped, and other chats still get their answers", () => within({}, async (w) => {
  const a = dm(w, "Alice"), b = dm(w, "Bob"), c = dm(w, "Carol");
  w.tg.blocked.add(b.chat.id);
  w.tg.say(a.chat, a.u, "/status");
  w.tg.say(b.chat, b.u, "/status");
  w.tg.say(b.chat, b.u, "/help");
  w.tg.say(c.chat, c.u, `/balance ${hex64(RICH)}`);
  const s = await w.tick({ timeoutMs: 30_000 });
  check(kinds(w, a.chat).includes("status"), "Alice, before the chat that blocked the bot, got no answer");
  check(kinds(w, c.chat).includes("balance"), "Carol, after the chat that blocked the bot, got no answer");
  const tries = w.tg.callsOf("sendMessage").filter((x) => x.params.chat_id === b.chat.id).length;
  check(tries <= 2, `Telegram answered 403 for the chat that blocked the bot, yet it got ${tries} sendMessage calls for 2 updates`);
  check(s.updates >= 4, `tick handled 4 updates, its line says ${s.updates}`);
}));

await test("every message is valid Telegram HTML of at most 4096 characters, with outside text escaped and link previews off", () => within({}, async (w) => {
  const g = w.tg.group(-1001000000005, "Format Group");
  const texts = ["/start", "/help", "/status", `/balance ${hex64(RICH)}`, `/balance ${hex64(UNDEPLOYED)}`, `/balance ${hex64(FAILING)}`,
    `/tx ${hex64(TX_OK)}`, `/tx ${hex64(TX_REV)}`, `/tx ${hex64(TX_LONG)}`, `/tx ${hex64(TX_UNKNOWN)}`, "/zz_unknown", "/balance 0x<b>1</b>", "/start <i>"];
  const chats = texts.map((t) => {
    const c = dm(w, "Sam");
    w.tg.say(c.chat, c.u, t);
    return [t, c.chat];
  });
  w.tg.say(g, w.tg.user(++ids, "Gil"), "/status");
  await w.tick({ timeoutMs: 30_000 });
  const refusedCalls = w.tg.calls.filter((c) => ["sendMessage", "editMessageText"].includes(c.method) && c.status === 400);
  check(refusedCalls.length === 0, `Telegram refused ${refusedCalls.length} message(s): ${show(refusedCalls.map((c) => `${c.error}: ${String(c.params.text).slice(0, 120)}`), 800)}`);
  for (const [t, chat] of [...chats, ["/status in a group", g]]) check(w.tg.to(chat.id).length > 0, `${show(t)} got no reply`);
  for (const m of w.tg.accepted) {
    const p = m.params;
    check(String(p.parse_mode).toLowerCase() === "html", `every message should use parse_mode HTML; one had ${show(p.parse_mode)}: ${show(m.text, 120)}`);
    check(p.link_preview_options?.is_disabled === true || p.disable_web_page_preview === true, `every message should turn link previews off (link_preview_options {"is_disabled": true}); one had ${show(p.link_preview_options)}: ${show(m.text, 120)}`);
  }
  check(w.tg.violations.length === 0, `no Mini App, login or payment button is allowed: ${show(w.tg.violations)}`);
  const long = chats.find(([t]) => t.includes(hex64(TX_LONG).slice(2)))[1];
  check(w.tg.to(long.id).every((m) => m.text.length <= 4096), "a message longer than 4096 characters was accepted");
}));

await test("run answers within 3 s, survives a node that is down for 2 s, and exits 0 within 3 s of SIGTERM during a long poll", () => within({}, async (w) => {
  const bot = start(w, ["run"]);
  try {
    await until(() => w.tg.callsOf("getUpdates").length > 0 || !bot.running(), 8000, "run made no getUpdates call within 8 s");
    check(bot.running(), `run exited before polling: ${why(bot.rec)}`);
    const a = dm(w, "Alice"), b = dm(w, "Bob"), c = dm(w, "Carol");
    w.tg.say(a.chat, a.u, "/status");
    await reply(w, a.chat, 0, 3000, "run did not answer /status within 3 s");
    check(kinds(w, a.chat)[0] === "status", `run's answer to /status: ${show(w.tg.to(a.chat.id)[0]?.text)}`);
    w.node.down(2000);
    const back = Date.now() + 2000;
    await sleep(100);
    w.tg.say(b.chat, b.u, "/status");
    await reply(w, b.chat, 0, 8000, "run did not answer /status sent while the node was down (a node-busy reply would do)");
    await until(() => Date.now() >= back + 100, 3000, "");
    check(bot.running(), `run exited while the node was down: ${why(bot.rec)}`);
    w.tg.say(c.chat, c.u, "/status");
    await reply(w, c.chat, 0, 5000, "run did not answer /status within 5 s once the node was back");
    check(kinds(w, c.chat)[0] === "status", `once the node is back, /status should show the chain again: ${show(w.tg.to(c.chat.id)[0]?.text)}`);
    await until(() => w.tg.holding, 5000, "run is not holding a long poll (getUpdates with timeout CAIRN_TG_TIMEOUT=1) to interrupt");
    const t = Date.now();
    bot.child.kill("SIGTERM");
    const r = await Promise.race([bot.exited, sleep(3000).then(() => null)]);
    check(r !== null, "run did not exit within 3 s of SIGTERM during a long poll");
    check(r.code === 0, `run should exit 0 on SIGTERM, exited with ${r.code ?? r.signal} after ${Date.now() - t} ms`);
  } finally {
    bot.kill();
  }
  check(w.tg.callsOf("deleteWebhook").length === 1, `run should call deleteWebhook once at start, called it ${w.tg.callsOf("deleteWebhook").length} times`);
  check(w.tg.callsOf("setWebhook").length === 0, "run called setWebhook: Cairn long-polls only");
}));

await test("never calls a Starknet write method or uses the pending or pre_confirmed tag, and contacts only TELEGRAM_API_ROOT and STARKNET_RPC_URL", async () => {
  await within({}, async (w) => {
    const a = dm(w, "Alice"), b = dm(w, "Bob"), c = dm(w, "Carol");
    w.tg.say(a.chat, a.u, "/status");
    w.tg.say(b.chat, b.u, `/balance ${hex64(UNDEPLOYED)}`);
    w.tg.say(c.chat, c.u, `/tx ${hex64(TX_REV)}`);
    await w.tick();
    check(kinds(w, a.chat).includes("status") && hasAmount(textTo(w, b.chat), "5", "STRK") && /REVERTED/i.test(textTo(w, c.chat)), "/status, /balance and /tx should be answered");
    const r = await w.cairn(["doctor"]);
    check(r.code === 0, `doctor: ${why(r)}`);
    check(trapOf(w).some((t) => t.kind === "loaded"), `the checks' network trap (NODE_OPTIONS=--import=…/trap.mjs) did not load in cairn's process, so the hosts it contacts cannot be checked: keep NODE_OPTIONS`);
  });
  // Everything every world saw, in every test so far.
  const problems = [];
  for (const w of worlds) {
    for (const v of w.node.violations) problems.push(`world ${w.n}: ${v}`);
    const allowed = new Set([`127.0.0.1:${w.tg.port}`, `127.0.0.1:${w.node.port}`]);
    for (const t of contacts(w)) {
      if (t.kind.includes("connect") && allowed.has(t.dest)) continue;
      if (t.kind.includes("dns") && t.dest === "127.0.0.1") continue; // a lookup of the literal itself
      problems.push(`world ${w.n}: ${t.kind} ${t.dest} (only ${[...allowed].join(" and ")} are configured)`);
    }
  }
  check(problems.length === 0, `${problems.length} problem(s):\n${[...new Set(problems)].slice(0, 20).join("\n")}`);
});

await test("the bot token and the secret in the RPC URL appear in no output, log, message, data file or request to the other host", async () => {
  await within({ env: { CAIRN_LOG: "debug" } }, async (w) => {
    w.node.fail({ when: (c) => c.method === "starknet_getTransactionReceipt" || c.method === "starknet_getTransactionStatus", http: 503, times: 1 });
    w.tg.fail("sendMessage", { code: 500, description: "Internal Server Error", times: 1 });
    const a = dm(w, "Alice"), b = dm(w, "Bob"), c = dm(w, "Carol");
    w.tg.say(a.chat, a.u, "/status");
    w.tg.say(b.chat, b.u, `/balance ${hex64(FAILING)}`);
    w.tg.say(c.chat, c.u, `/tx ${hex64(TX_REV)}`);
    await w.tick({ timeoutMs: 30_000 });
    check(hasAmount(textTo(w, b.chat), "7", "STRK"), `/balance should be answered with CAIRN_LOG=debug: ${show(norm(textTo(w, b.chat)))}`);
    check((await w.cairn(["doctor"])).code === 0, "doctor failed with CAIRN_LOG=debug");
    refused(await w.cairn(["tick"], { env: { CAIRN_CHAIN: "SN_SEPOLIA", CAIRN_NETWORK_FILE: input(network(TOKENS, "SN_SEPOLIA")) } }), 2, "tick against a node of another chain");
  });
  const secrets = [["the bot token", TOKEN_SECRET], ["the RPC URL's path secret", RPC_SECRET], ["the RPC URL's query secret", RPC_QUERY_SECRET]];
  const leaks = [];
  const look = (where, text, which = secrets) => {
    for (const [name, s] of which) if (String(text).includes(s)) leaks.push(`${name} in ${where}`);
  };
  for (const w of worlds) {
    for (const r of w.runs) {
      look(`stdout of ${r.cmd} (world ${w.n})`, r.out);
      look(`stderr of ${r.cmd} (world ${w.n})`, r.err);
    }
    for (const q of w.tg.requests) {
      look(`a request to Telegram (world ${w.n})`, `${q.url.replace(`/bot${TOKEN}/`, "/bot<token>/")} ${JSON.stringify(q.headers)} ${q.body}`);
    }
    for (const q of w.node.requests) look(`a request to the node (world ${w.n})`, `${JSON.stringify(q.headers)} ${q.body}`, secrets.slice(0, 1));
    for (const [p, st] of filesUnder(w.data)) if (st.isFile()) look(`${p}`, readFileSync(p).toString("latin1"));
  }
  check(leaks.length === 0, [...new Set(leaks)].slice(0, 20).join("\n"));
});

await test("writes only inside CAIRN_DATA, a directory of mode 700 with files of mode 600", async () => {
  await within({}, async (w) => {
    const a = dm(w, "Alice");
    w.tg.say(a.chat, a.u, `/balance ${hex64(RICH)}`);
    await w.tick();
    check(hasAmount(textTo(w, a.chat), "1234.5", "STRK"), "/balance was not answered");
    check(existsSync(w.data), `tick did not create CAIRN_DATA (${w.data}): it holds the update offset`);
  });
  const problems = [];
  for (const w of worlds) {
    if (!existsSync(w.data)) continue;
    const top = lstatSync(w.data);
    if (!top.isDirectory() || (top.mode & 0o777) !== 0o700) problems.push(`CAIRN_DATA ${w.data} has mode ${(top.mode & 0o777).toString(8)}, not 700`);
    for (const [p, st] of filesUnder(w.data)) {
      if (st.isSymbolicLink()) problems.push(`${p} is a symbolic link`);
      else if (st.isDirectory() && (st.mode & 0o777) !== 0o700) problems.push(`${p} is a directory of mode ${(st.mode & 0o777).toString(8)}, not 700`);
      else if (st.isFile() && (st.mode & 0o777) !== 0o600) problems.push(`${p} has mode ${(st.mode & 0o777).toString(8)}, not 600`);
    }
  }
  const after = snapshot();
  for (const [p, v] of after) if (BEFORE.get(p) !== v && !(v === "dir" && BEFORE.get(p) === "dir")) problems.push(`${BEFORE.has(p) ? "changed" : "wrote"} ${p}, outside CAIRN_DATA`);
  check(problems.length === 0, [...new Set(problems)].slice(0, 20).join("\n"));
});

await test("the repository holds no Telegram token, private key or seed phrase, package.json has no dependency, and the committed network files are well-formed, with at least STRK, ETH, USDC, USDC.e, USDT and WBTC on SN_MAIN", () => {
  const problems = [];
  // Secrets: every file of the entry's tree but .git, node_modules and these checks (which hold fake markers).
  const skip = new Set([join(ROOT, ".git"), join(ROOT, "node_modules"), join(ROOT, ".launchpad", "checks")]);
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (skip.has(p)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(p);
    }
  };
  walk(ROOT);
  const SEED = new Set([12, 15, 18, 21, 24]);
  for (const p of files) {
    const st = lstatSync(p);
    if (st.size > 5_000_000) continue;
    const text = readFileSync(p).toString("latin1"), rel = p.slice(ROOT.length + 1);
    const tok = /(?<![0-9])[0-9]{5,16}:(?!0x)[A-Za-z0-9_-]{30,}/.exec(text);
    if (tok) problems.push(`${rel} holds what looks like a Telegram bot token (${tok[0].slice(0, 12)}…)`);
    if (/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(text)) problems.push(`${rel} holds a PEM private key`);
    const key = /\b(?:private|priv|secret|signer|signing)[_ -]?key\b["']?\s*[:=]\s*["']?(?:0x)?[0-9a-fA-F]{60,64}\b/i.exec(text);
    if (key) problems.push(`${rel} holds what looks like a private key (${key[0].slice(0, 24)}…)`);
    // A seed phrase: 12, 15, 18, 21 or 24 words of 3 to 8 lower-case letters, alone in a string or on a line,
    // or after a MNEMONIC/SEED variable. (No word list in round 1: BIP-39's arrives with round 4's guard.)
    const runs = [
      ...[...text.matchAll(/["'`]((?:[a-z]{3,8} ){11,23}[a-z]{3,8})["'`]/g)].map((m) => m[1]),
      ...[...text.matchAll(/^[ \t>*#-]*((?:[a-z]{3,8} ){11,23}[a-z]{3,8})[ \t]*\r?$/gm)].map((m) => m[1]),
      ...[...text.matchAll(/\b(?:MNEMONIC|SEED(?:_PHRASE)?|RECOVERY_PHRASE)\s*[=:]\s*["']?([a-z]+(?: [a-z]+){11,23})/gi)].map((m) => m[1]),
    ];
    for (const s of runs) if (SEED.has(s.trim().split(/\s+/).length)) problems.push(`${rel} holds what looks like a seed phrase ("${s.split(" ").slice(0, 2).join(" ")} …")`);
  }
  // No dependency.
  let pkg = null;
  try {
    pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  } catch (e) {
    problems.push(`package.json cannot be read as JSON: ${e.message}`);
  }
  for (const k of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"]) {
    const v = pkg?.[k];
    if (v !== undefined && !(Array.isArray(v) ? v.length === 0 : v && typeof v === "object" && Object.keys(v).length === 0)) problems.push(`package.json declares ${k}: ${show(v, 120)}`);
  }
  // The committed network files.
  for (const name of ["SN_MAIN", "SN_SEPOLIA"]) {
    const rel = `networks/${name}.json`;
    let f;
    try {
      f = JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
    } catch (e) {
      problems.push(`${rel} is missing or not JSON: ${e.message}`);
      continue;
    }
    if (f?.chain !== name) problems.push(`${rel}: chain should be "${name}", is ${show(f?.chain)}`);
    const list = f?.tokens;
    if (!Array.isArray(list) || list.length < 1 || list.length > 50) {
      problems.push(`${rel}: tokens should list 1 to 50 tokens`);
      continue;
    }
    const symbols = new Set(), addresses = new Set();
    list.forEach((t, i) => {
      const at = `${rel}: tokens[${i}]`;
      if (typeof t?.symbol !== "string" || !/^[A-Za-z0-9.]{1,11}$/.test(t.symbol)) problems.push(`${at}.symbol ${show(t?.symbol)} should match ^[A-Za-z0-9.]{1,11}$`);
      else if (symbols.has(t.symbol.toLowerCase())) problems.push(`${at}.symbol ${t.symbol} is repeated`);
      else symbols.add(t.symbol.toLowerCase());
      const ok = typeof t?.address === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(t.address) && BigInt(t.address) > 0n && BigInt(t.address) < 2n ** 251n - 256n;
      if (!ok) problems.push(`${at}.address ${show(t?.address)} is not a valid address`);
      else if (addresses.has(BigInt(t.address))) problems.push(`${at}.address is repeated`);
      else addresses.add(BigInt(t.address));
      if (!Number.isInteger(t?.decimals) || t.decimals < 0 || t.decimals > 36) problems.push(`${at}.decimals ${show(t?.decimals)} should be an integer from 0 to 36`);
    });
    if (name === "SN_MAIN") {
      const have = new Set(list.map((t) => t?.symbol));
      for (const s of ["STRK", "ETH", "USDC", "USDC.e", "USDT", "WBTC"]) if (!have.has(s)) problems.push(`${rel} should list ${s}`);
    }
  }
  check(problems.length === 0, problems.slice(0, 20).join("\n"));
});

done();
