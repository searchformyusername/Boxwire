// Compiles a `boxwire-diagram` authoring file into an ordinary Boxwire board.
//
// The authoring format is deliberately narrow: an LLM (or a person) writes
// kinds, labels and relations; this module supplies every default, the
// layout and the construction history, then hands the result to the same
// validator every other import goes through. Nothing here guesses from
// label text. Problems come back as diagnostics with JSON paths; any error
// means no board.
//
// Identity, label and position are kept apart. `id` is the identity every
// view, diff and review result names; `label` (or the UML/table fields) is
// display text that never changes meaning; where a node sits is per-view
// layout, which the top-level `positions` block holds separately from the
// model, so a drag on the canvas edits only that block.

import {
  CAPACITY_FIELDS, CARRIES, COLORS, DASHES, FILLS, FORMAT, HEADS, ICONS, ID_PATTERN, KEYS, LIMITS, META, NODE_KINDS, PARENT_POINTING, RELATIONS,
  MAX_ECHO, ROUTES, SIDES, TEXT_SIZES, TRUST_LEVELS, UML_KINDS, VERSION, ZONE_KINDS,
} from './vocabulary.js'
import { metaKeyOk } from '../core/declared.js'
import { itemProps } from '../catalog.js'
import { fitNode, makeEdge, makeNode, makeStroke } from '../core/elements.js'
import { LIMITS as BOARD, isSafeId, validateBoard } from '../core/validate.js'
import { measureText } from '../core/text.js'
import { levenshteinDistance } from '../../../utils/commandSuggestions.js'
import { layeredLayout } from './layout.js'

const STYLE_FIELDS = ['color', 'fill', 'dash', 'crossed', 'textSize', 'font', 'align']
const FIELDS = {
  top: ['$schema', 'format', 'version', 'name', 'layout', 'direction', 'nodes', 'edges', 'zones', 'frames', 'strokes', 'positions'],
  node: ['id', 'kind', 'x', 'y', 'w', 'h', 'rank', 'capacity', 'meta', ...STYLE_FIELDS],
  edge: ['id', 'from', 'to', 'kind', 'label', 'fromSide', 'toSide', 'route', 'head', 'tail', 'dash', 'color', 'width', 'carries', 'share'],
  zone: ['id', 'label', 'contains', 'color', 'padding', 'trust'],
  frame: ['id', 'label', 'contains', 'padding'],
  stroke: ['id', 'points', 'color', 'width', 'highlighter'],
  position: ['x', 'y', 'w', 'h'],
}
const ZONE_LABEL_SPACE = 30
/** Margin between a frame and a frame nested inside it: room for the inner frame's title. */
const FRAME_NEST = 40

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
/** A short preview of a value for messages; author input can be megabytes long. */
const json = (v) => {
  const s = JSON.stringify(v) ?? String(v)
  return s.length > MAX_ECHO ? s.slice(0, MAX_ECHO) + '…' : s
}
const short = (s) => (s.length > MAX_ECHO ? s.slice(0, MAX_ECHO) + '…' : s)
/** Drop unset options so they never overwrite a default with undefined. */
const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

/** "did you mean …" for a mistyped vocabulary word. */
function suggest(value, options) {
  // edit distance is quadratic: only worth it for strings that could plausibly be a typo of a vocabulary word
  if (typeof value !== 'string' || !value || value.length > MAX_ECHO) return ''
  let best = null, bestD = Infinity
  for (const o of options) {
    const d = levenshteinDistance(value.toLowerCase(), o)
    if (d < bestD) [best, bestD] = [o, d]
  }
  return best && bestD <= Math.max(2, Math.floor(value.length / 3)) ? ` Did you mean "${best}"?` : ''
}

function createDiagnostics() {
  const errors = [], warnings = []
  return {
    errors, warnings,
    // both return undefined, so `return d.error(...)` reads as "no result"
    error(path, message) {
      if (errors.length < 200) errors.push({ path, message })
    },
    warn(path, message) {
      if (warnings.length < 200) warnings.push({ path, message })
    },
  }
}

