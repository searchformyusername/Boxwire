// Canvas transactions → source operations.
//
// A history transaction is a list of [id, before, after] element changes
// (core/history.js). Compiled ids equal source ids, so each change becomes
// operations on that same id in the source (source/edit.js): a label edit is
// a `set` of `label`, a drag a `setPosition`, a new element an `insert` written
// in the authoring format, a deletion a `remove`. A field is written only
// when it differs from what the compiler would produce without it, so a value
// returned to its default removes the field again (which makes undo restore
// the text exactly for edits and moves).
//
// Anything the format can't express (drawing order, an outline width, an
// anchor offset along a face, a node with an id the format rejects) is listed
// in `unsupported` and produces no operation, so it can never cause a
// rewrite. Zone and frame geometry is derived from their members when the
// source compiles, so their moves are listed in `derived` and need nothing.

import { CARRIES, ID_PATTERN, KEYS, NODE_KINDS, RELATIONS, TEXT_SIZES, UML_KINDS } from '../author/vocabulary.js'
import { compileDiagram } from '../author/compile.js'
import { ALL_ITEMS, itemProps } from '../catalog.js'
import { DEFAULT_STYLE, SHAPES, fitNode } from '../core/elements.js'
import { measureText, splitSections } from '../core/text.js'
import { isSafeId } from '../core/validate.js'
import { COLLECTIONS } from './index.js'
import { cascadeOf } from './edit.js'

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const SIZE_NAMES = Object.fromEntries(Object.entries(TEXT_SIZES).map(([k, v]) => [v, k]))
const GEOMETRY = ['x', 'y', 'w', 'h']
const NODE_STYLE = ['color', 'fill', 'dash', 'font', 'align', 'icon', 'crossed', 'size']
const EDGE_DEFAULTS = { route: 'ortho', color: 'ink', stroke: 2, size: 14, font: 'sans', text: '' }
const BASIC = Object.fromEntries(ALL_ITEMS.filter((it) => NODE_KINDS[it.kind] && !it.icon).reverse().map((it) => [it.shape, it]))

export function entityOf(el) {
  if (el?.type === 'edge') return 'edge'
  if (el?.type !== 'node') return null
  return el.shape === 'zone' ? 'zone' : el.shape === 'frame' ? 'frame' : 'node'
}

/** The catalog item a node element compiles from: its `kind`, else the basic shape it is drawn with. */
function itemOf(el) {
  if (typeof el.kind === 'string' && Object.hasOwn(NODE_KINDS, el.kind)) return NODE_KINDS[el.kind]
  return Object.hasOwn(BASIC, el.shape) ? BASIC[el.shape] : null
}

/** Element field values the compiler gives a node of this kind when the source says nothing. */
const nodeDefaults = (item) => ({ ...DEFAULT_STYLE, ...SHAPES[item.shape].style, ...itemProps(item), text: item.text ?? '' })
const structured = (kind) => (Object.hasOwn(UML_KINDS, kind) ? 'uml' : kind === 'table' ? 'table' : null)

/** Source field name and value for one element style field; `{ bad }` when the format can't hold it. */
function styleField(f, v, item) {
  if (f === 'size') return v === undefined ? { key: 'textSize', v } : Object.hasOwn(SIZE_NAMES, v) ? { key: 'textSize', v: SIZE_NAMES[v] } : { bad: `text size ${v} is not one of the format's sizes` }
  if (f === 'crossed') return { key: f, v: v ? true : undefined }
  if (f === 'icon' && v !== undefined && item.shape !== 'component') return { bad: 'only component kinds carry an icon' }
  return { key: f, v }
}

/** UML compartments back to fields; null when the text can't be expressed (wrong compartments, empty name). */
function umlFields(kind, text) {
  const s = splitSections(text)
  const isEnum = kind === 'enum'
  if (s.length !== (isEnum ? 2 : 3)) return null
  const header = s[0]
  let stereotype, nameLine
  if (header.length === 2 && /^«.*»$/.test(header[0])) [stereotype, nameLine] = [header[0].slice(1, -1), header[1]]
  else if (header.length === 1) nameLine = header[0]
  else return null
  const abstract = /^\*.+\*$/.test(nameLine)
  const name = abstract ? nameLine.slice(1, -1) : nameLine
  const def = UML_KINDS[kind]
  if (!name.trim() || name.length > 200 || (def.abstract && !abstract) || (stereotype ?? '').length > 60) return null
  const lines = s.slice(1)
  if (lines.flat().some((l) => l.length > 200)) return null
  return {
    name,
    // an interface or enum without its «stereotype» line is written as an empty stereotype
    stereotype: stereotype === def.stereotype ? undefined : stereotype ?? (def.stereotype ? '' : undefined),
    abstract: abstract && !def.abstract ? true : undefined,
    ...(isEnum ? { values: lines[0] } : { attributes: lines[0], methods: lines[1] }),
  }
}

