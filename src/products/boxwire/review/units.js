// Number formatting with visible units, shared by the capacity panel, the
// canvas overlay and the formulas the review shows. Decimal (SI) prefixes
// throughout: 1 KB = 1000 bytes, 1 TB = 10^9 KB.

const SI = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k']]

/** 3 significant figures, trailing zeros dropped: 38.58 → "38.6", 3858 → "3.86k". */
export function compact(v) {
  if (!Number.isFinite(v)) return '∞'
  const a = Math.abs(v)
  for (const [k, p] of SI) if (a >= k) return trim(v / k) + p
  return trim(v)
}
const trim = (v) => String(Number(v.toPrecision(3)))

/** Grouped integer or 3 s.f. for small values, for formulas: 86400 → "86,400". */
export function exact(v) {
  if (!Number.isFinite(v)) return '∞'
  return Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : trim(v)
}

export const rate = (v) => `${compact(v)}/s`
const BYTE_UNITS = [[1e9, 'TB'], [1e6, 'GB'], [1e3, 'MB'], [1, 'KB']]
/** Sizes held in KB. */
export function size(kb) {
  if (!Number.isFinite(kb)) return '∞'
  for (const [k, u] of BYTE_UNITS) if (Math.abs(kb) >= k) return `${trim(kb / k)} ${u}`
  return `${Math.round(kb * 1000)} B`
}
export const bandwidth = (kbps) => `${size(kbps)}/s`
export const percent = (v) => `${Math.round(v * 100)}%`

/** An interval [lo, hi] in a given formatter: a point, an upper bound, or a range. */
export function range([lo, hi], fmt = compact) {
  if (lo === hi) return fmt(lo)
  if (!Number.isFinite(hi)) return `≥ ${fmt(lo)}`
  if (lo === 0) return `≤ ${fmt(hi)}`
  return `${fmt(lo)}–${fmt(hi)}`
}
