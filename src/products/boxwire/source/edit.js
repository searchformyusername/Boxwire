// Minimal source edits addressed by stable id.
//
// Every operation names a model object by id (never by array position) and
// becomes the smallest text change that does it: a value replaced in place, a
// member added beside its siblings in their own style (inline or one per
// line, indentation, trailing commas, line endings), or an item removed with
// its comma and the comments that belong only to it. Everything else stays
// byte-identical; the file is never regenerated.
//
// Operations apply in order, and the text is re-parsed after each step, so
// later operations see earlier ones. The returned `edits` are expressed
// against the original text (non-overlapping, ascending), which is what a
// patch view or a diff wants.
//
// Generated edge ids (e1, e2 …) depend on array order. When a removal or an
// insertion would shift the generated id of a surviving edge, that edge gets
// its current id written explicitly first, so ids stay stable. That is an
// identity edit, never a layout one: every result lists the ids it wrote down
// in `pinned`, the `pin` op does the same on request, and change/diff.js
// classes the resulting `id` field as identity.

import { assignIds } from '../author/compile.js'
import { parseSource, trailEnd } from './cst.js'
import { COLLECTIONS, indexSource } from './index.js'

const ENTITIES = [...Object.keys(COLLECTIONS), 'position']
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

class OpError extends Error {}

/** Top-level scalar fields `setTop` may write (the collections, identity and format are edited through their own ops). */
const TOP_FIELDS = new Set(['name', 'layout', 'direction', '$schema'])

/** True for values that survive a JSON round trip unchanged (finite numbers, plain objects and arrays). */
function jsonable(v, depth = 0) {
  if (depth > 32) return false
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.every((x) => jsonable(x, depth + 1))
  if (isObj(v) && Object.getPrototypeOf(v) === Object.prototype) return Object.values(v).every((x) => x === undefined || jsonable(x, depth + 1))
  return false
}

// ---- text geometry ----------------------------------------------------------

const lineStart = (text, i) => text.lastIndexOf('\n', i - 1) + 1
const lineIndent = (text, i) => /^[ \t]*/.exec(text.slice(lineStart(text, i), i))[0]
const onlySpaceBefore = (text, i) => /^[ \t]*$/.test(text.slice(lineStart(text, i), i))
const newlineAt = (text, i) => (text.startsWith('\r\n', i) ? 2 : text[i] === '\n' ? 1 : 0)

/** Where an item's own text starts: the comments directly above it (no blank line between) belong to it. */
function ownStart(item) {
  const lead = item.first.leading
  let start = item.first.start, newlines = 0
  for (let j = lead.length - 1; j >= 0; j--) {
    const t = lead[j]
    if (t.type === 'newline') {
      if (++newlines > 1) break
    } else if (t.type !== 'ws') {
      start = t.start
      newlines = 0
    }
  }
  return start
}

/**
 * The comments that belong to an item in an array or object: those directly above it (no blank line
 * between, as ownStart decides) and any on the same line after it. Their text, in order.
 */
export function ownComments(item) {
  const from = ownStart(item)
  const lead = item.first.leading.filter((t) => (t.type === 'line' || t.type === 'block') && t.start >= from)
  const trail = item.last.trailing.filter((t) => t.type === 'line' || t.type === 'block')
  return [...lead, ...trail].map((t) => t.text)
}

/** An item that has its lines to itself: nothing before it on its first line, nothing after it on its last. */
function alone(text, item) {
  const end = trailEnd(item.last)
  return onlySpaceBefore(text, ownStart(item)) && (end === text.length || newlineAt(text, end) > 0)
}

const itemsOf = (container) => (container.type === 'object' ? container.members : container.elements)
const spansLines = (node) => node.first.line !== node.last.line

// ---- formatting -------------------------------------------------------------

/**
 * JSON text for `v`. Containers nest inline (`{ "x": 1 }`, `["a", "b"]`) except the
 * outer `block` levels, which put one entry per line at `indent` + unit.
 */
