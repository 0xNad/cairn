export function escapeHtml(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export function decimal(value, places) {
  const n = BigInt(value), base = 10n ** BigInt(places);
  const whole = n / base;
  if (!places) return String(whole);
  const fraction = (n % base).toString().padStart(places, '0').replace(/0+$/, '');
  return `${whole}${fraction ? '.' + fraction : ''}`;
}
export function utc(seconds) {
  return new Date(Number(seconds) * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}
// All dynamic text is escaped before splitting; split by plaintext lines, never across an HTML entity.
export function chunks(lines, limit = 4096) {
  const result = [];
  let part = '', size = 0;
  for (const line of lines) {
    const escaped = escapeHtml(line);
    const pieces = [];
    if (String(line).length <= limit) pieces.push(escaped);
    else {
      let buf = '';
      for (const char of String(line)) {
        if (buf.length + char.length > limit) { pieces.push(escapeHtml(buf)); buf = ''; }
        buf += char;
      }
      if (buf) pieces.push(escapeHtml(buf));
    }
    for (const piece of pieces) {
      // Escaped string may be longer than plaintext; length after parsing is the limit.
      const plainSize = piece.replace(/&(?:amp|lt|gt|quot);/g, '_').length;
      if (part && size + 1 + plainSize > limit) { result.push(part); part = ''; size = 0; }
      if (part) { part += '\n'; size++; }
      part += piece; size += plainSize;
    }
  }
  if (part) result.push(part);
  return result;
}
