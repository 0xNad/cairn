import { FIELD, normalize, SELECTORS, unsigned } from './felt.mjs';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789-';
export const NAME_TTL = 3600;

export function encodeLabel(label) {
  if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid name: use one lowercase label of letters, digits or hyphens before .stark.');
  if (label.length > 50) throw new Error('Invalid name: label is too long.');
  let value = 0n, power = 1n;
  for (let i = 0; i < label.length; i++, power *= 38n) value += BigInt(i === label.length - 1 && label[i] === 'a' ? 37 : ALPHABET.indexOf(label[i])) * power;
  if (value >= FIELD) throw new Error('Invalid name: encoded label is too long for a felt.');
  return `0x${value.toString(16)}`;
}

// Starknet ID's base-38 escape and trailing extra-character rules (starknetid.js, MIT).
export function decodeLabel(value) {
  let felt = unsigned(value, FIELD), decoded = '';
  while (felt !== 0n) {
    const code = felt % 38n; felt /= 38n;
    if (code === 37n) {
      if (felt / 3n === 0n) {
        const next = Number(felt % 3n); decoded += next === 0 ? 'a' : '这来'[next - 1]; felt = 0n;
      } else { decoded += '这来'[Number(felt % 2n)]; felt /= 2n; }
    } else decoded += ALPHABET[Number(code)];
  }
  const suffix = /来+$/.exec(decoded)?.[0].length ?? 0;
  if (suffix) decoded = decoded.slice(0, -suffix) + (suffix % 2 === 0 ? '来'.repeat(suffix / 2 - 1) + '这b' : '来'.repeat((suffix - 1) / 2 + 1));
  return decoded;
}

export class Names {
  constructor(config, store, rpc) { this.contract = config.contracts?.naming; this.store = store; this.rpc = rpc; this.reset(); }
  reset() { this.verified = new Map(); }
  call(selector, calldata) {
    return this.rpc.call('starknet_call', { request: { contract_address: this.contract, entry_point_selector: selector, calldata }, block_id: 'latest' });
  }
  async address(value) {
    if (/^0x/i.test(value)) return normalize(value);
    if (!value.endsWith('.stark')) return normalize(value);
    const label = value.slice(0, -6), encoded = encodeLabel(label);
    if (!this.contract) throw new Error('Names are unavailable: no naming contract is configured.');
    try {
      const a = await this.call(SELECTORS.domain_to_address, ['0x1', encoded, '0x0']);
      if (!Array.isArray(a) || a.length !== 1 || BigInt(a[0]) === 0n) throw new Error();
      return normalize(a[0]);
    } catch { throw new Error('Unknown name or naming lookup unavailable.'); }
  }
  async reverse(address, now) {
    if (!this.contract) return null;
    if (!this.verified.has(address)) this.verified.set(address, this.lookup(address, now));
    return this.verified.get(address);
  }
  async lookup(address, now) {
    try {
      const cached = this.store.sql('SELECT labels, checked_at FROM names WHERE address = ?').get(address);
      let labels;
      if (cached && now - cached.checked_at < NAME_TTL) labels = JSON.parse(cached.labels);
      else {
        const a = await this.call(SELECTORS.address_to_domain, [address, '0x0']);
        if (!Array.isArray(a) || a.length < 2 || unsigned(a[0]) !== BigInt(a.length - 1) || a.length > 11) return null;
        labels = a.slice(1);
      }
      const decoded = labels.map(decodeLabel);
      if (decoded.some(l => !l)) return null;
      // Even a cached reverse candidate is forward-verified each pass before it is displayed.
      const forward = await this.call(SELECTORS.domain_to_address, [`0x${labels.length.toString(16)}`, ...labels, '0x0']);
      if (forward?.length !== 1 || normalize(forward[0]) !== address) return null;
      this.store.transaction(() => this.store.sql(`INSERT INTO names VALUES (?, ?, ?) ON CONFLICT(address)
        DO UPDATE SET labels = excluded.labels, checked_at = excluded.checked_at`).run(address, JSON.stringify(labels), cached && now - cached.checked_at < NAME_TTL ? cached.checked_at : now));
      return decoded.join('.') + '.stark';
    } catch { return null; }
  }
}