/** ER table text back to { name, columns }; null when it can't be expressed. */
function tableFields(text) {
  const s = splitSections(text)
  if (s.length !== 2 || s[0].length !== 1) return null
  const name = s[0][0]
  if (!name || /\s/.test(name) || name.length > 120) return null
  const columns = s[1].map((row) => {
    const p = row.trim().split(/\s+/)
    const key = p.slice(2).join(' ') || undefined
    return p.length >= 2 && p.every((w) => w.length <= 80) && (!key || KEYS.includes(key)) ? { name: p[0], type: p[1], key } : null
  })
  return columns.length && columns.every(Boolean) ? { name, columns } : null
}

const columnOf = (c) => (typeof c === 'string' ? (([name, type, ...k]) => ({ name, type, key: k.join(' ') || undefined }))(c.trim().split(/\s+/)) : { name: c?.name, type: c?.type, key: c?.key })
/** Write a column in the style its neighbour uses: "id uuid PK" or { "name", "type", "key" }. */
const columnText = (c, like) => (typeof like === 'string' || like === undefined ? [c.name, c.type, c.key].filter(Boolean).join(' ') : { name: c.name, type: c.type, ...(c.key && { key: c.key }) })

const fieldsFor = (kind, text) => (structured(kind) === 'uml' ? umlFields(kind, text) : structured(kind) === 'table' ? tableFields(text) : null)
const textFields = (kind, text, item) => (structured(kind) ? fieldsFor(kind, text) : { label: text === item.text || (text === '' && item.text === undefined) ? undefined : text })

/** Relation kind and explicit overrides for an edge's arrowheads and dash. */
function relationOf(el) {
  const match = Object.entries(RELATIONS).find(([, r]) => r.head === el.head && r.tail === el.tail && r.dash === el.dash)
  if (match) return { kind: match[0] === 'flow' ? undefined : match[0] }
  const flow = RELATIONS.flow
  return { head: el.head === flow.head ? undefined : el.head, tail: el.tail === flow.tail ? undefined : el.tail, dash: el.dash === flow.dash ? undefined : el.dash }
}

function endValue(end, manual) {
  if (end?.id !== undefined) return { ref: end.id, side: end.side, t: end.t }
  if (!manual) return { bad: 'a free endpoint needs "layout": "manual"' }
  return { ref: { x: Math.round(end.x), y: Math.round(end.y) } }
}

/**
 * Positions nodes would have with no `positions` entry (manual: their own x/y; auto: where layout puts them),
 * as Map id → { x, y, w, h }. Pass it to opsForChanges as `natural` so a node moved back there loses its entry.
 */
export function naturalPositions(value, { measure } = {}) {
  if (!isObj(value)) return new Map()
  const manual = value.layout === 'manual'
  const keep = {}
  if (manual && isObj(value.positions)) {
    for (const n of Array.isArray(value.nodes) ? value.nodes : []) if (isObj(n) && (n.x === undefined || n.y === undefined) && Object.hasOwn(value.positions, n.id)) keep[n.id] = value.positions[n.id]
  }
  const r = compileDiagram({ ...value, positions: Object.keys(keep).length ? keep : undefined }, measure ? { measure } : undefined)
  if (!r.doc) return new Map()
  return new Map(Object.values(r.doc).filter((el) => entityOf(el) === 'node' && !Object.hasOwn(keep, el.id)).map((el) => [el.id, { x: el.x, y: el.y, w: el.w, h: el.h }]))
}

/**
 * Whether a transaction changes anything auto layout reads: the set of nodes or edges, an edge's ends
 * (a reconnect, a retarget or a reversal) or a node's size (which spaces the ranks). Labels, styles,
 * declarations and plain moves don't, so they need no reflow check. Conservative: anything it can't
 * classify counts as a change.
 */
