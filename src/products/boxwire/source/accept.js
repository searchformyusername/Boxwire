// Accepted changes → a minimal source patch. Given the baseline source text
// and the model changes a reviewer accepted (change/diff.js, closed over
// references by change/merge.js acceptChanges), this writes each change as
// the smallest source edit by stable id: a property set, an inserted or
// removed item, a position. Comments and formatting everywhere else stay
// byte-identical; the file is never regenerated. What can't be expressed is
// reported, never approximated by a rewrite.

import { parseSource } from './cst.js'
import { createSourceEditor, ownComments } from './edit.js'
import { indexSource } from './index.js'
import { assignIds } from '../author/compile.js'
import { COLLECTION, keyEdges } from '../change/model.js'

const ORDER = { add: 0, change: 1, remove: 2 }
const ENTITY_ORDER = { zone: 0, node: 1, edge: 2, frame: 3, diagram: 4 }

/** The proposal's item for a change key (edges by stable key, everything else by id). */
function itemOf(value, entity, key) {
  const list = Array.isArray(value?.[COLLECTION[entity]]) ? value[COLLECTION[entity]] : []
  if (entity !== 'edge') return list.find((o) => o?.id === key) ?? null
  const keys = keyEdges(list)
  const i = keys.indexOf(key)
  return i >= 0 ? list[i] : list.find((o) => o?.id === key) ?? null
}

/** The id the source layer addresses an edge by (explicit, or the compiler's generated e1, e2 …). */
function edgeIdIn(value, key) {
  const list = Array.isArray(value?.edges) ? value.edges : []
  const ids = assignIds(value).edges
  const keys = keyEdges(list)
  const i = keys.indexOf(key) >= 0 ? keys.indexOf(key) : list.findIndex((o) => o?.id === key)
  return i >= 0 ? ids[i] : null
}

/**
 * One source op for one change, against the current value; null when not expressible. `fixed` maps a
 * baseline edge key to the id it compiled with: that id stays valid throughout (the source layer writes it
 * down whenever an edit would shift it), even after a reconnect changes the edge's from->to:kind key.
 */
function opFor(change, current, proposal, fixed, notesOf) {
  const { type, entity, key, field } = change
  if (entity === 'diagram') {
    const m = /^positions\.(.+)$/.exec(field ?? '')
    if (!m && ['name', 'layout', 'direction', '$schema'].includes(field)) return { op: 'setTop', key: field, value: change.after }
    if (!m) return { unsupported: `top-level "${field}" changes are not written back` }
    if (change.after === undefined) return { op: 'remove', entity: 'position', id: m[1] }
    return { op: 'setPosition', id: m[1], ...change.after }
  }
  let live = null
  const edgeId = (k) => {
    live ??= new Set(assignIds(current).edges)
    return fixed.has(k) && live.has(fixed.get(k)) ? fixed.get(k) : edgeIdIn(current, k)
  }
  const id = entity === 'edge' ? edgeId(key) : key
  if (type === 'add') {
    const value = itemOf(proposal, entity, key)
    if (!value) return { unsupported: `the proposal has no ${entity} ${key}` }
    let after = change.anchor != null ? (entity === 'edge' ? edgeId(change.anchor) : change.anchor) : undefined
    // an anchor that isn't in the source (rejected, or never there) places the item last instead
    const list = Array.isArray(current?.[COLLECTION[entity]]) ? current[COLLECTION[entity]] : []
    if (after && !(entity === 'edge' ? assignIds(current).edges.includes(after) : list.some((o) => o?.id === after))) after = undefined
    const comments = notesOf(entity, key)
    return { op: 'insert', entity, value, ...(after && { after }), ...(comments.length && { comments }) }
  }
  if (!id) return { skip: true } // already removed by an earlier cascade (a node's edges go with it)
  if (type === 'remove') return { op: 'remove', entity, id }
  const path = field.split('.')
  if (path[0] === 'contains') {
    // membership is diffed per member and written per member, so comments inside the array stay
    const member = field.slice('contains.'.length)
    if (change.after !== true) return { op: 'removeMember', entity, id, member }
    const order = itemOf(proposal, entity, key)?.contains ?? []
    const have = itemOf(current, entity, key)?.contains ?? []
    // place it after the nearest member before it in the proposal that the source already has
    const prev = order.slice(0, Math.max(0, order.indexOf(member))).reverse().find((m) => have.includes(m))
    return { op: 'addMember', entity, id, member, ...(prev !== undefined && { after: prev }) }
  }
  // an id given to an id-less edge only pins its identity (a layout-class change); the source layer pins ids itself when it must
  if (path[0] === 'id') return { skip: true }
  return { op: 'set', entity, id, path, value: change.after }
}

