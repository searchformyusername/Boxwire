// Agent round trip. A critique bundle hands an agent the typed graph, every
// review result and the score, stamped with the board's content hash. The
// agent answers with a `boxwire-patch`: an explicit list of operations on
// stable element ids, carrying that baseline hash. A patch is validated in
// full against the current board (a stale baseline is refused) and applied
// as one undoable transaction, or not at all.

import { CAPACITY_FIELDS, CARRIES, NODE_KINDS, RELATIONS } from './vocabulary.js'
import { itemProps } from '../catalog.js'
import { fitNode, isEdge, isNode, makeEdge, makeNode } from '../core/elements.js'
import { capProblem } from '../core/declared.js'
import { docProblem, isSafeId } from '../core/validate.js'
import { ID_PATTERN } from './vocabulary.js'

export const PATCH_FORMAT = 'boxwire-patch'
export const CRITIQUE_FORMAT = 'boxwire-critique'
export const MAX_OPS = 500
const OPS = ['add-node', 'connect', 'set-capacity', 'set-label', 'set-kind', 'cross-out', 'remove']

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v)

/** SHA-256 (hex) of a document's canonical JSON: the baseline a patch must name. */
export async function docHash(doc) {
  const bytes = new TextEncoder().encode(JSON.stringify(sortKeys(doc)))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Validate a patch against `doc`. Returns { errors, ops } where errors carry
 * JSON paths; ops are normalised. Nothing is applied here.
 */
export function checkPatch(patch, doc, baseline) {
  const errors = []
  const err = (path, message) => errors.length < 100 && errors.push({ path, message })
  if (!isObj(patch) || patch.format !== PATCH_FORMAT) return { errors: [{ path: 'format', message: `must be "${PATCH_FORMAT}".` }], ops: [] }
  if (patch.version !== 1) err('version', 'must be 1.')
  if (typeof patch.baseline !== 'string') err('baseline', 'is required: the board hash from the critique bundle.')
  else if (patch.baseline !== baseline) err('baseline', 'doesn\'t match this board: it changed since the critique bundle was exported. Export a new bundle and ask again.')
  if (!Array.isArray(patch.ops) || !patch.ops.length || patch.ops.length > MAX_OPS) err('ops', `must be an array of 1 to ${MAX_OPS} operations.`)
  if (errors.length) return { errors, ops: [] }

  // operations are checked against the state as it will be when each one runs: a removed node (and the
  // connectors removed with it) can't be the target of a later operation
  const ids = new Set(Object.keys(doc))
  const nodeIds = new Set(Object.values(doc).filter(isNode).map((n) => n.id))
  const ends = new Map(Object.values(doc).filter(isEdge).map((e) => [e.id, [e.from.id, e.to.id]]))
  const ops = []
  const removed = new Set()
  patch.ops.forEach((o, i) => {
    const p = `ops[${i}]`
    if (!isObj(o) || !OPS.includes(o.op)) return err(`${p}.op`, `must be one of ${OPS.map((x) => `"${x}"`).join(', ')}.`)
    const needNode = (k = 'id') => {
      if (!nodeIds.has(o[k])) err(`${p}.${k}`, `refers to unknown node ${JSON.stringify(o[k])}${removed.has(o[k]) ? ' (an earlier operation removed it)' : ''}.`)
    }
    const capOk = (cap, path) => {
      if (!isObj(cap)) return err(path, 'must be an object of capacity fields.')
      const set = Object.fromEntries(Object.entries(cap).filter(([, v]) => v !== null))
      for (const k of Object.keys(cap)) if (!Object.hasOwn(CAPACITY_FIELDS, k)) err(`${path}.${k}`, 'unknown capacity field.')
      const problem = capProblem(set)
      if (problem && !problem.startsWith('unknown')) err(path, problem + '.')
    }
    switch (o.op) {
      case 'add-node':
        if (typeof o.id !== 'string' || !ID_PATTERN.test(o.id) || !isSafeId(o.id)) err(`${p}.id`, 'must be a new id (a letter, then letters, digits, "_" or "-").')
        else if (ids.has(o.id)) err(`${p}.id`, `"${o.id}" is already used.`)
        else ids.add(o.id), nodeIds.add(o.id)
        if (!Object.hasOwn(NODE_KINDS, o.kind)) err(`${p}.kind`, `unknown kind ${JSON.stringify(o.kind)}.`)
        if (o.label !== undefined && (typeof o.label !== 'string' || o.label.length > 2000)) err(`${p}.label`, 'must be a string of at most 2000 characters.')
        if (o.capacity !== undefined) capOk(o.capacity, `${p}.capacity`)
        if (o.near !== undefined && !nodeIds.has(o.near)) err(`${p}.near`, `refers to unknown node ${JSON.stringify(o.near)}.`)
        break
      case 'connect':
        needNode('from')
        needNode('to')
        if (o.from === o.to) err(p, 'connects a node to itself.')
        if (o.kind !== undefined && !Object.hasOwn(RELATIONS, o.kind)) err(`${p}.kind`, `unknown relation ${JSON.stringify(o.kind)}.`)
        if (o.carries !== undefined && !CARRIES.includes(o.carries)) err(`${p}.carries`, `must be one of ${CARRIES.join(', ')}.`)
        if (o.share !== undefined && !(typeof o.share === 'number' && o.share >= 0 && o.share <= 1)) err(`${p}.share`, 'must be a number from 0 to 1.')
        if (o.id !== undefined) {
          if (typeof o.id !== 'string' || !ID_PATTERN.test(o.id) || ids.has(o.id)) err(`${p}.id`, 'must be a new, valid id.')
          else ids.add(o.id), ends.set(o.id, [o.from, o.to])
        }
        break
      case 'set-capacity':
        needNode()
        capOk(o.capacity, `${p}.capacity`)
        break
      case 'set-label':
        if (!ids.has(o.id)) err(`${p}.id`, `refers to unknown element ${JSON.stringify(o.id)}${removed.has(o.id) ? ' (an earlier operation removed it)' : ''}.`)
        if (typeof o.label !== 'string' || o.label.length > 2000) err(`${p}.label`, 'must be a string of at most 2000 characters.')
        break
      case 'set-kind':
        needNode()
        if (!Object.hasOwn(NODE_KINDS, o.kind)) err(`${p}.kind`, `unknown kind ${JSON.stringify(o.kind)}.`)
        break
      case 'cross-out':
        needNode()
        if (typeof o.crossed !== 'boolean') err(`${p}.crossed`, 'must be true or false.')
        break
      case 'remove':
        if (!ids.has(o.id)) {
          err(`${p}.id`, `refers to unknown element ${JSON.stringify(o.id)}${removed.has(o.id) ? ' (an earlier operation removed it)' : ''}.`)
          break
        }
        ids.delete(o.id)
        removed.add(o.id)
        if (nodeIds.delete(o.id)) {
          for (const [e, [a, b]] of ends) if (a === o.id || b === o.id) ids.delete(e), ends.delete(e), removed.add(e)
        } else ends.delete(o.id)
        break
    }
    ops.push(o)
  })
  return { errors, ops: errors.length ? [] : ops }
}

/**
 * The changes a validated patch makes to `doc`, as [id, element|null] entries
 * for one store transaction, plus a one-line summary per operation.
 * `place(w, h, near)` picks a centre for new nodes (the editor's free-spot search).
 */
export function planPatch(doc, ops, opts) {
  try {
    return plan(doc, ops, opts)
  } catch (err) {
    return { entries: [], summary: [], doc, problem: `the patch could not be planned (${err.message})` }
  }
}

function plan(doc, ops, { measure, place, zTop = 1 }) {
  const next = { ...doc }
  const touched = new Set()
  const summary = []
  let z = zTop
  const label = (id) => (String(next[id]?.text || '').split('\n')[0] || id)
  const put = (el) => {
    next[el.id] = el
    touched.add(el.id)
  }
  for (const o of ops) {
    if (o.op === 'add-node') {
      const item = NODE_KINDS[o.kind]
      const cap = o.capacity && Object.fromEntries(Object.entries(o.capacity).filter(([, v]) => v !== null))
      let n = fitNode(makeNode(item.shape, 0, 0, { ...itemProps(item), ...(o.label !== undefined && { text: o.label }), ...(cap && Object.keys(cap).length && { cap }), z: z++ }), measure)
      const c = place(n.w, n.h, o.near && next[o.near])
      n = { ...n, id: o.id, x: Math.round(c.x - n.w / 2), y: Math.round(c.y - n.h / 2) }
      put(n)
      summary.push(`Add ${o.kind} “${label(o.id)}”`)
    } else if (o.op === 'connect') {
      const rel = RELATIONS[o.kind ?? 'flow']
      const e = { ...makeEdge({ id: o.from }, { id: o.to }, { ...rel, z: z++, ...(o.label && { text: o.label }), ...(o.carries && { carries: o.carries }), ...(o.share !== undefined && { share: o.share }) }), ...(o.id && { id: o.id }) }
      put(e)
      summary.push(`Connect “${label(o.from)}” → “${label(o.to)}”${o.kind && o.kind !== 'flow' ? ` (${o.kind})` : ''}`)
    } else if (o.op === 'set-capacity') {
      const cap = { ...next[o.id].cap }
      for (const [k, v] of Object.entries(o.capacity)) v === null ? delete cap[k] : (cap[k] = v)
      const el = { ...next[o.id], cap }
      if (!Object.keys(cap).length) delete el.cap
      put(el)
      summary.push(`Declare on “${label(o.id)}”: ${Object.entries(o.capacity).map(([k, v]) => `${k} ${v === null ? 'cleared' : `= ${v}`}`).join(', ')}`)
    } else if (o.op === 'set-label') {
      const el = { ...next[o.id], text: o.label }
      put(isNode(el) ? fitNode(el, measure) : el)
      summary.push(`Relabel “${label(o.id)}”`)
    } else if (o.op === 'set-kind') {
      put({ ...next[o.id], kind: o.kind })
      summary.push(`“${label(o.id)}” is a ${o.kind}`)
    } else if (o.op === 'cross-out') {
      put({ ...next[o.id], crossed: o.crossed })
      summary.push(`${o.crossed ? 'Cross out' : 'Restore'} “${label(o.id)}”`)
    } else if (o.op === 'remove') {
      summary.push(`Remove “${label(o.id)}”`)
      delete next[o.id]
      touched.add(o.id)
      for (const el of Object.values(next)) {
        if (isEdge(el) && (el.from.id === o.id || el.to.id === o.id)) {
          delete next[el.id]
          touched.add(el.id)
        }
      }
    }
  }
  const problem = docProblem(next)
  return { entries: [...touched].map((id) => [id, next[id] ?? null]), summary, doc: next, problem }
}