export function layoutInputsChanged(changes) {
  for (const [, before, after] of changes) {
    const ent = entityOf(before ?? after)
    if (ent === 'zone' || ent === 'frame') continue
    if (!ent) continue // freehand strokes are not in the source
    if (!before || !after || entityOf(before) !== entityOf(after)) return true
    if (ent === 'edge' && (before.from?.id !== after.from?.id || before.to?.id !== after.to?.id || before.kind !== after.kind)) return true
    if (ent === 'node' && (before.w !== after.w || before.h !== after.h || before.kind !== after.kind || before.shape !== after.shape)) return true
  }
  return false
}

/**
 * Auto layout places every node without a `positions` entry from the whole graph, so adding or removing a
 * node or an edge can move nodes nobody touched. After such an edit, this pins each node whose compiled place
 * in `value` (the edited source) would differ from where it is on the board (`doc`), at its board place, so the
 * source still compiles to exactly the board. Returns setPosition ops (none in manual layout).
 */
export function reflowPins(value, doc, { measure } = {}) {
  if (!isObj(value) || value.layout === 'manual') return []
  const r = compileDiagram(value, measure ? { measure } : undefined)
  if (!r.doc) return []
  const pinned = isObj(value.positions) ? value.positions : {}
  const ops = []
  for (const el of Object.values(r.doc)) {
    if (entityOf(el) !== 'node' || Object.hasOwn(pinned, el.id)) continue
    const now = doc?.[el.id]
    if (!now || now.type !== 'node' || (now.x === el.x && now.y === el.y)) continue
    ops.push({ op: 'setPosition', id: el.id, x: now.x, y: now.y })
  }
  return ops
}

/**
 * Source operations for one history transaction.
 * changes: [[id, before, after]] (elements; null = absent). ctx: { value, index, natural?, measure? } for the current
 * source (value from parseSource, index from indexSource, natural from naturalPositions; measure as for compiling).
 * Returns { ops, unsupported: [{ id, reason }], derived: [id] }.
 */