function format(v, style, indent = '', block = 0) {
  const inner = indent + style.unit
  if (Array.isArray(v)) {
    if (!v.length) return '[]'
    if (block > 0) return '[' + v.map((x) => style.eol + inner + format(x, style, inner, block - 1)).join(',') + style.eol + indent + ']'
    return '[' + v.map((x) => format(x, style)).join(', ') + ']'
  }
  if (isObj(v)) {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined)
    if (!entries.length) return '{}'
    const one = ([k, x], ind) => JSON.stringify(k) + ': ' + format(x, style, ind, block - 1)
    if (block > 0) return '{' + entries.map((e) => style.eol + inner + one(e, inner)).join(',') + style.eol + indent + '}'
    return '{ ' + entries.map((e) => one(e, indent)).join(', ') + ' }'
  }
  return JSON.stringify(v)
}

/** Indent unit and line ending, read from the file itself. */
function inferStyle(text, root) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  let unit = '  '
  const first = root.type === 'object' ? root.members[0] : root.type === 'array' ? root.elements[0] : null
  if (first && onlySpaceBefore(text, first.first.start)) {
    const outer = lineIndent(text, root.first.start), inner = lineIndent(text, first.first.start)
    if (inner.length > outer.length && inner.startsWith(outer)) unit = inner.slice(outer.length)
  }
  return { eol, unit }
}

// ---- primitive edits (raw edits on the current text) --------------------------

/** Remove items[idx] with its comma; whole lines when it has them to itself. */
function removeItem(text, container, idx) {
  const items = itemsOf(container)
  const item = items[idx], prev = items[idx - 1], next = items[idx + 1]
  if (alone(text, item)) {
    const end = trailEnd(item.last)
    let start = lineStart(text, ownStart(item))
    // the last item also takes the blank lines that separated it from the one before
    while (!next && prev && start > 0 && /^[ \t]*\r?$/.test(text.slice(lineStart(text, start - 1), start - 1))) start = lineStart(text, start - 1)
    const edits = [{ start, end: end + newlineAt(text, end), insert: '' }]
    if (!next && !item.comma && prev?.comma) edits.push({ start: prev.comma.start, end: prev.comma.end, insert: '' })
    return edits
  }
  // inline: the exact inverse of insertItem's `, item` / ` item,`
  if (item.comma && prev?.comma) return [{ start: prev.comma.end, end: item.comma.end, insert: '' }]
  if (item.comma) {
    let end = item.comma.end
    for (const t of item.comma.trailing) {
      if (t.type !== 'ws') break
      end = t.end
    }
    return [{ start: item.first.start, end, insert: '' }]
  }
  if (prev) return [{ start: prev.value.last.end, end: item.value.last.end, insert: '' }]
  const rest = text.slice(container.open.end, item.first.start) + text.slice(item.value.last.end, container.close.start)
  return /^\s*$/.test(rest) ? [{ start: container.open.end, end: container.close.start, insert: '' }] : [{ start: item.first.start, end: item.value.last.end, insert: '' }]
}

/**
 * Insert a new item at position `at` (0..n). `render(indent, multiline)` returns the item's text.
 * The neighbour decides the style: an item on its own lines gets a new line at the same indent;
 * an inline one gets `, item`. Trailing-comma style is kept.
 */
function insertItem(text, style, container, at, render) {
  const items = itemsOf(container)
  const n = items.length
  if (!n) {
    if (container.open.line === container.close.line) {
      const pad = container.type === 'object' ? ' ' : ''
      return [{ start: container.open.end, end: container.close.start, insert: pad + render('', false) + pad }]
    }
    const indent = lineIndent(text, container.open.start) + style.unit
    return [{ start: trailEnd(container.open), end: trailEnd(container.open), insert: style.eol + indent + render(indent, true) }]
  }
  if (at > 0) {
    const prev = items[at - 1]
    if (alone(text, prev)) {
      const indent = lineIndent(text, prev.first.start)
      const comma = at < n || prev.comma ? ',' : ''
      const pos = trailEnd(prev.last)
      const edits = [{ start: pos, end: pos, insert: style.eol + indent + render(indent, true) + comma }]
      if (!prev.comma) edits.push({ start: prev.value.last.end, end: prev.value.last.end, insert: ',' })
      return edits
    }
    if (prev.comma) return [{ start: prev.comma.end, end: prev.comma.end, insert: ' ' + render(lineIndent(text, prev.first.start), false) + ',' }]
    return [{ start: prev.value.last.end, end: prev.value.last.end, insert: ', ' + render(lineIndent(text, prev.first.start), false) }]
  }
  const first = items[0]
  if (alone(text, first)) {
    const indent = lineIndent(text, first.first.start)
    const pos = lineStart(text, ownStart(first))
    return [{ start: pos, end: pos, insert: indent + render(indent, true) + ',' + style.eol }]
  }
  return [{ start: first.first.start, end: first.first.start, insert: render(lineIndent(text, first.first.start), false) + ', ' }]
}

