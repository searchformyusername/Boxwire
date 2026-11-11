// Declared architecture facts carried on elements: a node's semantic `kind`,
// its `cap` (capacity and declarations) and `meta`, a zone's `trust`, and an
// edge's `carries`. Shared by the
// validator, the authoring compiler and the review engine, so the three can
// never disagree about what a field means.

/**
 * Declared capacity facts on a node (`capacity` in the format, `cap` on the element).
 * Every field is optional: an undeclared fact is unknown, never a default the review invents.
 * The propagation semantics live in review/capacity.js and the guide.
 */
export const CAPACITY_FIELDS = {
  // load sources (clients): where traffic comes from
  dau: { type: 'number', min: 0, max: 1e11, unit: 'users', label: 'Daily active users' },
  writesPerUser: { type: 'number', min: 0, max: 1e6, unit: 'writes/user/day', label: 'Writes per user per day' },
  readsPerUser: { type: 'number', min: 0, max: 1e7, unit: 'reads/user/day', label: 'Reads per user per day' },
  writesPerDay: { type: 'number', min: 0, max: 1e14, unit: 'writes/day', label: 'Writes per day' },
  writesPerMonth: { type: 'number', min: 0, max: 1e15, unit: 'writes/30 days', label: 'Writes per month (30 days)' },
  readWrite: { type: 'number', min: 0, max: 1e6, unit: 'reads per write', label: 'Read:write ratio' },
  writeQps: { type: 'number', min: 0, max: 1e10, unit: 'writes/s', label: 'Write rate' },
  readQps: { type: 'number', min: 0, max: 1e10, unit: 'reads/s', label: 'Read rate' },
  peak: { type: 'number', min: 1, max: 100, unit: '× average', label: 'Peak multiplier' },
  writeKB: { type: 'number', min: 0, max: 1e7, unit: 'KB/write', label: 'Write payload' },
  readKB: { type: 'number', min: 0, max: 1e7, unit: 'KB/read', label: 'Read response' },
  // ratings and topology (everything that serves traffic)
  qpsPerNode: { type: 'number', min: 0, max: 1e9, unit: 'req/s per instance', label: 'Rated throughput' },
  replicas: { type: 'number', min: 1, max: 1e5, integer: true, unit: 'instances', label: 'Replicas' },
  shards: { type: 'number', min: 1, max: 1e5, integer: true, unit: 'partitions', label: 'Shards' },
  hitRatio: { type: 'number', min: 0, max: 1, unit: '0–1', label: 'Cache hit ratio' },
  ttlSec: { type: 'number', min: 0, max: 1e9, unit: 's (0 = never expires)', label: 'Cache TTL' },
  fanout: { type: 'number', min: 0, max: 1e7, unit: '× per input', label: 'Fan-out' },
  retentionYears: { type: 'number', min: 0, max: 1000, unit: 'years', label: 'Retention' },
  replicationFactor: { type: 'number', min: 1, max: 100, integer: true, unit: 'copies', label: 'Replication factor' },
  storageTB: { type: 'number', min: 0, max: 1e9, unit: 'TB', label: 'Storage capacity' },
  // declarations the review reads instead of guessing
  managed: { type: 'boolean', label: 'Managed, highly available service' },
  auth: { type: 'boolean', label: 'Authenticates callers' },
  public: { type: 'boolean', label: 'Deliberately public (anonymous)' },
}

/**
 * What an edge carries for capacity propagation; absent means everything its source sends on.
 * 'lookups' is one read per request the source handles (a write path that reads something).
 * 'misses' is cache-aside, declared: the reads that miss every cache the source reads (plus its
 * writes), so the store at the end is the one those caches front.
 */
export const CARRIES = ['reads', 'writes', 'lookups', 'misses']

const KIND = /^[a-z][a-z0-9-]{0,39}$/

/** Null when `cap` is a well-formed declaration object, otherwise a short reason. */
export function capProblem(cap) {
  if (cap === undefined) return null
  if (!cap || typeof cap !== 'object' || Array.isArray(cap)) return 'bad capacity'
  for (const [k, v] of Object.entries(cap)) {
    const f = Object.hasOwn(CAPACITY_FIELDS, k) ? CAPACITY_FIELDS[k] : null
    if (!f) return `unknown capacity field ${k.slice(0, 40)}`
    if (f.type === 'boolean' ? typeof v !== 'boolean' : !(typeof v === 'number' && Number.isFinite(v) && v >= f.min && v <= f.max && (!f.integer || Number.isInteger(v)))) return `bad capacity ${k}`
  }
  return null
}

/** A zone's declared trust boundary, from least to most protected. */
export const TRUST_LEVELS = ['public', 'internal', 'restricted', 'sensitive']

/** Free-form declared metadata on a node (`meta`): short strings under identifier-like keys, e.g. owner, data class. */
export const META = { maxKeys: 16, key: /^[a-z][a-zA-Z0-9_-]{0,31}$/, maxValue: 120 }

// Object.prototype names ("constructor", "toString") fit the key pattern but would shadow prototype members.
export const metaKeyOk = (k) => typeof k === 'string' && META.key.test(k) && !(k in Object.prototype)

/** Null when `meta` is a well-formed metadata object, otherwise a short reason. */
export function metaProblem(meta) {
  if (meta === undefined) return null
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return 'bad meta'
  const entries = Object.entries(meta)
  if (entries.length > META.maxKeys) return `more than ${META.maxKeys} meta keys`
  for (const [k, v] of entries) {
    if (!metaKeyOk(k)) return `bad meta key ${k.slice(0, 40)}`
    if (typeof v !== 'string' || v.length > META.maxValue) return `bad meta ${k}`
  }
  return null
}

export const trustOk = (t) => t === undefined || TRUST_LEVELS.includes(t)
export const kindOk = (kind) => kind === undefined || (typeof kind === 'string' && KIND.test(kind))
export const carriesOk = (c) => c === undefined || CARRIES.includes(c)
/** An edge's `share`: the fraction (0–1) of its source's output it carries. */
export const shareOk = (v) => v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)
