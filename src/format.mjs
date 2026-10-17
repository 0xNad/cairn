export const escapeHtml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function amount(value, decimals, symbol) {
  const scale = 10n ** BigInt(decimals);
  const whole = (value / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = decimals === 0 ? '' : (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} ${symbol}`;
}
export const short = (value) => `${value.slice(0, 6)}…${value.slice(-4)}`;
export const utc = (seconds) => new Date(seconds * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
export function redactor(config) {
  const rpc = new URL(config.rpcUrl);
  const secrets = [config.token, config.token.split(':')[1], config.rpcUrl,
    ...rpc.pathname.split('/').filter(Boolean), ...rpc.searchParams.values()].filter((x) => x.length >= 4);
  return (value) => {
    let text = String(value);
    for (const secret of secrets) {
      let decoded = secret;
      try { decoded = decodeURIComponent(secret); } catch { /* A literal percent is a valid URL path byte. */ }
      for (const variant of new Set([secret, decoded, encodeURIComponent(secret)])) text = text.replaceAll(variant, '[redacted]');
    }
    return text;
  };
}
// Each fragment is a valid HTML line. Cut long outside strings before escaping so entities,
// surrogate pairs and tags stay intact; a conservative source-length cap also fits Telegram.
export function textLines(text, clean) {
  const lines = [];
  for (const line of clean(text).split('\n')) {
    let chunk = '';
    for (const character of line) {
      const escaped = escapeHtml(character);
      if (chunk.length + escaped.length > 3000) { lines.push(chunk); chunk = ''; }
      chunk += escaped;
    }
    lines.push(chunk);
  }
  return lines;
}
export function messages(lines) {
  const result = [];
  let current = '';
  for (const line of lines) {
    if (line.length > 4096) throw new Error('HTML line exceeds message size');
    if (current.length + line.length + 1 > 4096) { result.push(current); current = ''; }
    current += `${current ? '\n' : ''}${line}`;
  }
  if (current) result.push(current);
  return result;
}