/** Replace a value in place; a multi-line container stays multi-line. */
function replaceValue(text, style, node, value) {
  if (same(node.value, value)) return []
  const block = (node.type === 'object' || node.type === 'array') && spansLines(node) && (Array.isArray(value) || isObj(value)) ? 1 : 0
  return [{ start: node.start, end: node.end, insert: format(value, style, lineIndent(text, node.first.start), block) }]
}

const memberText = (style, name, value) => (indent) => JSON.stringify(name) + ': ' + format(value, style, indent)

/** Set (or with value undefined, remove) a nested property below an object node, creating intermediate objects. */
function setPath(text, style, node, path, value) {
  let cur = node
  for (let i = 0; i < path.length; i++) {
    const k = path[i], last = i === path.length - 1
    if (cur.type === 'object') {
      if (typeof k !== 'string') throw new OpError(`path segment ${JSON.stringify(k)} must be a key`)
      const idx = cur.members.findIndex((m) => m.name === k)
      if (idx < 0) {
        if (value === undefined) return []
        const rest = path.slice(i + 1)
        if (rest.some((s) => typeof s !== 'string')) throw new OpError(`cannot create array element ${path.join('.')}`)
        const nested = rest.reduceRight((v, key) => ({ [key]: v }), value)
        return insertItem(text, style, cur, cur.members.length, memberText(style, k, nested))
      }
      const m = cur.members[idx]
      if (last) return value === undefined ? removeItem(text, cur, idx) : replaceValue(text, style, m.value, value)
      cur = m.value
    } else if (cur.type === 'array') {
      if (!Number.isInteger(k) || k < 0 || k > cur.elements.length) throw new OpError(`no element ${JSON.stringify(k)} in ${path.slice(0, i).join('.')}`)
      if (k === cur.elements.length) {
        if (!last) throw new OpError(`no element ${k} in ${path.slice(0, i).join('.')}`)
        return value === undefined ? [] : insertItem(text, style, cur, k, (indent) => format(value, style, indent))
      }
      if (last) return value === undefined ? removeItem(text, cur, k) : replaceValue(text, style, cur.elements[k].value, value)
      cur = cur.elements[k].value
    } else {
      throw new OpError(`${path.slice(0, i).join('.')} is not an object`)
    }
  }
  throw new OpError('empty path')
}

// ---- edit log ------------------------------------------------------------------

const gain = (e) => e.insert.length - (e.end - e.start)

/**
 * Fold edit `e` (on `cur`, the original with `log` applied) into `log`, keeping it
 * sorted, non-overlapping and relative to `original`. Touching edits merge.
 */
function compose(log, e, cur, original) {
  let shift = 0, j = 0
  while (j < log.length && log[j].start + shift + log[j].insert.length < e.start) shift += gain(log[j++])
  let k = j, s = e.start, end = e.end, os = e.start - shift, oe
  while (k < log.length && log[k].start + shift <= e.end) {
    const a = log[k].start + shift, b = a + log[k].insert.length
    if (a < s) [s, os] = [a, log[k].start]
    if (b > end) [end, oe] = [b, log[k].end]
    shift += gain(log[k++])
  }
  oe ??= end - shift
  const merged = { start: os, end: oe, insert: cur.slice(s, e.start) + e.insert + cur.slice(e.end, end) }
  log.splice(j, k - j, ...(merged.insert === original.slice(os, oe) ? [] : [merged]))
}