/** Shared checks for optional enumerated / numeric fields. */
function checker(d, obj, path) {
  return {
    oneOf(key, options, hint = '') {
      if (obj[key] === undefined) return undefined
      if (typeof obj[key] === 'string' && options.includes(obj[key])) return obj[key]
      d.error(`${path}.${key}`, `must be one of ${options.map((o) => `"${o}"`).join(', ')}; got ${json(obj[key])}.${suggest(obj[key], options) || hint}`)
    },
    number(key, min, max) {
      if (obj[key] === undefined) return undefined
      if (isNum(obj[key]) && obj[key] >= min && obj[key] <= max) return obj[key]
      d.error(`${path}.${key}`, `must be a number from ${min} to ${max}; got ${json(obj[key])}.`)
    },
    bool(key) {
      if (obj[key] === undefined) return undefined
      if (typeof obj[key] === 'boolean') return obj[key]
      d.error(`${path}.${key}`, `must be true or false; got ${json(obj[key])}.`)
    },
    text(key, { required = false, max = LIMITS.label } = {}) {
      const v = obj[key]
      if (v === undefined) return required ? d.error(`${path}.${key}`, 'is required.') : undefined
      if (typeof v === 'string' && v.length <= max) return v
      d.error(`${path}.${key}`, typeof v === 'string' ? `is longer than ${max} characters.` : `must be a string; got ${json(v)}.`)
    },
    unknown(allowed) {
      for (const k of Object.keys(obj)) if (!allowed.includes(k)) d.warn(`${path}.${short(k)}`, `unknown field, ignored.${suggest(k, allowed)}`)
    },
  }
}

function claimId(d, ids, value, path) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value) || !isSafeId(value)) {
    d.error(path, `must be an id: a letter, then up to 47 letters, digits, "_" or "-" (and not a reserved name like "constructor"); got ${json(value)}.`)
    return null
  }
  if (ids.has(value)) {
    d.error(path, `duplicate id "${value}"; ids are shared by nodes, zones, edges and strokes.`)
    return null
  }
  ids.add(value)
  return value
}

const SECTION_BREAK = /^\s*-{2,}\s*$/

/** Lines for one UML/ER compartment: strings without newlines or "---" separators. */
function lines(d, obj, key, path) {
  const v = obj[key]
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > LIMITS.lines) return d.error(`${path}.${key}`, `must be an array of at most ${LIMITS.lines} strings.`), []
  return v.filter((s, i) => {
    const ok = typeof s === 'string' && s.length <= 200 && !s.includes('\n') && !SECTION_BREAK.test(s)
    if (!ok) d.error(`${path}.${key}[${i}]`, 'must be a one-line string (at most 200 characters, not a "---" separator).')
    return ok
  })
}

/** A one-line, separator-free string (so it can't add or split compartments). */
function oneLine(d, value, path, required = false) {
  if (typeof value !== 'string') return value
  if (required && !value.trim()) return d.error(path, 'must not be empty.')
  if (value.includes('\n') || SECTION_BREAK.test(value)) return d.error(path, 'must be one line, and not a "---" separator.')
  return value
}

/** UML compartments: [stereotype, name] / attributes / methods (enums: values). */
function umlText(d, n, path) {
  const c = checker(d, n, path)
  const name = oneLine(d, c.text('name', { required: true, max: 200 }), `${path}.name`, true)
  const defaults = UML_KINDS[n.kind]
  const stereotype = oneLine(d, c.text('stereotype', { max: 60 }), `${path}.stereotype`) ?? defaults.stereotype
  const abstract = c.bool('abstract') ?? defaults.abstract ?? false
  if (defaults.abstract && abstract === false) d.error(`${path}.abstract`, 'an "abstract-class" is always abstract; use kind "class" for a concrete class.')
  const header = [stereotype && `«${stereotype}»`, abstract ? `*${name}*` : name].filter(Boolean)
  if (n.kind === 'enum') {
    if (n.attributes !== undefined || n.methods !== undefined) d.error(path, 'an enum lists "values", not "attributes" or "methods".')
    return [...header, '---', ...lines(d, n, 'values', path)].join('\n')
  }
  if (n.values !== undefined) d.error(`${path}.values`, `"values" is only for kind "enum"; use "attributes" and "methods".`)
  return [...header, '---', ...lines(d, n, 'attributes', path), '---', ...lines(d, n, 'methods', path)].join('\n')
}

