import { createServer } from 'node:http';
import { CairnError, log } from './errors.mjs';

// The HTTP endpoint (round 4), only in `run` and only with CAIRN_HTTP_PORT set: GET /healthz and GET /metrics on
// CAIRN_HTTP_HOST, and nothing else (404 for another path, 405 for another method). Both answer from what the
// bot's passes recorded: a request never calls Telegram or the node, so a probe cannot slow the bot down.

/** Prometheus text exposition of `metrics`: [{ name, type, help, samples: [[labels, value]…] }]. */
export function prometheus(metrics) {
  const lines = [];
  for (const { name, type, help, samples } of metrics) {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) {
      const tags = Object.entries(labels).map(([k, v]) => `${k}="${String(v).replace(/[\\"\n]/g, (c) => (c === '\n' ? '\\n' : `\\${c}`))}"`);
      lines.push(`${name}${tags.length ? `{${tags.join(',')}}` : ''} ${Number.isFinite(value) ? value : 'NaN'}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  res.end(body);
}

/**
 * Listens on CAIRN_HTTP_HOST:CAIRN_HTTP_PORT (0 picks a free port) and logs
 * {"level":"info","event":"http","port":<n>}. `health()` gives { ok, … }: 200 when ok, else 503 with its reason.
 * Closes when `signal` aborts.
 */
export function listen(config, { health, metrics }, signal) {
  const routes = {
    '/healthz': () => { const h = health(); return [h.ok ? 200 : 503, 'application/json', JSON.stringify(h)]; },
    '/metrics': () => [200, 'text/plain; version=0.0.4; charset=utf-8', metrics()],
  };
  const server = createServer((req, res) => {
    let path = null;
    try { path = new URL(req.url, 'http://cairn').pathname; } catch { /* not a path: 404 */ }
    if (!Object.hasOwn(routes, path)) return send(res, 404, 'text/plain; charset=utf-8', 'Not found: Cairn serves GET /healthz and GET /metrics only.\n');
    if (req.method !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed: GET only.\n', { allow: 'GET' });
    try { send(res, ...routes[path]()); }
    catch { send(res, 500, 'text/plain; charset=utf-8', 'Internal error.\n'); }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 5000;
  server.keepAliveTimeout = 5000;
  return new Promise((resolve, reject) => {
    server.once('error', (error) => reject(new CairnError(`CAIRN_HTTP_PORT: cannot listen on ${config.httpHost}:${config.httpPort} (${error.code ?? 'error'}).`)));
    server.listen(config.httpPort, config.httpHost, () => {
      log('info', 'http', { port: server.address().port, host: config.httpHost });
      const close = () => { server.close(); server.closeAllConnections(); };
      if (signal.aborted) close();
      else signal.addEventListener('abort', close, { once: true });
      resolve(server);
    });
  });
}