// ---- operations -------------------------------------------------------------------

function load(text) {
  const r = parseSource(text)
  if (r.errors.length) {
    const e = r.errors[0]
    return { error: `${e.line}:${e.col}: ${e.message}` }
  }
  if (r.cst.root.type !== 'object') return { error: 'the source must be a JSON object' }
  return { text, cst: r.cst, value: r.value, index: indexSource(r.cst, r.value), style: inferStyle(text, r.cst.root) }
}

const rootMember = (st, name) => st.cst.root.members.find((m) => m.name === name)

function need(st, entity, id) {
  const entry = st.index.find(entity, id)
  if (!entry) throw new OpError(`unknown ${entity} ${JSON.stringify(id)}`)
  return entry
}

/**
 * What removing an entity takes with it, computed on the value: { plan: { node, zone, edge, frame, position: Set },
 * gone: Set of removed node and zone ids }. Edges touching a removed node or zone go, as do zones and frames left
 * with no members, and the node's `positions` entry.
 */
export function cascadeOf(value, entity, id) {
  const arr = (k) => (Array.isArray(value[k]) ? value[k] : [])
  const edgeIds = assignIds(value).edges
  const plan = { node: new Set(), zone: new Set(), edge: new Set(), frame: new Set(), position: new Set() }
  const queue = [[entity, id]]
  const gone = new Set() // removed node and zone ids
  while (queue.length) {
    const [ent, x] = queue.shift()
    if (plan[ent].has(x)) continue
    plan[ent].add(x)
    if (ent !== 'node' && ent !== 'zone') continue
    gone.add(x)
    if (ent === 'node' && isObj(value.positions) && Object.hasOwn(value.positions, x)) plan.position.add(x)
    arr('edges').forEach((e, i) => {
      if (e?.from === x || e?.to === x) plan.edge.add(edgeIds[i])
    })
    for (const [kind, coll] of [['zone', 'zones'], ['frame', 'frames']]) {
      for (const c of arr(coll)) {
        if (!Array.isArray(c?.contains) || !c.contains.includes(x)) continue
        if (c.contains.every((m) => gone.has(m))) queue.push([kind, c.id])
      }
    }
  }
  return { plan, gone }
}

/** Surviving id-less edges whose generated id `mutate` would change: [{ id }] to write explicitly first. */
function pinsFor(value, mutate) {
  const edges = Array.isArray(value.edges) ? value.edges : []
  const before = assignIds(value).edges
  // the mutations only replace or splice the top-level arrays, so copying those is enough; edges keep their identity
  const next = { ...value }
  for (const k of Object.values(COLLECTIONS)) if (Array.isArray(value[k])) next[k] = [...value[k]]
  const origin = new Map((next.edges ?? []).map((e, i) => [e, i]))
  mutate(next)
  const after = assignIds(next).edges
  const pins = []
  ;(next.edges ?? []).forEach((e, j) => {
    const i = origin.get(e)
    if (i !== undefined && isObj(edges[i]) && edges[i].id === undefined && before[i] !== after[j]) pins.push(before[i])
  })
  return pins
}

/**
 * Apply operations to source text. Returns { text, edits, pinned } or { error }; `pinned` lists the
 * generated edge ids written down explicitly so they survive the change (identity, not layout).
 * Ops (entity: 'node' | 'zone' | 'edge' | 'frame' | 'position'):
 * - { op: 'set', entity, id, path: [key, …], value } — value undefined removes the property; intermediate objects are created.
 * - { op: 'insert', entity, value, after?: id, comments?: [text] } — appended to its array (created if missing), or placed
 *   after `after`; `comments` (line or block comment texts) go on their own lines above it, or inline before it as block comments.
 * - { op: 'remove', entity, id } — also removes edges touching a removed node or zone, its `contains` entries
 *   (a zone or frame left empty is removed too) and its `positions` entry.
 * - { op: 'setPosition', id, x, y, w?, h? } — writes the node's entry in `positions` (created as a trailing top-level member).
 * - { op: 'move', entity, id, after: id | null } — reorders an item within its array (null: first), comments included.
 * - { op: 'setTop', key: 'name' | 'layout' | 'direction' | '$schema', value } — a top-level field (value undefined removes it).
 * - { op: 'pin', entity: 'edge', id } — writes an id-less edge's generated id explicitly (no-op when it has one).
 * - { op: 'addMember' | 'removeMember', entity: 'zone' | 'frame', id, member, after? } — one entry of `contains`,
 *   added (after the member `after`, else last) or removed with its own comment; the rest of the array, comments
 *   included, stays byte-identical.
 */
