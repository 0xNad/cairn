export const escapeHtml = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export const short = hex => `${hex.slice(0, 6)}…${hex.slice(-4)}`;

export function unsigned(value, bits = 256) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value) || value.length > 2 + Math.ceil(bits / 4)) throw new Error('Invalid node amount');
  const n = BigInt(value);
  if (n >= 2n ** BigInt(bits)) throw new Error('Invalid node amount');
  return n;
}
export function u256(felts) {
  if (!Array.isArray(felts) || felts.length !== 2) throw new Error('Invalid node balance');
  return unsigned(felts[0], 128) + (unsigned(felts[1], 128) << 128n);
}
export function amount(n, decimals) {
  const scale = 10n ** BigInt(decimals);
  const whole = n / scale;
  const fraction = (n % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}
export function utc(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error('Invalid block time');
  return new Date(seconds * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

// Split outside text before escaping, so neither entities, tags nor surrogate pairs get cut.
// Every line has its own markup. Long single lines are the only case split away from a newline.
export function messages(lines, redact) {
  const result = [];
  let html = '', length = 0;
  for (const item of lines) {
    const line = typeof item === 'string' ? { text: item } : item;
    for (const raw of redact(line.text).toWellFormed().split('\n')) {
      const pieces = [];
      let piece = '';
      for (const char of raw) {
        if (piece.length + char.length > 4096) { pieces.push(piece); piece = ''; }
        piece += char;
      }
      pieces.push(piece);
      for (const text of pieces) {
        if (length + (html ? 1 : 0) + text.length > 4096) { result.push(html); html = ''; length = 0; }
        let rendered = escapeHtml(text);
        if (line.href) rendered = `<a href="${escapeHtml(redact(line.href))}">${rendered}</a>`;
        else if (line.bold && text) rendered = `<b>${rendered}</b>`;
        if (html) { html += '\n'; length++; }
        html += rendered; length += text.length;
      }
    }
  }
  if (html.trim()) result.push(html);
  return result;
}
