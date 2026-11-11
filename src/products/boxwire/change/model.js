// Shared plumbing for change review: an authoring value read as entities with
// field-level values, stable edge identity, change classification, and
// applying a list of changes back onto an authoring value. Pure: no DOM, and
// the compile check uses a deterministic text measure, so node and the browser
// agree on every result.

import { RELATIONS } from '../author/vocabulary.js'
import { compileDiagram } from '../author/compile.js'
import { cached, lru, measureKey, valueKey } from './memo.js'

/** Order in which entities are listed in a diff. */
export const ENTITIES = ['diagram', 'zone', 'node', 'edge', 'frame']
export const COLLECTION = { node: 'nodes', edge: 'edges', zone: 'zones', frame: 'frames' }
const NESTED = new Set(['capacity', 'meta'])
const DIAGRAM_SKIP = new Set(['nodes', 'edges', 'zones', 'frames'])

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
export const arr = (v) => (Array.isArray(v) ? v : [])
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v)
/** Canonical JSON: key order never matters. */
export const canon = (v) => (v === undefined ? 'undefined' : JSON.stringify(sortKeys(v)))
export const same = (a, b) => canon(a) === canon(b)
export const clone = (v) => (v === undefined ? undefined : structuredClone(v))
/** Plain code-point order, identical in every engine and locale. */
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** Deterministic text measure (no canvas): layout is irrelevant to review, validity is not. */
export const STUB_MEASURE = (s, font) => s.length * Number(/(\d+)px/.exec(font)?.[1] ?? 16) * 0.55

/** Compile an authoring value: `{ errors, warnings, doc }` (`doc` only when valid). */
export function checkValue(value, { measure = STUB_MEASURE } = {}) {
  const key = valueKey(value)
  return cached(compiled, key === null ? null : `${measureKey(measure)}|${key}`, () => {
    const r = compileDiagram(value, { measure })
    return { errors: r.errors, warnings: r.warnings, doc: r.doc ?? null }
  })
}
/** Compile results by content: a review compiles the same baseline and proposal many times. */
const compiled = lru(12)

const endKey = (v) => (typeof v === 'string' ? v : isObj(v) ? `@${v.x},${v.y}` : canon(v))
/** `from->to:kind`, the identity of an edge without an id. */
export const edgeTriple = (e) => `${endKey(e.from)}->${endKey(e.to)}:${e.kind ?? 'flow'}`

/** Stable keys for one edge list: its id, else `from->to:kind` with `#2`, `#3` … for repeats. */
export function keyEdges(edges) {
  const seen = new Map()
  return arr(edges).map((e, i) => {
    if (!isObj(e)) return `edge[${i}]`
    if (typeof e.id === 'string') return e.id
    const t = edgeTriple(e)
    const n = (seen.get(t) ?? 0) + 1
    seen.set(t, n)
    return n === 1 ? t : `${t}#${n}`
  })
}

/**
 * Align `next` edges to `base` edges: matched edges share a key. Explicit ids
 * match first; then edges with the same endpoints and kind pair up in order
 * when at least one side has no id (so giving an edge an id is not a delete
 * plus an add). Then, given the compiler's generated ids (`ids.base`,
 * `ids.next`, from assignIds), an id-less edge that was reconnected or
 * re-kinded keeps its identity: still-unmatched id-less edges pair up when
 * they have the same generated id and share at least one endpoint, so moving
 * one end (or changing the kind) is a field change, not a remove plus an add.
 * Then remaining id-less edges that are each other's unique best match (a
 * shared end; or the same kind and non-empty label when both ends changed)
 * pair up too; those keys are returned in `inferred`. Unmatched next edges
 * get their own id or a fresh derived key.
 */