export function applySourceOps(text, ops) {
  const ed = createSourceEditor(text)
  if (ed.error) return { error: ed.error }
  const r = ed.apply(ops)
  return r.error ? r : { text: ed.text, edits: r.edits, pinned: r.pinned }
}

/**
 * A source text that operations are applied to one batch at a time, without re-reading it
 * between batches: `apply(ops)` → { edits } (relative to the text before that batch) or { error }
 * (and the text stays as it was). `text`, `value` (parsed) and `index` are the current state.
 * Returns { error } when the text doesn't parse.
 */
export function createSourceEditor(initial) {
  let st = load(initial)
  if (st.error) return { error: st.error }
  return {
    get text() { return st.text },
    get value() { return st.value },
    get index() { return st.index },
    apply(ops) {
      const r = run(st, ops)
      if (r.error) return { error: r.error }
      st = r.st
      return { edits: r.edits, pinned: r.pinned }
    },
    /**
     * Apply `set` ops in one step, re-reading the text once, when their edits touch disjoint text
     * (different values, members added to different objects). Returns one { edits } or { error }
     * per op, or null, changing nothing, when two of them would touch the same text: apply those
     * one at a time instead. Same result as applying them in order.
     */
    applyDisjoint(ops) {
      const out = ops.map((op) => {
        try {
          if (!isObj(op) || op.op !== 'set') throw new OpError(`only "set" ops can be batched, not ${JSON.stringify(op?.op)}`)
          return { edits: setEdits(st, op) }
        } catch (err) {
          if (err instanceof OpError) return { error: `ops[0] (${op?.op}): ${err.message}` }
          throw err
        }
      })
      const raw = out.flatMap((o) => o.edits ?? [])
      const sorted = [...raw].sort((a, b) => a.start - b.start)
      for (let i = 1; i < sorted.length; i++) if (sorted[i].start <= sorted[i - 1].end) return null
      if (raw.length) st = commitAll(st, raw)
      return out
    },
  }
}

/** The raw edits of one `set` op on the current text (validated; throws OpError). */
function setEdits(st, op) {
  if (!ENTITIES.includes(op.entity)) throw new OpError(`unknown entity ${JSON.stringify(op.entity)}`)
  const { node } = need(st, op.entity, op.id)
  if (!Array.isArray(op.path) || !op.path.length) throw new OpError('path must be a non-empty array')
  if (op.path[0] === 'id' && op.entity !== 'position') throw new OpError('ids are identity and cannot be set; remove and insert instead')
  if (op.value !== undefined && !jsonable(op.value)) throw new OpError('value must be JSON (finite numbers, strings, booleans, null, arrays, plain objects)')
  if (node.type !== 'object') throw new OpError(`${op.entity} ${JSON.stringify(op.id)} is not an object`)
  return setPath(st.text, st.style, node, op.path, op.value)
}

/** Apply non-overlapping raw edits (relative to st.text) and re-read the result once. */
function commitAll(st, raw) {
  let cur = st.text
  for (const e of [...raw].sort((a, b) => b.start - a.start)) cur = cur.slice(0, e.start) + e.insert + cur.slice(e.end)
  const next = load(cur)
  if (next.error) throw new Error(`internal: an edit produced invalid source (${next.error})`)
  return next
}