/** ER table: name / one row per column ("name type KEY"). */
function tableText(d, n, path) {
  const name = oneLine(d, checker(d, n, path).text('name', { required: true, max: 120 }), `${path}.name`, true)
  if (typeof name === 'string' && /\s/.test(name)) d.error(`${path}.name`, 'table names cannot contain spaces.')
  const cols = n.columns
  if (!Array.isArray(cols) || !cols.length || cols.length > LIMITS.lines) {
    d.error(`${path}.columns`, `must be a non-empty array of at most ${LIMITS.lines} columns.`)
    return name ?? ''
  }
  const rows = cols.map((col, i) => {
    const p = `${path}.columns[${i}]`
    const parts = typeof col === 'string' ? col.trim().split(/\s+/) : null
    const c = isObj(col) ? col : parts ? { name: parts[0], type: parts[1], key: parts.slice(2).join(' ') || undefined } : null
    if (!c) return d.error(p, 'must be { "name", "type", "key"? } or a string like "id uuid PK".'), ''
    if (isObj(col)) checker(d, col, p).unknown(['name', 'type', 'key'])
    for (const f of ['name', 'type']) {
      if (typeof c[f] !== 'string' || !c[f] || /\s/.test(c[f]) || c[f].length > 80) d.error(`${p}.${f}`, 'is required: one word, no spaces, at most 80 characters.')
    }
    if (c.key !== undefined && !KEYS.includes(c.key)) d.error(`${p}.key`, `must be one of ${KEYS.map((k) => `"${k}"`).join(', ')}; got ${json(c.key)}.`)
    return [c.name, c.type, c.key].filter(Boolean).join(' ')
  })
  return [name, '---', ...rows].join('\n')
}

function compileNode(d, ids, n, path, manual, positions) {
  if (!isObj(n)) return d.error(path, 'must be an object.')
  const c = checker(d, n, path)
  const id = claimId(d, ids, n.id, `${path}.id`)
  if (ZONE_KINDS.includes(n.kind)) return d.error(`${path}.kind`, `"${n.kind}" is a zone: list it in "zones" with "contains" instead.`)
  const item = typeof n.kind === 'string' && Object.hasOwn(NODE_KINDS, n.kind) ? NODE_KINDS[n.kind] : null
  if (!item) return d.error(`${path}.kind`, `unknown kind ${json(n.kind)}.${suggest(n.kind, Object.keys(NODE_KINDS)) || ' See the kinds table in the guide.'}`)

  const uml = Object.hasOwn(UML_KINDS, n.kind), table = n.kind === 'table'
  const structured = uml ? ['name', 'stereotype', 'abstract', 'attributes', 'methods', 'values'] : table ? ['name', 'columns'] : []
  c.unknown([...FIELDS.node, ...(structured.length ? structured : ['label']), ...(item.shape === 'component' ? ['icon'] : [])])
  let text
  if (structured.length) {
    if (n.label !== undefined) d.error(`${path}.label`, `kind "${n.kind}" is written with ${uml ? '"name", "attributes" and "methods"' : '"name" and "columns"'}, not "label".`)
    text = uml ? umlText(d, n, path) : tableText(d, n, path)
  } else {
    text = c.text('label') ?? item.text ?? ''
    if (n.kind === 'text' && !text.trim()) d.error(`${path}.label`, 'is required for kind "text".')
  }

  const style = {
    color: c.oneOf('color', COLORS), fill: c.oneOf('fill', FILLS), dash: c.oneOf('dash', DASHES), crossed: c.bool('crossed'),
    size: TEXT_SIZES[c.oneOf('textSize', Object.keys(TEXT_SIZES))], font: c.oneOf('font', ['sans', 'mono']), align: c.oneOf('align', ['left', 'center', 'right']),
    icon: item.shape === 'component' ? c.oneOf('icon', ICONS) : undefined,
    w: c.number('w', LIMITS.minSize, LIMITS.maxSize), h: c.number('h', LIMITS.minSize, LIMITS.maxSize),
  }
  const x = c.number('x', -LIMITS.coord, LIMITS.coord), y = c.number('y', -LIMITS.coord, LIMITS.coord)
  // a layout hint, like x/y: the earliest rank auto layout may give the node
  let rank = c.number('rank', 0, MAX_RANK)
  if (rank !== undefined && !Number.isInteger(rank)) rank = d.error(`${path}.rank`, `must be a whole number from 0 to ${MAX_RANK}; got ${json(n.rank)}.`)
  if (rank !== undefined && manual) d.warn(`${path}.rank`, 'ignored with "layout": "manual" (it is an auto-layout hint).')
  // a "positions" entry replaces the node's own x/y (and w/h when it gives them)
  const pin = id ? positions.get(id) : undefined
  if (pin?.w !== undefined) style.w = pin.w
  if (pin?.h !== undefined) style.h = pin.h
  if (manual && !pin && (x === undefined || y === undefined)) d.error(path, 'needs "x" and "y" (or an entry in "positions") because "layout" is "manual".')
  if (!manual && (n.x !== undefined || n.y !== undefined)) d.error(path, 'has "x"/"y", but "layout" is "auto". Remove them (pin the node in "positions" instead), or set "layout": "manual" and position every node.')
  const cap = capacity(d, n.capacity, `${path}.capacity`)
  const info = meta(d, n.meta, `${path}.meta`)
  if (!id) return
  const props = { ...itemProps(item), ...defined(style), text, ...(cap && { cap }), ...(info && { meta: info }) }
  return { id, item, props, x: pin?.x ?? x ?? 0, y: pin?.y ?? y ?? 0, pin, ...(rank !== undefined && !manual && { rank }) }
}

