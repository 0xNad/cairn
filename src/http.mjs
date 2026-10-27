import { createServer } from 'node:http';

/** Read-only snapshots of the single pass; handlers never contact either service. */
export function httpHandler(snapshot) {
  return (req, res) => {
    const s = snapshot();
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(s.reason ? 503 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(s.reason ? { ok: false, reason: s.reason } : { ok: true, head: s.head, lag_s: s.lag }));
    } else if (req.method === 'GET' && req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      const values = { head_block: s.head ?? 0, updates_total: s.updates, messages_sent_total: s.sent, alerts_total: s.alerts, rpc_errors_total: s.errors };
      res.end(Object.entries(values).map(([key, value]) => `# TYPE cairn_${key} ${key.endsWith('_total') ? 'counter' : 'gauge'}\ncairn_${key} ${value}\n`).join(''));
    } else { res.writeHead(404); res.end(); }
  };
}

export async function startHttp(config, snapshot) {
  if (config.httpPort === null || config.httpPort === undefined) return null;
  const server = createServer(httpHandler(snapshot));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.httpPort, config.httpHost, resolve); });
  process.stderr.write(`${JSON.stringify({ level: 'info', event: 'http', port: server.address().port })}\n`);
  return server;
}
