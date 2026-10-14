export const ADDRESS_MAX = (1n << 251n) - 256n;
export const FELT_MAX = (1n << 251n) + 17n * (1n << 192n) + 1n;

export function normalizeFelt(value, kind = 'address') {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new Error(`Invalid ${kind}`);
  const n = BigInt(value);
  if (n <= 0n || n >= (kind === 'address' ? ADDRESS_MAX : FELT_MAX)) throw new Error(`Invalid ${kind}`);
  return `0x${n.toString(16).padStart(64, '0')}`;
}
export function shortFelt(value) { return `${value.slice(0, 6)}…${value.slice(-4)}`; }
export function uint256(felts) {
  if (!Array.isArray(felts) || felts.length < 2) throw new Error('Invalid u256');
  const [lo, hi] = felts.map(BigInt);
  if (lo < 0n || hi < 0n || lo >= (1n << 128n) || hi >= (1n << 128n)) throw new Error('Invalid u256');
  return lo + (hi << 128n);
}