export function opsForChanges(changes, { value, index, natural, measure = measureText } = {}) {
  const ops = { remove: [], insert: [], update: [], position: [] }
  const unsupported = []
  const derived = new Set()
  const skip = (id, reason) => unsupported.push({ id, reason })
  const manual = value?.layout === 'manual'
  const frameMoves = new Map()
  const src = (entity, id) => {
    const entry = index.find(entity, id)
    if (!entry) return undefined
    return entity === 'position' ? value.positions[id] : value[COLLECTIONS[entity]][entry.index]
  }

  // Removals first, so cascades (edges of a deleted node, emptied zones) are known before anything else.
  // Containers go before edges, and edges bottom-up, so no surviving edge's generated id has to be pinned needlessly.
  const removed = { node: new Set(), zone: new Set(), edge: new Set(), frame: new Set(), position: new Set() }
  const rank = { node: 0, zone: 1, frame: 2, edge: 3 }
  const removals = changes.filter(([, before, after]) => before && !after).map(([id, before]) => ({ id, entity: entityOf(before) }))
  removals.sort((a, b) => (rank[a.entity] ?? 9) - (rank[b.entity] ?? 9) || (a.entity === 'edge' ? (index.find('edge', b.id)?.index ?? 0) - (index.find('edge', a.id)?.index ?? 0) : 0))
  for (const { id, entity } of removals) {
    if (!entity) {
      skip(id, 'freehand strokes are not part of the source')
      continue
    }
    if (removed[entity].has(id)) continue
    if (!index.has(entity, id)) {
      skip(id, `the ${entity} is not in the source`)
      continue
    }
    const { plan } = cascadeOf(value, entity, id)
    for (const [k, set] of Object.entries(plan)) for (const x of set) removed[k].add(x)
    ops.remove.push({ op: 'remove', entity, id })
  }
  const gone = new Set([...removed.node, ...removed.zone])

  for (const [id, before, after] of changes) {
    if (!after) continue
    const entity = entityOf(after)
    if (!entity) {
      skip(id, 'freehand strokes are not part of the source')
      continue
    }
    if (!before) insert(id, entity, after)
    else if (entityOf(before) !== entity) skip(id, 'an element cannot change between node, zone, frame and edge')
    else if (!index.has(entity, id)) skip(id, `the ${entity} is not in the source`)
    else update(id, entity, before, after)
  }

  function insert(id, entity, el) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id) || !isSafeId(id)) return skip(id, 'its id is not a valid source id (a letter, then letters, digits, "_" or "-")')
    if (entity === 'node') {
      const item = itemOf(el)
      if (!item) return skip(id, `kind ${JSON.stringify(el.kind ?? el.shape)} is not in the format's vocabulary`)
      const def = nodeDefaults(item)
      const fields = textFields(item.kind, el.text ?? '', item)
      if (!fields) return skip(id, 'its text does not fit the kind\'s compartments')
      if (item.kind === 'text' && !fields.label) return skip(id, 'a text node needs a label')
      const out = { id, kind: item.kind, ...fields }
      for (const f of NODE_STYLE) {
        if (same(el[f], def[f]) || (f === 'crossed' && !el[f])) continue
        const s = styleField(f, el[f], item)
        if (s.bad) skip(id, s.bad)
        else out[s.key] = s.v
      }
      if (el.cap && Object.keys(el.cap).length) out.capacity = el.cap
      if (el.meta && Object.keys(el.meta).length) out.meta = el.meta
      ops.insert.push({ op: 'insert', entity, value: out })
      const [w, h] = SHAPES[item.shape].size
      ops.position.push({ op: 'setPosition', id, x: el.x, y: el.y, ...sizeToWrite(el, { w, h }) })
      return
    }
    if (entity === 'edge') {
      const from = endValue(el.from, manual), to = endValue(el.to, manual)
      if (from.bad || to.bad) return skip(id, from.bad ?? to.bad)
      if (from.t !== undefined || to.t !== undefined) skip(id, 'an anchor offset along a face is not stored in the source')
      const out = {
        id, from: from.ref, to: to.ref, ...relationOf(el), label: el.text || undefined, fromSide: from.side, toSide: to.side,
        route: el.route === EDGE_DEFAULTS.route ? undefined : el.route, color: el.color === EDGE_DEFAULTS.color ? undefined : el.color,
        width: el.stroke === EDGE_DEFAULTS.stroke ? undefined : el.stroke, carries: el.carries, share: el.share,
      }
      for (const f of ['size', 'font']) if (el[f] !== undefined && el[f] !== EDGE_DEFAULTS[f]) skip(id, `connector ${f} is not stored in the source`)
      ops.insert.push({ op: 'insert', entity, value: out })
      return
    }
    const members = (el.members ?? []).filter((m) => !gone.has(m))
    if (!members.length) return skip(id, `a ${entity} needs declared members to be written to the source`)
    const out = entity === 'zone'
      ? { id, label: el.text || undefined, contains: members, color: el.color === SHAPES.zone.style.color ? undefined : el.color, trust: el.trust }
      : { id, label: el.text || undefined, contains: members }
    ops.insert.push({ op: 'insert', entity, value: out })
  }

  /** w/h a node needs written: none when the compiler, starting from `start`, fits the content to exactly this size. */
  function sizeToWrite(el, start) {
    const fitted = fitNode({ ...el, ...start }, measure)
    return { ...(fitted.w !== el.w && { w: el.w }), ...(fitted.h !== el.h && { h: el.h }) }
  }

  /**
   * Where a moved or resized node is written. Back at its natural place with a content-driven size, it needs no
   * `positions` entry (so undoing a drag removes the entry it added); otherwise its entry gets x/y, plus w/h when
   * the size is not what the content alone produces (a size change from refitting text writes nothing).
   */
  function placement(id, obj, item, after) {
    const [dw, dh] = SHAPES[item.shape].size
    const own = { w: obj.w ?? dw, h: obj.h ?? dh }
    const entry = src('position', id)
    const nat = natural?.get(id)
    if (nat && nat.x === after.x && nat.y === after.y && !Object.keys(sizeToWrite(after, own)).length) {
      if (entry) ops.position.push({ op: 'remove', entity: 'position', id })
      return
    }
    const size = sizeToWrite(after, { w: entry?.w ?? own.w, h: entry?.h ?? own.h })
    if (!entry && !Object.keys(size).length && manual && obj.x === after.x && obj.y === after.y) return
    if (entry && !Object.keys(size).length && entry.x === after.x && entry.y === after.y) return
    ops.position.push({ op: 'setPosition', id, x: after.x, y: after.y, ...size })
  }

  function set(entity, id, path, v) {
    ops.update.push({ op: 'set', entity, id, path, value: v })
  }

  /** Set a source field to `want` unless it already says that. */
  function want(entity, id, obj, key, v) {
    if (!same(obj?.[key], v)) set(entity, id, [key], v)
  }

  /** Per-key edits of a declaration object (capacity, meta); the object goes away when emptied. */
  function declObject(entity, id, obj, key, before, after) {
    const b = before ?? {}, a = after ?? {}
    if (!Object.keys(a).length) return obj?.[key] !== undefined && set(entity, id, [key], undefined)
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) if (!same(b[k], a[k]) && !same(obj?.[key]?.[k], a[k])) set(entity, id, [key, k], a[k])
  }

  /** Array field: element-wise when the length is unchanged, otherwise the whole array. */
  function arrayField(entity, id, obj, key, next, toSource = (x) => x) {
    const cur = obj?.[key]
    if (Array.isArray(cur) && cur.length === next.length) {
      next.forEach((x, i) => {
        const v = toSource(x, cur[i])
        if (!same(cur[i], v)) set(entity, id, [key, i], v)
      })
      return
    }
    const v = next.length ? next.map((x, i) => toSource(x, cur?.[i] ?? cur?.[0])) : undefined
    if (!same(cur, v)) set(entity, id, [key], v)
  }

  function updateText(id, obj, kind, item, before, after, kindChanged) {
    const a = textFields(kind, after.text ?? '', item)
    if (!a) return skip(id, 'its text does not fit the kind\'s compartments')
    if (kind === 'text' && !a.label) return skip(id, 'a text node needs a label')
    const b = kindChanged ? {} : textFields(kind, before.text ?? '', item) ?? {}
    for (const [k, v] of Object.entries(a)) {
      if (!kindChanged && same(b[k], v)) continue
      if (k === 'attributes' || k === 'methods' || k === 'values') arrayField('node', id, obj, k, v)
      else if (k === 'columns') arrayField('node', id, obj, k, v, (c, like) => (like !== undefined && same(columnOf(like), c) ? like : columnText(c, like)))
      else want('node', id, obj, k, v)
    }
  }

  function update(id, entity, before, after) {
    if (removed[entity].has(id)) return
    const obj = src(entity, id)
    const changed = new Set([...Object.keys(before), ...Object.keys(after)].filter((k) => !same(before[k], after[k])))
    const handled = new Set(['id', 'type'])
    const take = (...keys) => keys.forEach((k) => handled.add(k))
    if (changed.has('z')) skip(id, 'drawing order is not stored in the source')
    take('z')

    if (entity === 'node') {
      const item = itemOf(after)
      if (!item) return skip(id, `kind ${JSON.stringify(after.kind ?? after.shape)} is not in the format's vocabulary`)
      const kindChanged = changed.has('kind') || changed.has('shape')
      take('kind', 'shape')
      if (kindChanged) {
        if (structured(itemOf(before)?.kind) !== structured(item.kind)) return skip(id, 'changing between plain, UML and table kinds is not written back')
        if (item.shape !== after.shape) return skip(id, 'its shape does not match its kind')
        want('node', id, obj, 'kind', item.kind)
      }
      const def = nodeDefaults(item)
      if (kindChanged || changed.has('text')) updateText(id, obj, item.kind, item, before, after, kindChanged)
      take('text')
      for (const f of NODE_STYLE) {
        take(f)
        if (!kindChanged && !changed.has(f)) continue
        const v = same(after[f], def[f]) || (f === 'crossed' && !after[f]) ? undefined : after[f]
        if (v === undefined && def[f] !== undefined && after[f] === undefined && f === 'icon') {
          skip(id, 'a component without an icon cannot be written')
          continue
        }
        const s = styleField(f, v, item)
        if (s.bad) skip(id, s.bad)
        else want('node', id, obj, s.key, s.v)
      }
      if (changed.has('cap')) declObject('node', id, obj, 'capacity', before.cap, after.cap)
      if (changed.has('meta')) declObject('node', id, obj, 'meta', before.meta, after.meta)
      take('cap', 'meta')
      if (GEOMETRY.some((k) => changed.has(k))) placement(id, obj, item, after)
      take(...GEOMETRY)
    } else if (entity === 'edge') {
      for (const side of ['from', 'to']) {
        take(side)
        if (!changed.has(side)) continue
        const b = before[side] ?? {}, a = endValue(after[side], manual)
        if (a.bad) {
          skip(id, a.bad)
          continue
        }
        if (!same(b.id ?? (b.x !== undefined ? { x: Math.round(b.x), y: Math.round(b.y) } : undefined), a.ref)) want('edge', id, obj, side, a.ref)
        if (b.side !== a.side) want('edge', id, obj, `${side}Side`, a.side)
        if (b.t !== a.t) skip(id, 'an anchor offset along a face is not stored in the source')
      }
      if (['head', 'tail', 'dash'].some((k) => changed.has(k))) {
        // keep the relation kind and override only what differs from it
        const rel = RELATIONS[typeof obj.kind === 'string' && Object.hasOwn(RELATIONS, obj.kind) ? obj.kind : 'flow']
        for (const k of ['head', 'tail', 'dash']) if (changed.has(k)) want('edge', id, obj, k, after[k] === rel[k] ? undefined : after[k])
      }
      take('head', 'tail', 'dash')
      if (changed.has('text')) want('edge', id, obj, 'label', after.text || undefined)
      if (changed.has('route')) want('edge', id, obj, 'route', after.route === EDGE_DEFAULTS.route ? undefined : after.route)
      if (changed.has('color')) want('edge', id, obj, 'color', after.color === EDGE_DEFAULTS.color ? undefined : after.color)
      if (changed.has('stroke')) want('edge', id, obj, 'width', after.stroke === EDGE_DEFAULTS.stroke ? undefined : after.stroke)
      if (changed.has('carries')) {
        if (after.carries === undefined || CARRIES.includes(after.carries)) want('edge', id, obj, 'carries', after.carries)
        else skip(id, 'unknown carries')
      }
      if (changed.has('share')) want('edge', id, obj, 'share', after.share)
      take('text', 'route', 'color', 'stroke', 'carries', 'share')
    } else {
      if (changed.has('text')) want(entity, id, obj, 'label', after.text || undefined)
      if (entity === 'zone') {
        if (changed.has('color')) want(entity, id, obj, 'color', after.color === SHAPES.zone.style.color ? undefined : after.color)
        if (changed.has('trust')) want(entity, id, obj, 'trust', after.trust)
        take('color', 'trust')
      }
      if (changed.has('members') && !removed[entity].has(id)) {
        // one entry at a time (additions first), so the rest of `contains` and its comments stay as written
        const cur = (Array.isArray(obj.contains) ? obj.contains : []).filter((m) => !gone.has(m))
        const next = (after.members ?? []).filter((m) => !gone.has(m))
        if (!next.length) skip(id, `a ${entity} needs at least one member`)
        else {
          for (const m of next) if (!cur.includes(m)) ops.update.push({ op: 'addMember', entity, id, member: m })
          for (const m of cur) if (!next.includes(m)) ops.update.push({ op: 'removeMember', entity, id, member: m })
        }
      }
      if (entity === 'frame' && changed.has('order')) frameMoves.set(id, after.order)
      if (GEOMETRY.some((k) => changed.has(k))) derived.add(id)
      take('text', 'members', 'order', ...GEOMETRY)
    }
    for (const k of changed) if (!handled.has(k)) skip(id, `${JSON.stringify(k)} is not stored in the source`)
  }

  // Frames are ordered by their place in `frames`; an order change becomes moves within that array.
  if (frameMoves.size) {
    const current = index.ids('frame').filter((f) => !removed.frame.has(f))
    const orderOf = new Map(current.map((f, i) => [f, i + 1]))
    for (const [f, o] of frameMoves) orderOf.set(f, o)
    const wanted = [...current].sort((a, b) => orderOf.get(a) - orderOf.get(b) || current.indexOf(a) - current.indexOf(b))
    const now = [...current]
    wanted.forEach((f, i) => {
      if (now[i] === f) return
      ops.update.push({ op: 'move', entity: 'frame', id: f, after: i ? wanted[i - 1] : null })
      now.splice(now.indexOf(f), 1)
      now.splice(i, 0, f)
    })
  }

  const byEntity = (list) => ['node', 'zone', 'edge', 'frame'].flatMap((e) => list.filter((o) => o.entity === e))
  return { ops: [...ops.remove, ...byEntity(ops.insert), ...ops.update, ...ops.position], unsupported, derived: [...derived] }
}
