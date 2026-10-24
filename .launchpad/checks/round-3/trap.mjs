// The network trap of round 1's checks. The checks load it into every Cairn process they start, with
// NODE_OPTIONS=--import=<this file>, and give it CAIRN_TRAP_LOG, a file under the kit's scratch directory.
// It appends one JSON line per DNS lookup and per outbound connection, before the connection is attempted,
// so the checks can tell which hosts Cairn tried to reach. It changes nothing else: every call goes through.
// Node built-ins only. It is part of the checks, never of Cairn.
import { appendFileSync } from "node:fs";
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

const LOG = process.env.CAIRN_TRAP_LOG;
const note = (kind, dest) => {
  if (!LOG) return;
  try {
    appendFileSync(LOG, `${JSON.stringify({ pid: process.pid, kind, dest: String(dest) })}\n`);
  } catch {}
};
note("loaded", process.argv.slice(1).join(" "));

/** "host:port" (or the socket path) from net/tls connect arguments. */
function destOf(args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0]; // the internal normalized form: [options, callback]
  if (a && typeof a === "object") return a.path ?? `${a.host ?? a.hostname ?? "localhost"}:${a.port}`;
  if (typeof a === "string" && !/^\d+$/.test(a)) return a; // a socket path
  return `${typeof args[1] === "string" ? args[1] : "localhost"}:${a}`;
}

// Every TCP and TLS socket goes through Socket.prototype.connect; net.connect and tls.connect are noted too.
// One connection may therefore be noted more than once: the checks compare destinations, not counts.
const sockConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  note("connect", destOf(args));
  return sockConnect.apply(this, args);
};
for (const [mod, name] of [[net, "connect"], [net, "createConnection"], [tls, "connect"]]) {
  const orig = mod[name];
  mod[name] = function (...args) {
    note(name === "connect" && mod === tls ? "tls.connect" : `net.${name}`, destOf(args));
    return orig.apply(this, args);
  };
}
for (const name of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCname", "resolveTxt", "resolveSrv"]) {
  const orig = dns[name];
  if (typeof orig !== "function") continue;
  dns[name] = function (host, ...rest) {
    note(`dns.${name}`, host);
    return orig.call(this, host, ...rest);
  };
  const porig = dns.promises[name];
  if (typeof porig === "function") {
    dns.promises[name] = function (host, ...rest) {
      note(`dns.promises.${name}`, host);
      return porig.call(this, host, ...rest);
    };
  }
}
syncBuiltinESMExports();