/**
 * Write `changes` (Change objects from change/diff.js, all from base → proposal)
 * into `baseText`. Returns { text, edits, applied: [changeId], skipped, unsupported: [{ id, reason }], error? }.
 * Given the proposal's text (`proposalText`, or several texts in order), what it says in comments travels too: an added item brings
 * the comments that belong to it, and the proposal's header (the comments before its first field:
 * provenance, an import's loss report) is merged into the baseline's (see mergeHeader) when `header` is true:
 * by default when anything is accepted; reviewSources also sets it when the reviewer accepts everything.
 */
export function sourceForChanges(baseText, changes, proposal, proposalText = null, { header = changes.length > 0 } = {}) {
  // one editor for the whole patch: each change is written against the text the previous ones left, read once
  const ed = createSourceEditor(baseText)
  if (ed.error) return { error: parseSource(baseText).errors[0]?.message ?? 'The baseline source does not parse.' }
  // membership: additions before removals, so a container never passes through having no members
  const member = (c) => (c.type === 'change' && c.field?.startsWith('contains.') ? (c.after === true ? 0 : 2) : 1)
  // additions in the proposal's own order, so each one's anchor (the sibling before it) is already written
  const ordered = [...changes].sort((a, b) => ORDER[a.type] - ORDER[b.type] || (a.type === 'remove' ? ENTITY_ORDER[b.entity] - ENTITY_ORDER[a.entity] : ENTITY_ORDER[a.entity] - ENTITY_ORDER[b.entity]) || member(a) - member(b) || (a.type === 'add' ? (a.index ?? 0) - (b.index ?? 0) : 0))
  let value = ed.value
  // several texts (the two sides of a merge): an item's comments come from the first text that has the item
  const texts = (Array.isArray(proposalText) ? proposalText : [proposalText]).filter((t) => typeof t === 'string')
  const finders = texts.map(commentsIn)
  const notesOf = (entity, key) => finders.map((f) => f(entity, key)).find((c) => c.length) ?? []
  const baseKeys = keyEdges(value.edges), baseIds = assignIds(value).edges
  const fixed = new Map(baseKeys.map((k, i) => [k, baseIds[i]]))
  const edits = [], applied = [], skipped = [], unsupported = []
  const failed = (c, error) => {
    // a cascade (removing a node removes its edges and memberships) can make a later removal or edit moot;
    // an addition that fails is never moot, so it is always reported
    if (c.type !== 'add' && (c.type === 'remove' || /unknown|no (node|edge|zone|frame)/i.test(error))) skipped.push(c.id)
    else unsupported.push({ id: c.id, reason: error })
  }
  const done = (c, r) => {
    edits.push(...r.edits.map((e) => ({ ...e, change: c.id })))
    applied.push(c.id)
  }
  // field sets don't change any id, so a run of them is written against one reading of the text (and
  // applied in one step when their edits are disjoint)
  let sets = []
  const flush = () => {
    const batch = sets
    sets = []
    if (!batch.length) return
    const together = batch.length > 1 ? ed.applyDisjoint(batch.map(([, op]) => op)) : null
    batch.forEach(([c, op], i) => {
      const r = together ? together[i] : ed.apply([op])
      if (r.error) failed(c, r.error)
      else done(c, r)
    })
    value = ed.value
  }
  for (const c of ordered) {
    const op = opFor(c, value, proposal, fixed, notesOf)
    if (op.unsupported) {
      unsupported.push({ id: c.id, reason: op.unsupported })
      continue
    }
    if (op.skip) {
      skipped.push(c.id)
      continue
    }
    if (op.op === 'set') {
      sets.push([c, op])
      continue
    }
    flush()
    const r = ed.apply([op])
    if (r.error) failed(c, r.error)
    else done(c, r)
    value = ed.value
  }
  flush()
  // the header travels when asked for (the change review's header box, change/handoff.js takesHeader), even
  // with no model change: a re-import that only brings new provenance, warnings or comments still updates them
  const text = header ? texts.reduce((t, p) => mergeHeader(t, p), ed.text) : ed.text
  return { text, edits, applied, skipped, unsupported }
}

