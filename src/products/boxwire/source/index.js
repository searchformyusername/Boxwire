// Source index: stable model ids → exact source spans.
//
// Built from a parsed file (source/cst.js), it answers "where in the text is
// node `api`'s label?" for diagnostics, review witnesses and the edit layer.
// Entities are found by id, never by array position. An edge without an
// explicit id is known by the id the compiler generates for it (assignIds),
// so `e3` here is `e3` on the canvas and in every diagnostic.

import { assignIds } from '../author/compile.js'
import { spanOfNode } from './cst.js'

/** Entity kind → the top-level array that holds it. Positions live in the `positions` object, keyed by node id. */
export const COLLECTIONS = { node: 'nodes', zone: 'zones', edge: 'edges', frame: 'frames' }

const memberOf = (obj, name) => (obj?.type === 'object' ? obj.members.find((m) => m.name === name) : undefined)

/** Path segments of a compiler diagnostic path such as `nodes[3].capacity.replicas` or `positions.api`. */
export function parsePath(path) {
  const out = []
  for (const m of String(path).matchAll(/([^.[\]]+)|\[(\d+)\]/g)) out.push(m[2] !== undefined ? Number(m[2]) : m[1])
  return out
}

/** The CST value node at `segments` below `node`, or the deepest node that exists ({ node, exact }). */
export function walk(node, segments) {
  let cur = node
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    const next = cur?.type === 'object' ? memberOf(cur, String(s))?.value : cur?.type === 'array' && Number.isInteger(s) ? cur.elements[s]?.value : undefined
    if (!next) return { node: cur, exact: false, depth: i }
    cur = next
  }
  return { node: cur, exact: true, depth: segments.length }
}

/**
 * Index a parsed source. Returns:
 * - spanOf({ entity, id, field? }) → { start, end, line, col, endLine, endCol } | null. `field` is a key, a dotted
 *   path ('capacity.replicas') or an array of keys/indices; without it the span covers the whole entity.
 * - spanAtPath(path) → span of a compiler diagnostic path, or of its nearest existing ancestor ({ ...span, exact }).
 * - edgeIdAt(i) → the id the compiler gives edges[i].
 * - find(entity, id) → { container, item, index, node } (CST array/object, its element/member, position, value node).
 * - has(entity, id), ids(entity).
 */
export function indexSource(cst, value) {
  const root = cst?.root?.type === 'object' ? cst.root : null
  const edgeIds = assignIds(value).edges
  const entries = new Map()
  const order = { node: [], zone: [], edge: [], frame: [], position: [] }
  const key = (entity, id) => `${entity}\u0000${id}`
  const put = (entity, id, entry) => {
    if (typeof id !== 'string' || entries.has(key(entity, id))) return
    entries.set(key(entity, id), entry)
    order[entity].push(id)
  }

  for (const [entity, coll] of Object.entries(COLLECTIONS)) {
    const arr = memberOf(root, coll)?.value
    if (arr?.type !== 'array') continue
    arr.elements.forEach((el, index) => {
      const id = entity === 'edge' ? edgeIds[index] : el.value.type === 'object' ? memberOf(el.value, 'id')?.value.value : undefined
      put(entity, id, { container: arr, item: el, index, node: el.value })
    })
  }
  const positions = memberOf(root, 'positions')?.value
  if (positions?.type === 'object') positions.members.forEach((m, index) => put('position', m.name, { container: positions, item: m, index, node: m.value }))

  const find = (entity, id) => entries.get(key(entity, id)) ?? null

  function spanOf({ entity, id, field } = {}) {
    const entry = find(entity, id)
    if (!entry) return null
    if (field === undefined) return spanOfNode(cst, entity === 'position' ? entry.item : entry.node)
    const segments = Array.isArray(field) ? field : String(field).split('.')
    const at = walk(entry.node, segments)
    return at.exact ? spanOfNode(cst, at.node) : null
  }

  function spanAtPath(path) {
    if (!root) return null
    const at = walk(root, parsePath(path))
    return { ...spanOfNode(cst, at.node), exact: at.exact }
  }

  return {
    spanOf,
    spanAtPath,
    edgeIdAt: (i) => edgeIds[i] ?? null,
    find,
    has: (entity, id) => entries.has(key(entity, id)),
    ids: (entity) => [...(order[entity] ?? [])],
  }
}