/** Highest rank hint (columns of auto layout). */
const MAX_RANK = 100

/** Declared metadata: short strings under identifier-like keys; see META. */
function meta(d, v, path) {
  if (v === undefined) return undefined
  if (!isObj(v)) return d.error(path, 'must be an object of short strings, like { "owner": "payments-team" }.')
  const keys = Object.keys(v)
  if (keys.length > META.maxKeys) return d.error(path, `has ${keys.length} keys; the limit is ${META.maxKeys}.`)
  const out = {}
  for (const k of keys) {
    const p = `${path}.${short(k)}`
    if (!metaKeyOk(k)) d.error(p, 'keys start with a lowercase letter, then up to 31 letters, digits, "_" or "-" (and are not a reserved name like "constructor").')
    else if (typeof v[k] !== 'string') d.error(p, `must be a string; got ${json(v[k])}.`)
    else if (v[k].length > META.maxValue) d.error(p, `is longer than ${META.maxValue} characters.`)
    else out[k] = v[k]
  }
  return keys.length ? out : undefined
}

/** The `positions` block: per-view layout, kept apart from the model. Its ids are checked against the nodes later. */
function compilePositions(d, v) {
  const out = new Map()
  if (v === undefined) return out
  if (!isObj(v)) return d.error('positions', 'must be an object mapping node ids to { "x", "y", "w"?, "h"? }.'), out
  const keys = Object.keys(v)
  if (keys.length > LIMITS.nodes) return d.error('positions', `has ${keys.length} entries; the limit is ${LIMITS.nodes}.`), out
  for (const k of keys) {
    const p = `positions.${short(k)}`, e = v[k]
    if (!isObj(e)) {
      d.error(p, `must be { "x": number, "y": number, "w"?: number, "h"?: number }; got ${json(e)}.`)
      continue
    }
    const c = checker(d, e, p)
    c.unknown(FIELDS.position)
    for (const f of ['x', 'y']) if (e[f] === undefined) d.error(`${p}.${f}`, 'is required.')
    const at = { x: c.number('x', -LIMITS.coord, LIMITS.coord), y: c.number('y', -LIMITS.coord, LIMITS.coord), ...defined({ w: c.number('w', LIMITS.minSize, LIMITS.maxSize), h: c.number('h', LIMITS.minSize, LIMITS.maxSize) }) }
    if (at.x !== undefined && at.y !== undefined) out.set(k, at)
  }
  return out
}

/** Declared capacity facts: each field typed and range-checked; see CAPACITY_FIELDS. */
function capacity(d, v, path) {
  if (v === undefined) return undefined
  if (!isObj(v)) return d.error(path, 'must be an object of capacity fields.')
  const c = checker(d, v, path)
  const out = {}
  for (const k of Object.keys(v)) {
    const f = Object.hasOwn(CAPACITY_FIELDS, k) ? CAPACITY_FIELDS[k] : null
    if (!f) {
      d.error(`${path}.${short(k)}`, `unknown capacity field.${suggest(k, Object.keys(CAPACITY_FIELDS)) || ' See "Capacity" in the guide.'}`)
      continue
    }
    const val = f.type === 'boolean' ? c.bool(k) : c.number(k, f.min, f.max)
    if (val === undefined) continue
    if (f.integer && !Number.isInteger(val)) {
      d.error(`${path}.${k}`, `must be a whole number; got ${json(val)}.`)
      continue
    }
    out[k] = val
  }
  return Object.keys(out).length ? out : undefined
}

function compileEnd(d, value, path, nodeIds, manual) {
  if (typeof value === 'string') {
    if (!nodeIds.has(value)) return d.error(path, `refers to unknown node "${value}".${suggest(value, [...nodeIds])}`)
    return { id: value }
  }
  if (isObj(value) && isNum(value.x) && isNum(value.y) && Math.abs(value.x) <= LIMITS.coord && Math.abs(value.y) <= LIMITS.coord) {
    if (!manual) return d.error(path, 'a free point { "x", "y" } needs "layout": "manual".')
    checker(d, value, path).unknown(['x', 'y'])
    return { x: Math.round(value.x), y: Math.round(value.y) }
  }
  d.error(path, `must be a node id or a point { "x": number, "y": number }; got ${json(value)}.`)
}

