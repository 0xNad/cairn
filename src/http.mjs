import { setTimeout as delay } from 'node:timers/promises';

export const pause = (ms, signal) => delay(Math.max(0, ms), undefined, { signal });

// Refusing redirects prevents either credential from reaching an unconfigured endpoint.
export async function post(url, body, timeoutMs, signal) {
  const response = await fetch(url, {
    method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(timeoutMs, 2147483647))]),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { response, json };
}

export function retryAfter(value) {
  if (!value) return 0;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  return Math.max(0, Date.parse(value) - Date.now()) || 0;
}

export function logger(config) {
  const levels = ['error', 'warn', 'info', 'debug'];
  return (level, event, fields = {}) => {
    if (levels.indexOf(level) > levels.indexOf(config.logLevel)) return;
    process.stderr.write(config.clean(JSON.stringify({ level, event, ...fields })) + '\n');
  };
}
