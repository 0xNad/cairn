export const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const short = (hex) => `${hex.slice(0, 6)}…${hex.slice(-4)}`;
export const link = (url, label) => `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;

export function amount(value, decimals, symbol) {
  const number = BigInt(value);
  if (number < 0n) throw new Error('A token amount must be unsigned.');
  const scale = 10n ** BigInt(decimals);
  const integer = (number / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = decimals ? (number % scale).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${integer}${fraction ? '.' + fraction : ''} ${symbol}`;
}

export function u256(felts) {
  if (!Array.isArray(felts) || felts.length !== 2) throw new Error('Expected two u128 limbs.');
  const [low, high] = felts.map(BigInt);
  if ([low, high].some((v) => v < 0n || v >= 2n ** 128n)) throw new Error('Invalid u128 limb.');
  return low + high * 2n ** 128n;
}

export function time(timestamp) {
  return new Date(timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

// Escape before measuring, and break only between complete Unicode characters and HTML entities.
// A huge single-line revert can be split without cutting a tag or making invalid Telegram HTML.
export function outsideLines(text) {
  const lines = [];
  for (const line of String(text).split(/\r?\n/)) {
    let chunk = '';
    for (const char of line) {
      const escaped = escapeHtml(char);
      if (chunk.length + escaped.length > 3500) { lines.push(chunk); chunk = ''; }
      chunk += escaped;
    }
    lines.push(chunk);
  }
  return lines;
}

export function messages(lines) {
  const parts = [];
  let current = '';
  for (const line of lines) {
    if (line.length > 4096) throw new Error('Reply line exceeds the Telegram limit.');
    if (current.length + line.length + (current ? 1 : 0) > 4096) { parts.push(current); current = ''; }
    current += (current ? '\n' : '') + line;
  }
  if (current) parts.push(current);
  return parts;
}
