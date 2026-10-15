const ADDRESS_LIMIT = 2n ** 251n - 256n;
const FELT_LIMIT = 2n ** 251n + 17n * 2n ** 192n + 1n;

export function normalize(value, kind = 'address') {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new Error(`Invalid ${kind}: use 0x followed by 1 to 64 hexadecimal digits.`);
  }
  const n = BigInt(value);
  if (n <= 0n || n >= (kind === 'address' ? ADDRESS_LIMIT : FELT_LIMIT)) {
    throw new Error(`Invalid ${kind}: value must be nonzero and within the Starknet ${kind} range.`);
  }
  return `0x${n.toString(16).padStart(64, '0')}`;
}

export const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const short = (s) => `${s.slice(0, 6)}…${s.slice(-4)}`;
export const utc = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';

export function uint(value, bits = 256) {
  if (typeof value !== 'string' || !/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) throw new Error('invalid unsigned integer');
  const n = BigInt(value);
  if (n >= 2n ** BigInt(bits)) throw new Error('unsigned integer out of range');
  return n;
}

export function u256(parts) {
  if (!Array.isArray(parts) || parts.length !== 2) throw new Error('invalid u256 layout');
  return uint(parts[0], 128) + (uint(parts[1], 128) << 128n);
}

export function amount(n, decimals) {
  const digits = BigInt(n).toString().padStart(decimals + 1, '0');
  const whole = (decimals ? digits.slice(0, -decimals) : digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = decimals ? digits.slice(-decimals).replace(/0+$/, '') : '';
  return whole + (fraction ? '.' + fraction : '');
}

// Build messages from independent lines. Each line's HTML is balanced, so splitting never breaks a tag.
export function messages(lines) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (line.length > 4096) throw new Error('message line too long');
    if (current && current.length + 1 + line.length > 4096) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);
  return chunks;
}

// Escape after slicing raw text to avoid cutting HTML entities or surrogate pairs.
export function textLines(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    let part = '';
    for (const char of line) {
      const escaped = escapeHtml(char);
      if (part.length + escaped.length > 3500) { out.push(part); part = ''; }
      part += escaped;
    }
    out.push(part);
  }
  return out;
}
