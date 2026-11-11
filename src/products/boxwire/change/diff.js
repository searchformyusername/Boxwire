// Semantic diff of two `boxwire-diagram` authoring values by stable id. Nodes,
// zones and frames are identified by `id`; edges by `id`, else by
// `from->to:kind` (see model.js), so a renamed label is one field change and
// giving an edge an id is not a delete plus an add. Every change is classified
// as semantic (the declared architecture), layout (where things sit),
// presentation (how they look) or identity (an edge's id written down), so a
// tidy-up never reads as a redesign and an id pin never reads as a move.

import { ENTITIES, alignEdges, arr, canon, classify, clone, cmp, entities, isObj } from './model.js'
import { assignIds } from '../author/compile.js'

const TYPE_RANK = { remove: 0, add: 1, change: 2 }

/** Change id: `entity:key[:field]`, or `diagram:field` for top-level fields. */
export const changeId = (entity, key, field) => (entity === 'diagram' ? `diagram:${field}` : field ? `${entity}:${key}:${field}` : `${entity}:${key}`)

const firstLine = (s) => (typeof s === 'string' ? s.split('\n').find((l) => l.trim())?.trim() : undefined)

function labeller(a, b) {
  const nodes = new Map()
  for (const v of [a, b]) for (const coll of ['nodes', 'zones']) for (const o of arr(v?.[coll])) if (isObj(o) && typeof o.id === 'string') nodes.set(o.id, o)
  const of = (o) => firstLine(o?.label) ?? firstLine(o?.name) ?? o?.id
  const end = (v) => (typeof v === 'string' ? of(nodes.get(v)) ?? v : isObj(v) ? `(${v.x}, ${v.y})` : '?')
  return {
    element: (id) => of(nodes.get(id)) ?? id,
    of(entity, obj, key) {
      if (entity === 'edge') return `${end(obj?.from)} → ${end(obj?.to)}`
      if (entity === 'diagram') return firstLine(obj?.name) ?? 'diagram'
      return of(obj) ?? key
    },
  }
}

/** The change classes, in the order they are listed. */
export const CLASSES = ['semantic', 'layout', 'presentation', 'identity']

/**
 * Diff two authoring values. Returns `{ semantic, layout, presentation, identity }`, each
 * a deterministic list of Change:
 * `{ id, type: 'add'|'remove'|'change', entity, key, field?, before?, after?, class, label, labelBefore?, refLabel?, anchor?, index? }`.
 * `label` is the element's display label (`labelBefore` too for an edge reconnect);
 * `refLabel` the member or positioned element for `contains.*` / `positions.*` fields; `anchor` (additions) is the
 * key of the sibling before it in `next`, or null.
 */
export function diffModels(base, next) {
  const b = isObj(base) ? base : {}, n = isObj(next) ? next : {}
  const generatedA = assignIds(b).edges, generatedB = assignIds(n).edges
  const { baseKeys, nextKeys, inferred } = alignEdges(b.edges, n.edges, { base: generatedA, next: generatedB })
  const A = entities(b, baseKeys), B = entities(n, nextKeys)
  const L = labeller(b, n)
  const out = { semantic: [], layout: [], presentation: [], identity: [] }
  const push = (c) => out[c.class].push(c)
  const anchors = new Map()
  for (const entity of ['zone', 'node', 'edge', 'frame']) {
    let prev = null
    for (const e of [...B.values()].filter((x) => x.entity === entity).sort((x, y) => x.index - y.index)) {
      anchors.set(`${entity}:${e.key}`, prev)
      prev = e.key
    }
  }
  for (const k of new Set([...A.keys(), ...B.keys()])) {
    const a = A.get(k), z = B.get(k)
    const { entity, key } = a ?? z
    if (!a || !z) {
      const type = a ? 'remove' : 'add'
      const obj = (a ?? z).obj
      push({
        id: changeId(entity, key), type, entity, key, ...(a ? { before: clone(obj) } : { after: clone(obj) }), class: classify(entity, type), label: L.of(entity, obj, key),
        ...(z && { anchor: anchors.get(k) ?? null, index: z.index }),
      })
      continue
    }
    for (const field of new Set([...Object.keys(a.fields), ...Object.keys(z.fields)])) {
      const before = a.fields[field], after = z.fields[field]
      if (canon(before) === canon(after)) continue
      const ref = field.startsWith('contains.') ? field.slice(9) : field.startsWith('positions.') ? field.slice(10) : null
      push({
        id: changeId(entity, key, field), type: 'change', entity, key, field, before: clone(before), after: clone(after),
        class: classify(entity, 'change', field, a.obj, z.obj), label: L.of(entity, z.obj, key),
        ...(ref != null && { refLabel: L.element(ref) }),
        ...(entity === 'edge' && (field === 'from' || field === 'to') && { labelBefore: L.of(entity, a.obj, key) }),
        // an id written on an id-less edge: is it the id the compiler already gave it (a pin), or a new one?
        ...(entity === 'edge' && field === 'id' && { generated: { before: generatedA[a.index], after: generatedB[z.index] } }),
        // an id-less edge matched by what it still shares, not by an id or unchanged ends
        ...(entity === 'edge' && inferred.has(key) && { inferred: true }),
      })
    }
  }
  const order = (x, y) => ENTITIES.indexOf(x.entity) - ENTITIES.indexOf(y.entity) || cmp(x.key, y.key) || TYPE_RANK[x.type] - TYPE_RANK[y.type] || cmp(x.field ?? '', y.field ?? '')
  for (const list of Object.values(out)) list.sort(order)
  return out
}