function compileEdge(d, ids, e, path, nodeIds, manual) {
  if (!isObj(e)) return d.error(path, 'must be an object.')
  const c = checker(d, e, path)
  c.unknown(FIELDS.edge)
  const id = e.id === undefined ? undefined : claimId(d, ids, e.id, `${path}.id`)
  const from = compileEnd(d, e.from, `${path}.from`, nodeIds, manual)
  const to = compileEnd(d, e.to, `${path}.to`, nodeIds, manual)
  if (from?.id && from.id === to?.id) d.error(path, 'connects a node to itself; self-loops are not supported.')
  const kind = c.oneOf('kind', Object.keys(RELATIONS)) ?? (e.kind === undefined ? 'flow' : undefined)
  const fromSide = c.oneOf('fromSide', SIDES), toSide = c.oneOf('toSide', SIDES)
  if (fromSide && !from?.id) d.error(`${path}.fromSide`, 'only applies when "from" is a node.')
  if (toSide && !to?.id) d.error(`${path}.toSide`, 'only applies when "to" is a node.')
  const props = {
    ...(kind && RELATIONS[kind]),
    ...defined({
      head: c.oneOf('head', HEADS), tail: c.oneOf('tail', HEADS), dash: c.oneOf('dash', DASHES),
      route: c.oneOf('route', ROUTES), color: c.oneOf('color', COLORS), stroke: c.number('width', 0.5, 8), text: c.text('label'),
      carries: c.oneOf('carries', CARRIES), share: c.number('share', 0, 1),
    }),
  }
  if (!from || !to || !kind) return
  return { id, kind, from: { ...from, ...(fromSide && { side: fromSide }) }, to: { ...to, ...(toSide && { side: toSide }) }, props }
}

function compileZone(d, ids, z, path, nodeIds) {
  if (!isObj(z)) return d.error(path, 'must be an object.')
  const c = checker(d, z, path)
  c.unknown(FIELDS.zone)
  const id = claimId(d, ids, z.id, `${path}.id`)
  const label = c.text('label', { max: 200 }) ?? ''
  const color = c.oneOf('color', COLORS)
  const trust = c.oneOf('trust', TRUST_LEVELS)
  const padding = c.number('padding', 8, 200) ?? 32
  if (!Array.isArray(z.contains) || !z.contains.length) return d.error(`${path}.contains`, 'must be a non-empty array of node ids.')
  const contains = z.contains.filter((m, i) => {
    const ok = typeof m === 'string' && nodeIds.has(m)
    if (!ok) d.error(`${path}.contains[${i}]`, `refers to unknown node ${json(m)}.${suggest(m, [...nodeIds])} Zones contain nodes, not other zones.`)
    return ok
  })
  if (!id) return
  return { id, label, color, trust, padding, contains: [...new Set(contains)] }
}

function compileFrame(d, ids, f, path, memberIds) {
  if (!isObj(f)) return d.error(path, 'must be an object.')
  const c = checker(d, f, path)
  c.unknown(FIELDS.frame)
  const id = claimId(d, ids, f.id, `${path}.id`)
  const label = c.text('label', { max: 200 }) ?? ''
  const padding = c.number('padding', 8, 400) ?? 40
  if (!Array.isArray(f.contains) || !f.contains.length) return d.error(`${path}.contains`, 'must be a non-empty array of node or zone ids.')
  const contains = f.contains.filter((m, i) => {
    const ok = typeof m === 'string' && memberIds.has(m)
    if (!ok) d.error(`${path}.contains[${i}]`, `refers to unknown node or zone ${json(m)}.${suggest(m, [...memberIds])}`)
    return ok
  })
  if (!id) return
  return { id, label, padding, contains: [...new Set(contains)] }
}

function compileStroke(d, ids, s, path) {
  if (!isObj(s)) return d.error(path, 'must be an object.')
  const c = checker(d, s, path)
  c.unknown(FIELDS.stroke)
  const id = s.id === undefined ? undefined : claimId(d, ids, s.id, `${path}.id`)
  const color = c.oneOf('color', COLORS)
  const width = c.number('width', 1, 20)
  const highlighter = c.bool('highlighter')
  const pts = s.points
  if (!Array.isArray(pts) || pts.length < 2 || pts.length > LIMITS.points) return d.error(`${path}.points`, `must be an array of 2 to ${LIMITS.points} [x, y] pairs.`)
  const points = []
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    if (!Array.isArray(p) || p.length !== 2 || !p.every((v) => isNum(v) && Math.abs(v) <= LIMITS.coord)) return d.error(`${path}.points[${i}]`, `must be [x, y] with |x|, |y| ≤ ${LIMITS.coord}.`)
    points.push({ x: p[0], y: p[1] })
  }
  const span = (k) => Math.max(...points.map((p) => p[k])) - Math.min(...points.map((p) => p[k]))
  if (span('x') > LIMITS.strokeSpan || span('y') > LIMITS.strokeSpan) return d.error(`${path}.points`, `spans more than ${LIMITS.strokeSpan} px; draw it as several strokes.`)
  return { id, points, props: defined({ color, stroke: width, marker: highlighter }) }
}