export function alignEdges(base, next, ids = null) {
  const b = arr(base), n = arr(next)
  const baseKeys = keyEdges(b)
  const nextKeys = new Array(n.length).fill(null)
  const used = new Set()
  const byId = new Map()
  b.forEach((e, i) => isObj(e) && typeof e.id === 'string' && !byId.has(e.id) && byId.set(e.id, i))
  n.forEach((e, j) => {
    const i = isObj(e) && typeof e.id === 'string' ? byId.get(e.id) : undefined
    if (i === undefined || used.has(i)) return
    used.add(i)
    nextKeys[j] = baseKeys[i]
  })
  // an id-less edge with the same ends, kind and generated id on both sides is the same edge, whatever moved around it
  if (ids?.base && ids?.next) {
    const exact = new Map()
    b.forEach((e, i) => {
      if (!used.has(i) && isObj(e) && e.id === undefined) exact.set(`${edgeTriple(e)}\u0000${ids.base[i]}`, i)
    })
    n.forEach((e, j) => {
      if (nextKeys[j] || !isObj(e) || e.id !== undefined) return
      const i = exact.get(`${edgeTriple(e)}\u0000${ids.next[j]}`)
      if (i === undefined || used.has(i)) return
      used.add(i)
      nextKeys[j] = baseKeys[i]
    })
  }
  const free = new Map()
  b.forEach((e, i) => {
    if (used.has(i) || !isObj(e)) return
    const t = edgeTriple(e)
    if (!free.has(t)) free.set(t, [])
    free.get(t).push(i)
  })
  n.forEach((e, j) => {
    if (nextKeys[j] || !isObj(e)) return
    const list = free.get(edgeTriple(e)) ?? []
    const k = list.findIndex((i) => b[i].id === undefined || e.id === undefined)
    if (k < 0) return
    const [i] = list.splice(k, 1)
    used.add(i)
    nextKeys[j] = baseKeys[i]
  })
  if (ids?.base && ids?.next) {
    const byGenerated = new Map()
    b.forEach((e, i) => {
      if (!used.has(i) && isObj(e) && e.id === undefined && typeof ids.base[i] === 'string') byGenerated.set(ids.base[i], i)
    })
    const end = (v) => endKey(v)
    n.forEach((e, j) => {
      // an id-less connector, or one carrying exactly the id its base counterpart compiled to (written down
      // by an edit so it would survive a shift: the same connector)
      if (nextKeys[j] || !isObj(e) || (e.id !== undefined && !byGenerated.has(e.id))) return
      const i = byGenerated.get(e.id ?? ids.next[j])
      if (i === undefined || used.has(i)) return
      if (end(b[i].from) !== end(e.from) && end(b[i].to) !== end(e.to)) return
      used.add(i)
      nextKeys[j] = baseKeys[i]
    })
  }
  // Last, among id-less edges still unmatched on both sides: a pair that is each other's unique best match
  // by what they still share is the same edge. Sharing an end counts most (a reconnect, even when the array
  // was reordered so the generated id moved); with both ends changed, the same kind and the same non-empty
  // label (and carries) must agree. Anything ambiguous (two candidates scoring the same) stays a remove plus
  // an add. These matches are inferred, and diffs say so.
  const inferred = new Set()
  {
    const end = (v) => endKey(v)
    const restB = [], restN = []
    b.forEach((e, i) => !used.has(i) && isObj(e) && e.id === undefined && restB.push(i))
    n.forEach((e, j) => !nextKeys[j] && isObj(e) && e.id === undefined && restN.push(j))
    if (restB.length && restN.length && restB.length * restN.length <= 250000) {
      const score = (x, y) => {
        const sf = end(x.from) === end(y.from), st = end(x.to) === end(y.to)
        const kind = (x.kind ?? 'flow') === (y.kind ?? 'flow')
        const label = typeof x.label === 'string' && x.label.trim() !== '' && x.label === y.label
        if (!sf && !st && !(kind && label)) return 0
        return (sf ? 4 : 0) + (st ? 4 : 0) + (kind ? 2 : 0) + (label ? 2 : 0) + ((x.carries ?? null) === (y.carries ?? null) ? 1 : 0)
      }
      const best = (list, f) => {
        let top = 0, who = -1, tie = false
        for (const k of list) {
          const v = f(k)
          if (v > top) [top, who, tie] = [v, k, false]
          else if (v === top && v > 0) tie = true
        }
        return tie ? -1 : who
      }
      for (const i of restB) {
        const j = best(restN, (y) => score(b[i], n[y]))
        if (j < 0 || nextKeys[j]) continue
        if (best(restB, (x) => (used.has(x) ? 0 : score(b[x], n[j]))) !== i) continue
        used.add(i)
        nextKeys[j] = baseKeys[i]
        inferred.add(baseKeys[i])
      }
    }
  }
  const taken = new Set(baseKeys)
  n.forEach((e, j) => {
    if (nextKeys[j]) return
    let key = !isObj(e) ? `edge[${j}]` : typeof e.id === 'string' ? e.id : edgeTriple(e)
    if (!isObj(e) || typeof e.id !== 'string') {
      const root = key
      for (let c = 2; taken.has(key); c++) key = `${root}#${c}`
    }
    taken.add(key)
    nextKeys[j] = key
  })
  return { baseKeys, nextKeys, inferred }
}

