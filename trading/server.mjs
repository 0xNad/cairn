import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createHandler, createService } from './lib/service.mjs';
const handler = createHandler(createService({ rpcUrls: (process.env.CAIRN_TRADING_RPC_URLS ?? 'https://starknet-rpc.publicnode.com').split(','), version: process.env.CAIRN_RELEASE ?? 'local' }));
const root = resolve(import.meta.dirname, 'dist');
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Cache-Control','no-store');
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      let data = ''; for await (const chunk of req) { data += chunk; if (data.length > 2048) { res.writeHead(413); return res.end(); } }
      const value = await handler(url.pathname.slice(5), JSON.parse(data || '{}'), req.socket.remoteAddress);
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(value));
    }
    const path = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
    if (!path.startsWith(root + '/')) { res.writeHead(404); return res.end(); }
    const data = await readFile(path); res.setHeader('Content-Type', {'.html':'text/html','.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml'}[extname(path)] ?? 'application/octet-stream'); res.end(data);
  } catch (e) { res.writeHead(e.status ?? 400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:e.status ? e.message : 'Request unavailable.'})); }
});
server.listen(Number(process.env.PORT ?? 8487), '127.0.0.1', () => console.log('Cairn trading listening on localhost:' + server.address().port));