/** (entity, change key) → the comments that belong to that item in the proposal text ([] without one). */
function commentsIn(text) {
  const p = typeof text === 'string' ? parseSource(text) : null
  if (!p?.value) return () => []
  const index = indexSource(p.cst, p.value)
  const keys = keyEdges(Array.isArray(p.value.edges) ? p.value.edges : []), ids = assignIds(p.value).edges
  return (entity, key) => {
    const id = entity === 'edge' ? ids[keys.indexOf(key)] ?? (typeof key === 'string' ? key : null) : key
    const entry = id ? index.find(entity, id) : null
    return entry ? ownComments(entry.item) : []
  }
}

/** The comment lines before a source's first field, and where they sit: { lines, start, end, indent }. */
function headerOf(text) {
  const p = parseSource(text)
  const root = p.cst?.root
  const first = root?.type === 'object' ? root.members[0] : null
  if (!first) return null
  const lead = first.first.leading
  const comments = lead.filter((t) => t.type === 'line' || t.type === 'block')
  const indentTok = lead.at(-1)?.type === 'ws' ? lead.at(-1).text : ''
  return { lines: comments.map((t) => t.text), start: comments[0]?.start ?? first.first.start, end: comments.length ? comments.at(-1).end : first.first.start, indent: indentTok, eol: text.includes('\r\n') ? '\r\n' : '\n', at: first.first.start }
}

const IMPORT_HEAD = /^\/\/ Imported from /
const IMPORT_BODY = /^\/\/( {3}| Everything in it| \d+ constructs? not carried| Comments in the original)/
/** The lines of a generated import header (see interop/report.js emitSource), from "Imported from" on. */
function importBlock(lines) {
  const at = lines.findIndex((l) => IMPORT_HEAD.test(l))
  if (at < 0) return null
  let end = at + 1
  while (end < lines.length && IMPORT_BODY.test(lines[end])) end++
  return [at, end]
}

/**
 * The accepted source's header: the baseline's own header comments, plus the proposal's that the baseline
 * doesn't have. A proposal that carries a generated import header (provenance and loss report) replaces the
 * baseline's previous one, so a re-import doesn't pile up stale reports; hand-written comments always stay.
 */
export function mergeHeader(text, proposalText) {
  const mine = headerOf(text), theirs = headerOf(proposalText)
  if (!mine || !theirs || !theirs.lines.length) return text
  let base = mine.lines
  const blockTheirs = importBlock(theirs.lines), blockMine = importBlock(base)
  if (blockTheirs && blockMine) base = [...base.slice(0, blockMine[0]), ...base.slice(blockMine[1])]
  const merged = [...base, ...theirs.lines.filter((l) => !base.includes(l))]
  if (merged.length === mine.lines.length && merged.every((l, i) => l === mine.lines[i])) return text
  const block = merged.map((l) => l + mine.eol + mine.indent).join('')
  // replace from the first existing header comment (or the first field) up to the first field
  return text.slice(0, mine.lines.length ? mine.start : mine.at) + block + text.slice(mine.at)
}
