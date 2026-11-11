// Schema checks for anything entering the editor from outside memory
// (imported files, IndexedDB rows, pasted JSON). Validation never mutates the
// live board: callers get a clean copy or a reason.

import { SHAPES } from './elements.js'
import { COLOR_NAMES } from '../render/theme.js'
import { ICON_NAMES } from '../render/icons.js'
import { capProblem, carriesOk, kindOk, metaProblem, shareOk, trustOk } from './declared.js'

export const LIMITS = { fileBytes: 25 * 1024 * 1024, elements: 5000, text: 20000, points: 40000, txns: 20000, coord: 1e6 }
const SIDES = new Set(['n', 'e', 's', 'w'])
const FILLS = new Set(['paper', 'tint', 'solid', 'none'])
const DASHES = new Set(['solid', 'dashed', 'dotted'])
const ROUTES = new Set(['ortho', 'straight', 'curve'])
const HEADS = new Set(['none', 'arrow', 'open', 'triangle', 'diamond', 'diamondFilled', 'circle', 'one', 'many', 'oneMany', 'zeroMany'])
const FONTS = new Set(['sans', 'mono'])
const ALIGNS = new Set(['left', 'center', 'right'])

const finite = (v, max = LIMITS.coord) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max
// Names inherited from Object.prototype ('constructor', '__proto__', ...) would alias prototype
// members in the plain-object document map, so they are never valid ids.
export const isSafeId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64 && !(v in Object.prototype)
const id = isSafeId
const COLOR_SET = new Set(COLOR_NAMES)
const ICON_SET = new Set(ICON_NAMES)
const str = (v, max = LIMITS.text) => typeof v === 'string' && v.length <= max

function styleOk(el) {
  return COLOR_SET.has(el.color) && (el.fill === undefined || FILLS.has(el.fill)) &&
    (el.dash === undefined || DASHES.has(el.dash)) && finite(el.stroke, 40) && el.stroke >= 0
}
const textStyleOk = (el) => finite(el.size, 400) && el.size > 0 && FONTS.has(el.font) && (el.align === undefined || ALIGNS.has(el.align))

function endOk(end) {
  if (!end || typeof end !== 'object') return false
  if (end.id !== undefined) return id(end.id) && (end.side === undefined || SIDES.has(end.side)) && (end.t === undefined || (finite(end.t, 1) && end.t >= 0))
  return finite(end.x) && finite(end.y)
}

/** Returns null when the element is well-formed, otherwise a short reason. */
export function elementProblem(el) {
  if (!el || typeof el !== 'object' || !id(el.id)) return 'bad id'
  if (!finite(el.z, 1e9)) return 'bad z'
  if (!styleOk(el)) return 'bad style'
  if (el.type === 'node') {
    if (typeof el.shape !== 'string' || !Object.hasOwn(SHAPES, el.shape)) return 'unknown shape'
    if (!textStyleOk(el)) return 'bad text style'
    if (![el.x, el.y].every((v) => finite(v)) || !finite(el.w, 1e5) || !finite(el.h, 1e5) || el.w <= 0 || el.h <= 0) return 'bad geometry'
    if (!str(el.text)) return 'bad text'
    if (el.icon !== undefined && !ICON_SET.has(el.icon)) return 'bad icon'
    if (!kindOk(el.kind)) return 'bad kind'
    if (el.order !== undefined && !finite(el.order, 1e9)) return 'bad order'
    // declared membership and trust belong to containers only
    const container = el.shape === 'zone' || el.shape === 'frame'
    if (el.members !== undefined && !(container && Array.isArray(el.members) && el.members.length <= LIMITS.elements && el.members.every(id))) return 'bad members'
    if (el.trust !== undefined && !(el.shape === 'zone' && trustOk(el.trust))) return 'bad trust'
    return capProblem(el.cap) ?? metaProblem(el.meta)
  }
  if (el.type === 'edge') {
    if (!endOk(el.from) || !endOk(el.to)) return 'bad endpoint'
    if (!ROUTES.has(el.route) || !HEADS.has(el.head) || !HEADS.has(el.tail)) return 'bad connector style'
    if (!textStyleOk(el)) return 'bad text style'
    if (!carriesOk(el.carries)) return 'bad carries'
    if (!shareOk(el.share)) return 'bad share'
    return str(el.text) ? null : 'bad label'
  }
  if (el.type === 'stroke') {
    if (![el.x, el.y].every((v) => finite(v)) || ![el.w, el.h, el.pw, el.ph].every((v) => finite(v, 1e5) && v > 0)) return 'bad geometry'
    if (!Array.isArray(el.pts) || el.pts.length > LIMITS.points || el.pts.length % 2 || !el.pts.every((v) => finite(v, 1e5))) return 'bad points'
    return null
  }
  return 'unknown type'
}

