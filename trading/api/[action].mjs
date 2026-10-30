import { createHandler, createService } from '../lib/service.mjs';
const handler = createHandler(createService({ rpcUrls: (process.env.CAIRN_TRADING_RPC_URLS ?? 'https://starknet-rpc.publicnode.com').split(',').map(s => s.trim()), version: process.env.VERCEL_GIT_COMMIT_SHA || process.env.CAIRN_RELEASE || '0.1.0' }));
export default async function api(req, res) {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST' || (req.headers['content-type'] ?? '').split(';')[0] !== 'application/json') return res.status(405).json({ error: 'Use POST with JSON.' });
  // Browser requests must originate here. No arbitrary origins or generic RPC forwarding.
  try {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'Use the Cairn trading website.' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (JSON.stringify(body ?? {}).length > 2048) return res.status(413).json({ error: 'Request too large.' });
    const result = await handler(req.query.action, body ?? {}, req.headers['x-forwarded-for']?.split(',')[0] ?? 'unknown');
    return res.status(200).json(result);
  } catch (e) { return res.status(e.status ?? 400).json({ error: e.status ? e.message : 'Invalid request.' }); }
}