/** Every change of a diff in one list: semantic, then layout, presentation and identity. */
export const allChanges = (diff) => CLASSES.flatMap((k) => diff[k] ?? [])

/** An identity change that writes down the id the edge already had (its compiled id is unchanged). */
export const isPin = (c) => c.entity === 'edge' && c.field === 'id' && c.generated?.before === c.generated?.after

const q = (s) => `“${s}”`
const fmt = (v) => (v === undefined ? 'unset' : typeof v === 'string' ? q(firstLine(v) ?? v) : canon(v))
const NOUN = { node: (o) => o?.kind ?? 'node', zone: () => 'zone', frame: () => 'frame' }

/** One line of plain text per change, using labels rather than ids where it can. */
export function summarise(changes) {
  return changes.map((c) => {
    const what = q(c.label)
    if (c.entity === 'edge') {
      if (c.type === 'add') return `Connected ${c.label} (${c.after?.kind ?? 'flow'})`
      if (c.type === 'remove') return `Disconnected ${c.label}`
      if (c.field === 'from' || c.field === 'to') return `Reconnected ${c.labelBefore ?? 'an edge'} as ${c.label}${c.inferred ? ' (it has no id; matched by what it still shares)' : ''}`
      if (c.field === 'id') {
        if (isPin(c)) return c.before === undefined ? `Wrote down ${c.label}'s generated id ${fmt(c.after)} (same id)` : `Dropped ${c.label}'s explicit id ${fmt(c.before)}; the compiler generates the same id`
        if (c.after === undefined) return `Dropped ${c.label}'s id ${fmt(c.before)}; it becomes ${fmt(c.generated?.after)}`
        return `Gave ${c.label} the id ${fmt(c.after)}${c.before === undefined ? ` (was generated ${fmt(c.generated?.before)})` : ` (was ${fmt(c.before)})`}`
      }
    }
    if (c.type === 'add') return `Added ${NOUN[c.entity](c.after)} ${what}`
    if (c.type === 'remove') return `Removed ${NOUN[c.entity](c.before)} ${what}`
    const f = c.field
    if (f.startsWith('contains.')) return c.after === true ? `Added ${q(c.refLabel)} to ${c.entity} ${what}` : `Removed ${q(c.refLabel)} from ${c.entity} ${what}`
    if (f.startsWith('positions.')) {
      if (c.before === undefined) return `Pinned ${q(c.refLabel)}`
      if (c.after === undefined) return `Unpinned ${q(c.refLabel)}`
      return `Moved ${q(c.refLabel)}`
    }
    if (f === 'label' || f === 'name') {
      if (c.entity === 'diagram') return `Renamed the diagram ${fmt(c.before)} → ${fmt(c.after)}`
      if (c.entity === 'edge') return `Relabelled ${c.label}: ${fmt(c.before)} → ${fmt(c.after)}`
      if (c.before === undefined) return `Labelled ${what}`
      return `Renamed ${fmt(c.before)} to ${fmt(c.after)}`
    }
    if (f === 'x' || f === 'y') return `Moved ${what}`
    if (f === 'w' || f === 'h') return `Resized ${what}`
    if (c.entity === 'diagram') return `Changed ${f}: ${fmt(c.before)} → ${fmt(c.after)}`
    return `Changed ${f} of ${what}: ${fmt(c.before)} → ${fmt(c.after)}`
  })
}