/** Validate a document map; edges must point at nodes that exist. */
export function docProblem(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'not a document'
  const els = Object.entries(doc)
  if (els.length > LIMITS.elements) return `more than ${LIMITS.elements} elements`
  for (const [key, el] of els) {
    const p = elementProblem(el)
    if (p) return `${key}: ${p}`
    if (key !== el.id) return `${key}: id mismatch`
  }
  for (const [, el] of els) {
    if (el.type !== 'edge') continue
    for (const end of [el.from, el.to]) if (end.id && doc[end.id]?.type !== 'node') return `${el.id}: dangling connector`
  }
  return null
}

function txnOk(t) {
  if (!t || typeof t !== 'object' || !Array.isArray(t.changes)) return false
  const ids = new Set()
  return t.changes.every((c) => {
    if (!Array.isArray(c) || c.length !== 3 || !id(c[0]) || ids.has(c[0])) return false
    ids.add(c[0])
    return [c[1], c[2]].every((v) => v === null || (v?.id === c[0] && !elementProblem(v)))
  })
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** Replays txns forward from `doc`, requiring every before-image to match; returns the result or null. */
function replayChecked(doc, txns) {
  // one copy, mutated in place: replaying a long history stays linear in its size
  const cur = { ...doc }
  for (const t of txns) {
    if (!t.changes.every(([key, before]) => same(cur[key], before))) return null
    for (const [key, , after] of t.changes) {
      if (after) cur[key] = after
      else delete cur[key]
    }
  }
  return cur
}

/**
 * Validates a saved board { base, done, undone, doc, checkpoint }. History must
 * replay exactly: each change's before-image has to match the document it
 * applies to, for both the done list and the redo chain. A broken history is
 * recoverable: the document survives and the replay starts from it.
 */
export function validateBoard(data) {
  if (!data || typeof data !== 'object') return { error: 'Not a Boxwire board.' }
  const doc = data.doc ?? null
  const base = data.base ?? {}
  const done = Array.isArray(data.done) ? data.done : []
  const undone = Array.isArray(data.undone) ? data.undone : []
  const historyOk = done.length + undone.length <= LIMITS.txns && !docProblem(base) && done.every(txnOk) && undone.every(txnOk)
  const folded = historyOk ? replayChecked(base, done) : null
  if (folded && !docProblem(folded) && (!doc || same(sortKeys(folded), sortKeys(doc))) && replayChecked(folded, [...undone].reverse())) {
    return { board: { base, done, undone, checkpoint: data.checkpoint === true }, warning: null }
  }
  const problem = docProblem(doc)
  if (problem) return { error: `This board can’t be opened (${problem}).` }
  return { board: { base: doc, done: [], undone: [], checkpoint: true }, warning: 'The build history was damaged, so the timelapse starts from the current diagram.' }
}

const sortKeys = (doc) => Object.fromEntries(Object.keys(doc).sort().map((k) => [k, doc[k]]))

/** Parse an exported .boxwire.json file. */
export function parseBoardFile(text) {
  if (text.length > LIMITS.fileBytes) return { error: 'File is larger than 25 MB.' }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    return { error: 'File is not valid JSON.' }
  }
  if (json?.format !== 'boxwire' || json.version !== 1) return { error: 'Not a Boxwire file.' }
  const res = validateBoard(json.board)
  return res.error ? res : { ...res, name: str(json.name, 120) && json.name.trim() ? json.name.trim() : 'Imported board' }
}