/** An element's fields, flattened: `capacity.x`, `meta.x`, `contains.<member>` (true), `positions.<id>`. */
export function flatten(obj, entity) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (entity === 'diagram' && DIAGRAM_SKIP.has(k)) continue
    if (k === 'id' && entity !== 'edge' && entity !== 'diagram') continue
    if ((NESTED.has(k) || (entity === 'diagram' && k === 'positions')) && isObj(v)) for (const [s, sv] of Object.entries(v)) out[`${k}.${s}`] = sv
    else if (k === 'contains' && Array.isArray(v) && (entity === 'zone' || entity === 'frame')) for (const m of v) out[`contains.${m}`] = true
    else out[k] = v
  }
  return out
}

/**
 * Index an authoring value: Map<`entity:key`, { entity, key, obj, fields, index }>.
 * `obj` is the object inside `value` itself (not a copy), so callers can mutate it.
 */
export function entities(value, edgeKeys = keyEdges(value?.edges)) {
  const v = isObj(value) ? value : {}
  const out = new Map([['diagram:diagram', { entity: 'diagram', key: 'diagram', obj: v, fields: flatten(v, 'diagram'), index: 0 }]])
  for (const entity of ['zone', 'node', 'frame']) {
    arr(v[COLLECTION[entity]]).forEach((o, index) => {
      if (isObj(o) && typeof o.id === 'string' && !out.has(`${entity}:${o.id}`)) out.set(`${entity}:${o.id}`, { entity, key: o.id, obj: o, fields: flatten(o, entity), index })
    })
  }
  arr(v.edges).forEach((o, index) => {
    if (isObj(o)) out.set(`edge:${edgeKeys[index]}`, { entity: 'edge', key: edgeKeys[index], obj: o, fields: flatten(o, 'edge'), index })
  })
  return out
}

// Field classes. Anything not listed is semantic: an unrecognised change is never hidden as cosmetic.
const LAYOUT = {
  node: new Set(['x', 'y', 'w', 'h', 'rank']),
  edge: new Set(['fromSide', 'toSide', 'route']),
  zone: new Set(['padding']),
  diagram: new Set(['layout', 'direction']),
}
const PRESENTATION = {
  node: new Set(['color', 'fill', 'dash', 'textSize', 'font', 'align', 'icon']),
  edge: new Set(['color', 'width', 'head', 'tail', 'dash']),
  zone: new Set(['color']),
  diagram: new Set(['name', '$schema', 'strokes']),
}
const ARCH_HEADS = new Set(['none', 'arrow', 'open'])

/** What review/graph.js reads from an edge's arrowheads and dash: graph membership, direction, sync/async. */
export function edgeMode(e) {
  if (!isObj(e)) return ''
  const rel = RELATIONS[e.kind ?? 'flow'] ?? RELATIONS.flow
  const head = e.head ?? rel.head, tail = e.tail ?? rel.tail, dash = e.dash ?? rel.dash
  return [ARCH_HEADS.has(head) && ARCH_HEADS.has(tail), head === 'none' && tail !== 'none', dash === 'dashed'].join('|')
}

/**
 * 'semantic' | 'layout' | 'presentation' | 'identity' for one change. Edge head, tail and
 * dash are presentation unless they change what the typed graph reads
 * (direction or sync/async), in which case they are semantic. Writing an
 * edge's id (pinning the one the compiler generated, or naming it) is
 * identity: it is neither where things sit nor what the model says.
 */