/** Next free generated id like e1, e2 … that no explicit id has taken. */
function allocator(ids) {
  const next = { e: 1, s: 1 }
  return (prefix) => {
    while (ids.has(`${prefix}${next[prefix]}`)) next[prefix]++
    const id = `${prefix}${next[prefix]++}`
    ids.add(id)
    return id
  }
}

/**
 * The ids the compiler gives edges and strokes: an explicit id is kept; the rest get e1, e2 … and
 * s1, s2 … in array order, skipping every explicit id in the file. source/index.js uses this same
 * function, so diagnostics, source spans and canvas ids agree. (null marks an invalid explicit id.)
 */
export function assignIds(input) {
  const arr = (k) => (isObj(input) && Array.isArray(input[k]) ? input[k] : [])
  const taken = new Set()
  for (const k of ['nodes', 'zones', 'edges', 'strokes', 'frames']) for (const o of arr(k)) if (typeof o?.id === 'string') taken.add(o.id)
  const next = allocator(taken)
  const pick = (prefix) => (o) => (typeof o?.id === 'string' ? o.id : o?.id === undefined ? next(prefix) : null)
  return { edges: arr('edges').map(pick('e')), strokes: arr('strokes').map(pick('s')) }
}

function list(d, input, key, max) {
  const v = input[key]
  if (v === undefined) return []
  if (!Array.isArray(v)) return d.error(key, 'must be an array.'), []
  if (v.length > max) return d.error(key, `has ${v.length} entries; the limit is ${max}.`), []
  return v
}

/**
 * Compile an authoring object. Returns { errors, warnings, name, board?, doc? }:
 * `board` is a validated { base, done, undone } whose history builds the
 * diagram one element per step, in document order.
 */
