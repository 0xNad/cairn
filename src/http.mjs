import { createServer } from 'node:http';
import { CairnError, log } from './errors.mjs';

// Round 4's operations endpoint, only with CAIRN_HTTP_PORT set, on CAIRN_HTTP_HOST (127.0.0.1 unless the
// operator says otherwise): GET /healthz and GET /metrics, nothing else (404; 405 for another method on them).
// It only reads what the bot's pass already knows; it never calls Telegram or the chain itself.

const JSON_TYPE = 'application/json; charset=utf-8', TEXT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/**
 * Prometheus text from [{ name, help, type, value, labels }]; a metric whose value is null is left out.
 * Only numbers and fixed label values are exposed: no URL, chat or address.
 */
export function prometheus(metrics) {
  const out = [];
  for (const m of metrics) {
    const samples = (Array.isArray(m.value) ? m.value : [{ value: m.value }]).filter((s) => Number.isFinite(s.value));
    if (!samples.length) continue;
    out.push(`# HELP ${m.name} ${m.help}`, `# TYPE ${m.name} ${m.type}`);
    for (const s of samples) {
      const labels = s.labels ? `{${Object.entries(s.labels).map(([k, v]) => `${k}="${v}"`).join(',')}}` : '';
      out.push(`${m.name}${labels} ${s.value}`);
    }
  }
  return `${out.join('\n')}\n`;
}

/**
 * Starts the server: `health()` gives { ok, head, lag_s } or { ok: false, reason }, `metrics()` the Prometheus
 * text. Resolves with the server once it listens, and logs {"event":"http","host","port"} (the port it got, for
 * CAIRN_HTTP_PORT=0). A port it cannot bind exits 2.
 */
export function serveHttp(config, { health, metrics }) {
  const server = createServer((req, res) => {
    const send = (status, type, body, headers = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
      res.end(body);
    };
    let path;
    try { path = new URL(req.url ?? '/', 'http://cairn').pathname; } catch { return send(400, JSON_TYPE, '{"ok":false,"reason":"bad request"}'); }
    if (path !== '/healthz' && path !== '/metrics') return send(404, JSON_TYPE, '{"ok":false,"reason":"not found"}');
    if (req.method !== 'GET') return send(405, JSON_TYPE, '{"ok":false,"reason":"method not allowed"}', { allow: 'GET' });
    try {
      if (path === '/metrics') return send(200, TEXT_TYPE, metrics());
      const h = health();
      return send(h.ok ? 200 : 503, JSON_TYPE, JSON.stringify(h));
    } catch {
      return send(500, JSON_TYPE, '{"ok":false,"reason":"internal"}');
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  return new Promise((resolve, reject) => {
    server.once('error', (error) => reject(new CairnError(`CAIRN_HTTP_PORT: cannot listen on ${config.httpHost}:${config.httpPort} (${error.code ?? 'error'}).`, 2)));
    server.listen(config.httpPort, config.httpHost, () => {
      server.removeAllListeners('error');
      server.on('error', () => { /* a broken client connection never stops the bot */ });
      server.unref();
      log('info', 'http', { host: config.httpHost, port: server.address().port });
      resolve(server);
    });
  });
}