export function classify(entity, type, field, before, after) {
  if (entity === 'frame') return 'presentation'
  if (type !== 'change') return 'semantic'
  if (entity === 'edge' && field === 'id') return 'identity'
  if (field.startsWith('positions.')) return 'layout'
  if (LAYOUT[entity]?.has(field)) return 'layout'
  if (PRESENTATION[entity]?.has(field)) {
    if (entity === 'edge' && ['head', 'tail', 'dash'].includes(field) && edgeMode(before) !== edgeMode(after)) return 'semantic'
    return 'presentation'
  }
  return 'semantic'
}

/** Set (or, with `undefined`, delete) one flattened field on an element object. */
export function setField(obj, field, value) {
  const dot = field.indexOf('.')
  const head = dot > 0 ? field.slice(0, dot) : field
  if (dot > 0 && head === 'contains') {
    const member = field.slice(dot + 1)
    const list = Array.isArray(obj.contains) ? obj.contains : (obj.contains = [])
    const at = list.indexOf(member)
    if (value === true && at < 0) list.push(member)
    else if (value !== true && at >= 0) list.splice(at, 1)
    return
  }
  if (dot > 0 && (NESTED.has(head) || head === 'positions')) {
    const sub = field.slice(dot + 1)
    if (value === undefined) {
      if (!isObj(obj[head])) return
      delete obj[head][sub]
      if (!Object.keys(obj[head]).length) delete obj[head]
    } else {
      if (!isObj(obj[head])) obj[head] = {}
      obj[head][sub] = clone(value)
    }
    return
  }
  if (value === undefined) delete obj[field]
  else obj[field] = clone(value)
}

/**
 * Apply changes (keyed against `base`, as diffModels produces them) to a copy
 * of `base`. Removals and field edits locate elements by stable key; additions
 * are inserted after their `anchor` (the sibling before them in the proposal).
 */
export function applyChanges(base, changes) {
  const out = isObj(base) ? clone(base) : {}
  const index = entities(out)
  const keyOf = new Map([...index.values()].map((e) => [e.obj, e.key]))
  const removed = new Set()
  for (const c of changes) {
    if (c.type !== 'remove') continue
    const e = index.get(`${c.entity}:${c.key}`)
    if (e) removed.add(e.obj)
  }
  const targets = changes.filter((c) => c.type === 'change').map((c) => [c, index.get(`${c.entity}:${c.key}`)])
  for (const [c, e] of targets) if (e && !removed.has(e.obj)) setField(e.obj, c.field, c.after)
  for (const coll of Object.values(COLLECTION)) if (Array.isArray(out[coll])) out[coll] = out[coll].filter((o) => !removed.has(o))
  const adds = changes.filter((c) => c.type === 'add').sort((a, b) => ENTITIES.indexOf(a.entity) - ENTITIES.indexOf(b.entity) || (a.index ?? 0) - (b.index ?? 0))
  for (const c of adds) {
    const coll = COLLECTION[c.entity]
    const list = Array.isArray(out[coll]) ? out[coll] : (out[coll] = [])
    const obj = clone(c.after)
    const at = c.anchor == null ? -1 : list.findIndex((o) => keyOf.get(o) === c.anchor)
    if (c.anchor != null && at < 0) list.push(obj)
    else list.splice(at + 1, 0, obj)
    keyOf.set(obj, c.key)
  }
  return out
}

/** Every element id an authoring value declares (nodes, zones, edges, frames, strokes). */
export function elementIds(value) {
  const v = isObj(value) ? value : {}
  const ids = new Set()
  for (const coll of ['nodes', 'zones', 'edges', 'frames', 'strokes']) for (const o of arr(v[coll])) if (isObj(o) && typeof o.id === 'string') ids.add(o.id)
  return ids
}

/**
 * A copy of `value` whose id-less edges carry the ids the compiler would
 * generate for them (e1, e2 … skipping taken ids, in edge order), so graph
 * edge ids map back to authoring edges exactly.
 */
export function withEdgeIds(value) {
  if (!isObj(value) || !Array.isArray(value.edges)) return value
  const ids = elementIds(value)
  let n = 1
  const edges = value.edges.map((e) => {
    if (!isObj(e) || e.id !== undefined) return e
    while (ids.has(`e${n}`)) n++
    ids.add(`e${n}`)
    return { id: `e${n++}`, ...e }
  })
  return { ...value, edges }
}