export function compileDiagram(input, { measure = measureText } = {}) {
  const d = createDiagnostics()
  const fail = () => ({ errors: d.errors, warnings: d.warnings, name: null })
  if (!isObj(input)) return d.error('', 'the file must be a JSON object.'), fail()
  if (input.format !== FORMAT) d.error('format', `must be "${FORMAT}"; got ${json(input.format)}.`)
  if (input.version !== VERSION) d.error('version', `must be ${VERSION}; got ${json(input.version)}.`)
  if (d.errors.length) return fail()
  const top = checker(d, input, '')
  for (const k of Object.keys(input)) {
    if (k === 'theme') d.warn('theme', 'ignored: diagrams use colour tokens that follow each viewer\'s light or dark theme.')
    else if (!FIELDS.top.includes(k)) d.warn(short(k), `unknown field, ignored.${suggest(k, FIELDS.top)}`)
  }
  const name = (top.text('name', { max: 120 }) ?? '').trim() || 'Untitled diagram'
  const manual = (top.oneOf('layout', ['auto', 'manual']) ?? 'auto') === 'manual'
  const direction = top.oneOf('direction', ['LR', 'TB']) ?? 'LR'
  if (manual && input.direction !== undefined) d.warn('direction', 'ignored with "layout": "manual".')

  const ids = new Set()
  const positions = compilePositions(d, input.positions)
  const rawNodes = list(d, input, 'nodes', LIMITS.nodes)
  const rawZones = list(d, input, 'zones', LIMITS.zones)
  const rawEdges = list(d, input, 'edges', LIMITS.edges)
  const rawStrokes = list(d, input, 'strokes', LIMITS.strokes)
  const rawFrames = list(d, input, 'frames', LIMITS.frames)
  if (!rawNodes.length && !d.errors.some((e) => e.path === 'nodes')) d.error('nodes', 'add at least one node.')
  if (!manual && rawStrokes.length) d.error('strokes', 'freehand strokes use absolute coordinates, so they need "layout": "manual".')
  const total = rawNodes.length + rawZones.length + rawEdges.length + rawStrokes.length + rawFrames.length
  if (total > BOARD.elements) d.error('', `the diagram would have ${total} elements; the limit is ${BOARD.elements}.`)
  if (d.errors.length) return fail()

  const nodes = rawNodes.map((n, i) => compileNode(d, ids, n, `nodes[${i}]`, manual, positions)).filter(Boolean)
  // references resolve against every declared node id, so one bad node doesn't cascade into "unknown node" errors
  const nodeIds = new Set(rawNodes.map((n) => n?.id).filter((v) => typeof v === 'string' && ids.has(v)))
  const zones = rawZones.map((z, i) => compileZone(d, ids, z, `zones[${i}]`, nodeIds)).filter(Boolean)
  const zoneIds = new Set(rawZones.map((z) => z?.id).filter((v) => typeof v === 'string'))
  for (const k of isObj(input.positions) ? Object.keys(input.positions) : []) {
    if (nodeIds.has(k)) continue
    d.error(`positions.${short(k)}`, zoneIds.has(k) ? `"${k}" is a zone; zones are sized from their members, so position the members instead.` : `refers to unknown node ${json(k)}.${suggest(k, [...nodeIds])}`)
  }
  const endIds = new Set([...nodeIds, ...zones.map((z) => z.id)])
  const edges = rawEdges.map((e, i) => compileEdge(d, ids, e, `edges[${i}]`, endIds, manual)).filter(Boolean)
  const strokes = rawStrokes.map((s, i) => compileStroke(d, ids, s, `strokes[${i}]`)).filter(Boolean)
  const frames = rawFrames.map((f, i) => compileFrame(d, ids, f, `frames[${i}]`, endIds)).filter(Boolean)
  if (d.errors.length) return fail()

  // Generated ids follow each collection's order (never drawing order), after every explicit id is claimed.
  // With no errors every raw edge and stroke compiled, so the indices line up.
  const assigned = assignIds(input)
  edges.forEach((e, i) => { e.id = assigned.edges[i] })
  strokes.forEach((s, i) => { s.id = assigned.strokes[i] })

  // Build runtime nodes (content-fitted), then place them.
  const built = new Map()
  nodes.forEach((n, i) => {
    if (n.props.text.length > BOARD.text) d.error(`nodes[${i}]`, `its text comes to ${n.props.text.length} characters; the limit for one node is ${BOARD.text}. Split it across nodes.`)
    const el = fitNode({ ...makeNode(n.item.shape, n.x, n.y, n.props), id: n.id }, measure)
    if (el.w > LIMITS.maxSize || el.h > LIMITS.maxSize) d.error(`nodes[${i}]`, `its content needs ${Math.ceil(el.w)}×${Math.ceil(el.h)}, more than the ${LIMITS.maxSize} limit; shorten it.`)
    built.set(n.id, el)
  })
  if (d.errors.length) return fail()
  if (!manual) {
    const flow = edges.filter((e) => e.from.id && e.to.id && nodeIds.has(e.from.id) && nodeIds.has(e.to.id))
      .map((e) => (PARENT_POINTING.has(e.kind) ? { from: e.to.id, to: e.from.id } : { from: e.from.id, to: e.to.id }))
    const minRank = new Map(nodes.filter((n) => n.rank !== undefined).map((n) => [n.id, n.rank]))
    const at = layeredLayout([...built.values()], flow, { direction, minRank })
    for (const [id, p] of at) built.set(id, { ...built.get(id), ...p })
    // pins apply after layout, so pinning one node never moves the others
    for (const n of nodes) if (n.pin) built.set(n.id, { ...built.get(n.id), x: n.pin.x, y: n.pin.y })
  }

  // Zones wrap their members (members never move); in auto layout warn if a non-member lands inside.
  const zoneEls = zones.map((z, i) => {
    const members = z.contains.map((m) => built.get(m))
    const x0 = Math.min(...members.map((m) => m.x)) - z.padding, y0 = Math.min(...members.map((m) => m.y)) - z.padding - ZONE_LABEL_SPACE
    const x1 = Math.max(...members.map((m) => m.x + m.w)) + z.padding, y1 = Math.max(...members.map((m) => m.y + m.h)) + z.padding
    const props = { text: z.label, ...(z.color && { color: z.color }), ...(z.trust && { trust: z.trust }), members: [...z.contains].sort() }
    const el = { ...makeNode('zone', Math.round(x0), Math.round(y0), props), id: z.id, w: Math.round(x1 - x0), h: Math.round(y1 - y0), z: -1000 + i }
    if (el.w > LIMITS.maxSize * 4 || el.h > LIMITS.maxSize * 4) d.error(`zones[${i}]`, 'its members are spread too far apart.')
    const strays = [...built.values()].filter((n) => !z.contains.includes(n.id) && n.x < x1 && n.x + n.w > x0 && n.y < y1 && n.y + n.h > y0)
    if (strays.length) d.warn(`zones[${i}]`, `overlaps ${strays.map((n) => `"${n.id}"`).join(', ')}, which ${strays.length > 1 ? 'are' : 'is'} not in "contains".${manual ? '' : ' Auto layout ignores zones; use "layout": "manual" for exact grouping.'}`)
    return el
  })
  if (d.errors.length) return fail()

  // Frames (presentation slides, in array order) wrap their members' visual bounds, labels included.
  // A frame whose members include another frame's members is drawn around that frame with a margin,
  // so nested slides (overview → detail) never share an edge and their titles stack instead of colliding.
  const boxes = new Map([...built.values(), ...zoneEls].map((el) => [el.id, el]))
  const rects = new Map()
  const nests = (outer, inner) => outer !== inner && inner.contains.every((m) => outer.contains.includes(m)) && (outer.contains.length > inner.contains.length || frames.indexOf(outer) > frames.indexOf(inner))
  for (const f of [...frames].sort((a, b) => a.contains.length - b.contains.length || frames.indexOf(a) - frames.indexOf(b))) {
    const members = f.contains.map((m) => boxes.get(m))
    let x0 = Math.min(...members.map((m) => m.x)) - f.padding, y0 = Math.min(...members.map((m) => m.y)) - f.padding
    let x1 = Math.max(...members.map((m) => m.x + m.w)) + f.padding, y1 = Math.max(...members.map((m) => m.y + m.h + (m.shape === 'actor' ? m.size * 2.7 : 0))) + f.padding
    for (const inner of frames) {
      const r = rects.get(inner)
      if (!r || !nests(f, inner)) continue
      x0 = Math.min(x0, r.x0 - FRAME_NEST); y0 = Math.min(y0, r.y0 - FRAME_NEST)
      x1 = Math.max(x1, r.x1 + FRAME_NEST); y1 = Math.max(y1, r.y1 + FRAME_NEST)
    }
    rects.set(f, { x0, y0, x1, y1 })
  }
  const frameEls = frames.map((f, i) => {
    const { x0, y0, x1, y1 } = rects.get(f)
    return { ...makeNode('frame', Math.round(x0), Math.round(y0), { text: f.label, order: i + 1, members: [...f.contains].sort() }), id: f.id, w: Math.round(x1 - x0), h: Math.round(y1 - y0), z: -2000 + i }
  })

  // Construction history: zones, then nodes in document order, each edge as soon as its nodes exist, then strokes.
  // Each element is one transaction adding it, exactly what a store would record for one `set` per element; it is
  // built directly because copying the document on every step would make compiling quadratic in its size.
  let tick = 0
  const done = [], doc = {}
  const record = (el, label) => {
    done.push({ label, merge: null, t: ++tick, changes: [[el.id, null, el]] })
    doc[el.id] = el
  }
  let z = 1
  const put = (el, label) => record({ ...el, z: z++ }, label)
  for (const el of zoneEls) record(el, 'add zone')
  const placed = new Set(zoneEls.map((zEl) => zEl.id))
  const pending = edges.map((e, i) => ({ ...e, i, needs: [e.from.id, e.to.id].filter(Boolean) }))
  const waiting = new Map() // node or zone id → pending edges that need it
  for (const e of pending) for (const n of e.needs) waiting.set(n, [...(waiting.get(n) ?? []), e])
  const connect = (list) => {
    for (const e of list) {
      if (e.done || !e.needs.every((n) => placed.has(n))) continue
      e.done = true
      put({ ...makeEdge(e.from, e.to, e.props), id: e.id }, 'connect')
    }
  }
  connect(pending)
  for (const n of nodes) {
    put(built.get(n.id), 'add ' + n.item.shape)
    placed.add(n.id)
    // the edges this node completes, in document order
    connect([...new Set(waiting.get(n.id) ?? [])].sort((a, b) => a.i - b.i))
  }
  for (const s of strokes) put({ ...makeStroke(s.points, s.props), id: s.id }, 'draw')
  for (const el of frameEls) record(el, 'add frame')

  const base = {}, undone = []
  const checked = validateBoard({ base, done, undone, doc })
  if (checked.error || checked.warning) {
    d.error('', `internal: the compiled board failed validation (${checked.error ?? checked.warning}). Please report this file.`)
    return fail()
  }
  return { errors: d.errors, warnings: d.warnings, name, board: checked.board, doc }
}