function run(start, ops) {
  let st = start
  const text = start.text
  if (!Array.isArray(ops)) return { error: 'ops must be an array' }
  const log = []
  const pinned = [] // generated edge ids written down explicitly, in order

  const commit = (raw) => {
    if (!raw.length) return
    let cur = st.text
    // bottom-up, so each edit's offsets are still valid; equal starts keep their given order (a later insert lands before an earlier one)
    const sorted = [...raw].sort((a, b) => b.start - a.start)
    for (let i = 1; i < sorted.length; i++) if (sorted[i].end > sorted[i - 1].start) throw new Error('internal: overlapping edits')
    for (const e of sorted) {
      compose(log, e, cur, text)
      cur = cur.slice(0, e.start) + e.insert + cur.slice(e.end)
    }
    const next = load(cur)
    if (next.error) throw new Error(`internal: an edit produced invalid source (${next.error})`)
    st = next
  }

  const pin = (ids) => {
    for (const id of ids) {
      commit(insertItem(st.text, st.style, need(st, 'edge', id).node, 0, memberText(st.style, 'id', id)))
      pinned.push(id)
    }
  }

  /** Remove an item by entity id, without cascading. */
  const removeOne = (entity, id) => {
    const { container, index } = need(st, entity, id)
    if (entity === 'position' && container.members.length === 1) {
      const root = st.cst.root
      return commit(removeItem(st.text, root, root.members.indexOf(rootMember(st, 'positions'))))
    }
    commit(removeItem(st.text, container, index))
  }

  const ops_ = {
    set(op) {
      commit(setEdits(st, op))
    },

    addMember(op) {
      if (op.entity !== 'zone' && op.entity !== 'frame') throw new OpError('only zones and frames have members')
      if (typeof op.member !== 'string') throw new OpError('member must be an id')
      const { node } = need(st, op.entity, op.id)
      if (node.type !== 'object') throw new OpError(`${op.entity} ${JSON.stringify(op.id)} is not an object`)
      const arr = node.members.find((m) => m.name === 'contains')?.value
      if (!arr) return commit(setPath(st.text, st.style, node, ['contains'], [op.member]))
      if (arr.type !== 'array') throw new OpError(`"contains" of ${op.entity} ${JSON.stringify(op.id)} is not an array`)
      if (arr.value.includes(op.member)) return
      // after the named member when it is there, else at the end; the other members and their comments are untouched
      const after = op.after == null ? -1 : arr.value.indexOf(op.after)
      const at = after >= 0 ? after + 1 : arr.elements.length
      commit(insertItem(st.text, st.style, arr, at, () => JSON.stringify(op.member)))
    },

    removeMember(op) {
      if (op.entity !== 'zone' && op.entity !== 'frame') throw new OpError('only zones and frames have members')
      const { node } = need(st, op.entity, op.id)
      const arr = node.type === 'object' ? node.members.find((m) => m.name === 'contains')?.value : null
      const at = arr?.type === 'array' ? arr.value.indexOf(op.member) : -1
      if (at < 0) throw new OpError(`no member ${JSON.stringify(op.member)} in ${op.entity} ${JSON.stringify(op.id)}`)
      if (arr.elements.length === 1) throw new OpError(`a ${op.entity} needs at least one member; remove the ${op.entity} instead`)
      commit(removeItem(st.text, arr, at))
    },

    setTop(op) {
      if (typeof op.key !== 'string' || !TOP_FIELDS.has(op.key)) throw new OpError(`top-level ${JSON.stringify(op.key)} can't be set this way`)
      if (op.value !== undefined && !jsonable(op.value)) throw new OpError('value must be JSON')
      commit(setPath(st.text, st.style, st.cst.root, [op.key], op.value))
    },

    pin(op) {
      if (op.entity !== 'edge') throw new OpError('only edges have generated ids to pin')
      const { node, index } = need(st, 'edge', op.id)
      if (node.type !== 'object') throw new OpError(`edge ${JSON.stringify(op.id)} is not an object`)
      if (st.value.edges[index]?.id === undefined) pin([op.id])
    },

    insert(op) {
      const coll = COLLECTIONS[op.entity]
      if (!coll) throw new OpError(`cannot insert a ${JSON.stringify(op.entity)}; use setPosition for positions`)
      if (!isObj(op.value) || !jsonable(op.value)) throw new OpError('value must be a JSON object')
      const id = op.value.id
      if (id !== undefined && (typeof id !== 'string' || ENTITIES.some((e) => e !== 'position' && st.index.has(e, id)))) throw new OpError(`id ${JSON.stringify(id)} is already used`)
      if (op.entity !== 'edge' && typeof id !== 'string') throw new OpError(`a ${op.entity} needs an id`)
      const arr = rootMember(st, coll)?.value
      let at = arr?.type === 'array' ? arr.elements.length : 0
      if (op.after !== undefined && op.after !== null) at = need(st, op.entity, op.after).index + 1
      // an explicit id can take a generated one; an id-less edge in the middle shifts the ones after it
      pin(pinsFor(st.value, (v) => {
        v[coll] = Array.isArray(v[coll]) ? v[coll] : []
        v[coll].splice(at, 0, structuredClone(op.value))
      }))
      // comments that travel with the item (from the proposal it came from): on their own lines above it
      // where the item gets lines of its own, otherwise inline before it
      const notes = Array.isArray(op.comments) ? op.comments.filter((c) => typeof c === 'string' && /^(\/\/[^\n\r]*|\/\*[\s\S]*?\*\/)$/.test(c)) : []
      const fresh = rootMember(st, coll)?.value
      if (!fresh) {
        const root = st.cst.root
        if (notes.length) {
          return commit(insertItem(st.text, st.style, root, root.members.length, (indent) => {
            const inner = indent + st.style.unit
            return JSON.stringify(coll) + ': [' + notes.map((c) => st.style.eol + inner + c).join('') + st.style.eol + inner + format(op.value, st.style, inner) + st.style.eol + indent + ']'
          }))
        }
        return commit(insertItem(st.text, st.style, root, root.members.length, (indent) => JSON.stringify(coll) + ': ' + format([op.value], st.style, indent, 1)))
      }
      if (fresh.type !== 'array') throw new OpError(`"${coll}" is not an array`)
      const ref = fresh.elements[at - 1] ?? fresh.elements[0]
      const block = ref && ref.value.type === 'object' && spansLines(ref.value) ? 1 : 0
      // inline, a line comment would swallow the rest of the line, so it becomes a block comment before the item
      const inlineNote = (c) => (c.startsWith('/*') ? c : `/* ${c.slice(2).trim().replace(/\*\//g, '* /')} */`) + ' '
      commit(insertItem(st.text, st.style, fresh, at, (indent, multiline) => (multiline ? notes.map((c) => c + st.style.eol + indent).join('') : notes.map(inlineNote).join('')) + format(op.value, st.style, indent, multiline ? block : 0)))
    },

    remove(op) {
      if (!ENTITIES.includes(op.entity)) throw new OpError(`unknown entity ${JSON.stringify(op.entity)}`)
      need(st, op.entity, op.id)
      if (op.entity === 'position') return removeOne('position', op.id)
      const { plan, gone } = cascadeOf(st.value, op.entity, op.id)
      const edgeIds = assignIds(st.value).edges
      pin(pinsFor(st.value, (v) => {
        const keep = (coll, entity) => {
          if (Array.isArray(v[coll])) v[coll] = v[coll].filter((o) => !plan[entity].has(o?.id))
        }
        keep('nodes', 'node')
        keep('zones', 'zone')
        keep('frames', 'frame')
        if (Array.isArray(v.edges)) v.edges = v.edges.filter((_, i) => !plan.edge.has(edgeIds[i]))
      }))
      // Resolve every target now and remove from the bottom of the file up, so earlier paths stay valid.
      const targets = []
      for (const ent of ['node', 'zone', 'edge', 'frame']) for (const id of plan[ent]) targets.push({ ent, id, start: need(st, ent, id).item.start })
      for (const [ent, coll] of [['zone', 'zones'], ['frame', 'frames']]) {
        const arr = Array.isArray(st.value[coll]) ? st.value[coll] : []
        arr.forEach((c) => {
          if (plan[ent].has(c?.id) || !Array.isArray(c?.contains)) return
          c.contains.forEach((m, ci) => {
            if (gone.has(m)) targets.push({ ent, id: c.id, contains: ci, start: need(st, ent, c.id).node.members.find((x) => x.name === 'contains').value.elements[ci].start })
          })
        })
      }
      const positionIds = [...plan.position]
      const allPositions = isObj(st.value.positions) && positionIds.length === Object.keys(st.value.positions).length
      if (allPositions) targets.push({ block: true, start: rootMember(st, 'positions').start })
      else for (const id of positionIds) targets.push({ ent: 'position', id, start: need(st, 'position', id).item.start })
      targets.sort((a, b) => b.start - a.start)
      for (const t of targets) {
        if (t.block) {
          const root = st.cst.root
          commit(removeItem(st.text, root, root.members.indexOf(rootMember(st, 'positions'))))
        } else if (t.contains !== undefined) {
          const arr = need(st, t.ent, t.id).node.members.find((x) => x.name === 'contains').value
          commit(removeItem(st.text, arr, t.contains))
        } else {
          removeOne(t.ent, t.id)
        }
      }
    },

    setPosition(op) {
      need(st, 'node', op.id)
      const pos = { x: op.x, y: op.y, w: op.w, h: op.h }
      for (const [k, v] of Object.entries(pos)) if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v))) throw new OpError(`${k} must be a finite number`)
      if (pos.x === undefined || pos.y === undefined) throw new OpError('setPosition needs x and y')
      if (st.index.has('position', op.id)) {
        for (const k of ['x', 'y', 'w', 'h']) if (pos[k] !== undefined) commit(setPath(st.text, st.style, st.index.find('position', op.id).node, [k], pos[k]))
        return
      }
      const block = rootMember(st, 'positions')?.value
      if (block && block.type !== 'object') throw new OpError('"positions" is not an object')
      if (block) return commit(insertItem(st.text, st.style, block, block.members.length, memberText(st.style, op.id, pos)))
      const root = st.cst.root
      commit(insertItem(st.text, st.style, root, root.members.length, (indent) => '"positions": ' + format({ [op.id]: pos }, st.style, indent, 1)))
    },

    move(op) {
      if (op.entity === 'position') throw new OpError('positions have no order')
      const { container, item } = need(st, op.entity, op.id)
      if (op.after === op.id) return
      if (op.after != null) need(st, op.entity, op.after)
      const items = itemsOf(container)
      const idx = items.indexOf(item)
      const target = op.after == null ? 0 : items.indexOf(st.index.find(op.entity, op.after).item) + 1
      if (target === idx || target === idx + 1) return
      const raw = st.text.slice(ownStart(item), item.value.end)
      commit(removeItem(st.text, container, idx))
      const at = op.after == null ? 0 : st.index.find(op.entity, op.after).index + 1
      commit(insertItem(st.text, st.style, rootMember(st, COLLECTIONS[op.entity]).value, at, () => raw))
    },
  }

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    try {
      if (!isObj(op) || !Object.hasOwn(ops_, op.op)) throw new OpError(`unknown op ${JSON.stringify(op?.op)}`)
      if (op.op !== 'setPosition' && op.op !== 'insert' && op.op !== 'setTop' && !ENTITIES.includes(op.entity)) throw new OpError(`unknown entity ${JSON.stringify(op.entity)}`)
      ops_[op.op](op)
    } catch (err) {
      if (err instanceof OpError) return { error: `ops[${i}] (${op?.op}): ${err.message}` }
      throw err
    }
  }
  return { st, edits: log, pinned }
}

/** Apply `edits` (as returned by applySourceOps, relative to `text`) to `text`. */
export function applyEdits(text, edits) {
  let out = '', at = 0
  for (const e of edits) {
    out += text.slice(at, e.start) + e.insert
    at = e.end
  }
  return out + text.slice(at)
}
