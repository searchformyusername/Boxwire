// Per-revision caches for change review. A review compiles and evaluates the
// same baseline and proposal several times (the diff, the accepted subset,
// each checkbox the reviewer toggles), and at 1,400 nodes each compile and
// rule evaluation costs tens of milliseconds. These caches are keyed by
// content, never by object identity, so a value mutated after it was cached
// can't return a stale answer: source texts by their exact text, authoring
// values by their JSON text (which every input here round-trips through).
// Pure functions only; a hit returns exactly what a miss would compute.

const registry = new Set()
/** Empty every review cache (measurements of a cold review use this). */
export const clearCaches = () => registry.forEach((c) => c.clear())

/** A small least-recently-used map. */
export function lru(limit) {
  const map = new Map()
  const cache = {
    get(key) {
      if (!map.has(key)) return undefined
      const v = map.get(key)
      map.delete(key)
      map.set(key, v)
      return v
    },
    set(key, v) {
      map.delete(key)
      map.set(key, v)
      while (map.size > limit) map.delete(map.keys().next().value)
      return v
    },
    clear: () => map.clear(),
    get size() { return map.size },
  }
  registry.add(cache)
  return cache
}

const measures = new WeakMap()
let nextMeasure = 1
/** A stable small id for a measure function, so it can be part of a cache key. */
export function measureKey(fn) {
  if (typeof fn !== 'function') return '0'
  if (!measures.has(fn)) measures.set(fn, String(nextMeasure++))
  return measures.get(fn)
}

/** Content key of an authoring value (null when it can't be serialised, which disables caching for it). */
export function valueKey(value) {
  try {
    return JSON.stringify(value) ?? 'undefined'
  } catch {
    return null
  }
}

const stats = { hits: 0, misses: 0 }
/** Cache counters, for tests and measurements. */
export const memoStats = () => ({ ...stats })

/** `cache.get(key) ?? cache.set(key, compute())`, counted; a null key skips the cache. */
export function cached(cache, key, compute) {
  if (key === null) return compute()
  const hit = cache.get(key)
  if (hit !== undefined) {
    stats.hits++
    return hit
  }
  stats.misses++
  return cache.set(key, compute())
}

/** Deep-freeze a parsed JSON value so a cached one can't be changed under its other users. */
export function freeze(v) {
  if (v === null || typeof v !== 'object' || Object.isFrozen(v)) return v
  Object.freeze(v)
  for (const k of Object.keys(v)) freeze(v[k])
  return v
}
