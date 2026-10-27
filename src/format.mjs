export const escapeHtml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const unescapeHtml = (value) => String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
/** An exact decimal of a base-unit BigInt: grouped integer part, trailing zeros trimmed. */
export function decimal(value, decimals) {
  const scale = 10n ** BigInt(decimals);
  const whole = (value / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = decimals === 0 ? '' : (value % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}
export const amount = (value, decimals, symbol) => `${decimal(value, decimals)} ${symbol}`;
/** US dollars from cents (round 3): $1,234.57, or <$0.01 for a value above zero that rounds to no cent. */
export function dollars(cents, aboveZero = cents > 0n) {
  if (cents === 0n && aboveZero) return '<$0.01';
  return `$${decimal(cents / 100n, 0)}.${(cents % 100n).toString().padStart(2, '0')}`;
}
/**
 * Base units from a decimal a person typed ("1000000", "2.000001", "1,000.5"), or a reason. No sign, no
 * exponent, no more fraction digits than the token has, and below 2^256.
 */
export function parseDecimal(text, decimals) {
  const value = String(text ?? '').trim();
  const match = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return { error: `${value ? `"${value.slice(0, 40)}" is not` : 'Give'} an amount: use digits and an optional decimal point, such as 1000 or 2.5.` };
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  if (fraction.length > decimals) return { error: `This token has ${decimals} decimal${decimals === 1 ? '' : 's'}: use at most ${decimals} digit${decimals === 1 ? '' : 's'} after the point.` };
  const units = BigInt(match[1].replaceAll(',', '')) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (units >= 1n << 256n) return { error: 'That amount is above the largest token amount (2^256 − 1 base units).' };
  return { units, text: decimal(units, decimals).replaceAll(',', '') };
}
export const short = (value) => `${value.slice(0, 6)}…${value.slice(-4)}`;
export const utc = (seconds) => new Date(seconds * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
/** A symbol or label from outside, safe to show: no control or format characters, at most `max` characters. */
export function plainText(value, max) {
  const text = String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(text).slice(0, max).join('').trim();
}
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
  const add = (line) => {
    if (current.length + line.length + 1 > 4096) { result.push(current); current = ''; }
    current += `${current ? '\n' : ''}${line}`;
  };
  for (const line of lines) {
    // A line too long for one message (an outside string left unbounded) goes as plain text in pieces,
    // never cut inside a tag or an entity, rather than stopping the bot.
    if (line.length > 4096) for (const piece of textLines(unescapeHtml(line.replace(/<[^>]*>/g, '')), String)) add(piece);
    else add(line);
  }
  if (current) result.push(current);
  return result;
}
/** Links and names every reply builds the same way. */
export function links(config, clean) {
  const href = (kind, value) => escapeHtml(clean(`${config.explorer}/${kind}/${value}`));
  const link = (kind, value, text = short(value)) => `<a href="${href(kind, value)}">${text}</a>`;
  return {
    link,
    contract: (address, text) => link('contract', address, text),
    tx: (hash, text) => link('tx', hash, text),
    /** A token as a reader sees it: a registry symbol, or an unverified symbol in code with its contract linked. */
    token: (token) => token.verified ? escapeHtml(token.symbol)
      : `<code>${escapeHtml(token.symbol)}</code> (unverified, ${link('contract', token.address)})`,
  };
}
