// Three-way merge and safe partial acceptance of architecture changes. Both
// work on the field-level changes diffModels produces, keyed by stable id, so
// edits to different fields of one node combine, and a conflict names exactly
// the field (or element) both sides touched. Nothing is cherry-picked blindly:
// graph references are closed over (an accepted edge brings its new endpoint
// nodes; a removed node takes its edges with it) and every result is compiled.

import { allChanges, changeId, diffModels } from './diff.js'
import { STUB_MEASURE, alignEdges, applyChanges, arr, canon, checkValue, clone, elementIds, entities, isObj } from './model.js'
import { evaluateRules, failingRules } from '../policy/rules.js'
import { assignIds } from '../author/compile.js'

const SIDES = ['ours', 'theirs']
const PRIORITY = ['delete-modify', 'dangling', 'add-add', 'field']

/** Does change `c` make something point at element `id` (an edge end, a membership, a position)? */
function references(c, id) {
  if (c.entity === 'edge' && c.type === 'add') return c.after?.from === id || c.after?.to === id
  if (c.entity === 'edge' && c.type === 'change') return (c.field === 'from' || c.field === 'to') && c.after === id
  if ((c.entity === 'zone' || c.entity === 'frame') && c.type === 'add') return arr(c.after?.contains).includes(id)
  if ((c.entity === 'zone' || c.entity === 'frame') && c.type === 'change') return c.field === `contains.${id}` && c.after === true
  if (c.entity === 'diagram') return c.field === `positions.${id}` && c.after !== undefined
  return false
}

/** Changes on one side that follow from removing element `id` there: its edges, memberships and position. */
function consequences(changes, baseIndex, id) {
  const edges = new Set([...baseIndex.values()].filter((e) => e.entity === 'edge' && (e.obj.from === id || e.obj.to === id)).map((e) => e.key))
  return changes.filter((c) => (c.entity === 'edge' && edges.has(c.key)) || (c.type === 'change' && (c.field === `contains.${id}` || (c.entity === 'diagram' && c.field === `positions.${id}`))))
}

function conflictMessage(kind, c, label) {
  const q = (s) => `“${s}”`
  if (kind === 'field') return `Both sides changed ${c.field} of ${q(label)}: ours ${canon(c.ours)}, theirs ${canon(c.theirs)}.`
  if (kind === 'add-add') return `Both sides added "${c.key}" with different content.`
  if (kind === 'dangling') return `One side removed ${q(label)} while the other connected something to it.`
  return `One side removed ${q(label)} while the other changed it.`
}

/**
 * Three-way merge at field granularity. Returns
 * `{ value, conflicts, applied: { ours: [ids], theirs: [ids] }, errors, valid, base, changes: { ours, theirs } }`.
 * Conflict = `{ id, kind: 'field'|'add-add'|'delete-modify'|'dangling', entity, key, field, base, ours, theirs, message, changes: { ours: [ids], theirs: [ids] } }`;
 * for element-level kinds `field` is null and base/ours/theirs are the element (or null where absent).
 * `value` holds every non-conflicting change, with base content where conflicts are; `errors`
 * are its compile errors (none when there are no conflicts).
 */
export function merge3(base, ours, theirs, { measure = STUB_MEASURE } = {}) {
  const b = isObj(base) ? base : {}
  const side = { ours: allChanges(diffModels(b, ours)), theirs: allChanges(diffModels(b, theirs)) }
  const byId = { ours: new Map(side.ours.map((c) => [c.id, c])), theirs: new Map(side.theirs.map((c) => [c.id, c])) }
  const other = { ours: 'theirs', theirs: 'ours' }
  const tag = (s, id) => `${s}|${id}`
  const parent = new Map()
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x)
    while (parent.get(x) !== x) x = parent.get(x)
    return x
  }
  const union = (x, y) => {
    const rx = find(x), ry = find(y)
    if (rx !== ry) parent.set(ry, rx)
  }
  const marks = []
  const mark = (kind, x, y, anchor) => {
    union(x, y)
    marks.push({ kind, x, y, anchor })
  }

  // same change on both sides, different outcome
  for (const [id, o] of byId.ours) {
    const t = byId.theirs.get(id)
    if (!t || o.type === 'remove' || canon(o.after) === canon(t.after)) continue
    mark(o.type === 'add' ? 'add-add' : 'field', tag('ours', id), tag('theirs', id), o)
  }
  // one id added as different kinds of element
  const addIds = (s) => new Map(side[s].filter((c) => c.type === 'add').map((c) => [c.entity === 'edge' ? c.after?.id : c.key, c]).filter(([k]) => typeof k === 'string'))
  const addsT = addIds('theirs')
  for (const [k, o] of addIds('ours')) {
    const t = addsT.get(k)
    if (t && t.id !== o.id) mark('add-add', tag('ours', o.id), tag('theirs', t.id), o)
  }
  const baseIndex = entities(b)
  for (const s of SIDES) {
    for (const r of side[s]) {
      if (r.type !== 'remove') continue
      // delete vs modify
      for (const c of side[other[s]]) if (c.type === 'change' && c.entity === r.entity && c.key === r.key) mark('delete-modify', tag(s, r.id), tag(other[s], c.id), r)
      if (r.entity !== 'node' && r.entity !== 'zone') continue
      // the other side points something at the removed element
      for (const c of side[other[s]]) if (references(c, r.key)) mark('dangling', tag(s, r.id), tag(other[s], c.id), r)
      // what this side removed along with it is decided together with it
      for (const c of consequences(side[s], baseIndex, r.key)) union(tag(s, r.id), tag(s, c.id))
    }
  }

  const roots = new Map()
  for (const m of marks) {
    const root = find(m.x)
    if (!roots.has(root)) roots.set(root, [])
    roots.get(root).push(m)
  }
  const inConflict = { ours: new Set(), theirs: new Set() }
  const members = new Map()
  for (const t of parent.keys()) {
    const root = find(t)
    if (!roots.has(root)) continue
    const [s, id] = [t.slice(0, t.indexOf('|')), t.slice(t.indexOf('|') + 1)]
    inConflict[s].add(id)
    if (!members.has(root)) members.set(root, { ours: new Set(), theirs: new Set() })
    members.get(root)[s].add(id)
  }

  const gen = (v) => (isObj(v) ? assignIds(v).edges : [])
  const align = { ours: alignEdges(b.edges, ours?.edges, { base: gen(b), next: gen(ours) }), theirs: alignEdges(b.edges, theirs?.edges, { base: gen(b), next: gen(theirs) }) }
  const index = { base: baseIndex, ours: entities(isObj(ours) ? ours : {}, align.ours.nextKeys), theirs: entities(isObj(theirs) ? theirs : {}, align.theirs.nextKeys) }
  const element = (v, entity, key) => clone(index[v].get(`${entity}:${key}`)?.obj) ?? null
  const conflicts = []
  for (const [root, ms] of roots) {
    const primary = [...ms].sort((p, q) => PRIORITY.indexOf(p.kind) - PRIORITY.indexOf(q.kind))[0]
    const m = members.get(root)
    const ids = { ours: side.ours.filter((c) => m.ours.has(c.id)).map((c) => c.id), theirs: side.theirs.filter((c) => m.theirs.has(c.id)).map((c) => c.id) }
    const a = primary.anchor
    const fieldLevel = primary.kind === 'field' && ids.ours.length === 1 && ids.theirs.length === 1
    const c = fieldLevel
      ? { id: a.id, kind: 'field', entity: a.entity, key: a.key, field: a.field, base: a.before, ours: a.after, theirs: byId.theirs.get(a.id).after }
      : { id: changeId(a.entity, a.key), kind: primary.kind === 'field' ? 'delete-modify' : primary.kind, entity: a.entity, key: a.key, field: null, base: element('base', a.entity, a.key), ours: element('ours', a.entity, a.key), theirs: element('theirs', a.entity, a.key) }
    // name the element as the base had it: that's what both sides started from
    const baseLabel = a.entity === 'edge' ? null : element('base', a.entity, a.key)?.label
    const label = (typeof baseLabel === 'string' && baseLabel.split('\n')[0]) || a.label || a.key
    conflicts.push({ ...c, message: conflictMessage(c.kind, c, label), changes: ids })
  }
  conflicts.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0))
  const seen = new Map()
  for (const c of conflicts) {
    const n = (seen.get(c.id) ?? 0) + 1
    seen.set(c.id, n)
    if (n > 1) c.id = `${c.id}#${n}`
  }

  const applied = {
    ours: side.ours.filter((c) => !inConflict.ours.has(c.id)).map((c) => c.id),
    theirs: side.theirs.filter((c) => !inConflict.theirs.has(c.id)).map((c) => c.id),
  }
  const result = build(b, side, applied, measure)
  return { ...result, conflicts, applied, valid: !conflicts.length && !result.errors.length, base: b, changes: side }
}

function build(base, side, pick, measure) {
  const o = new Set(pick.ours), t = new Set(pick.theirs)
  const list = [...side.ours.filter((c) => o.has(c.id)), ...side.theirs.filter((c) => t.has(c.id) && !o.has(c.id))]
  const value = applyChanges(base, list)
  const checked = checkValue(value, { measure })
  return { value, errors: checked.errors, warnings: checked.warnings }
}

/**
 * Finish a merge: `choices` maps conflict id → 'ours' | 'theirs' | 'base'.
 * Returns `{ value, errors, warnings, unresolved: [conflict ids], valid }`;
 * an unresolved conflict keeps its base content.
 */
export function resolve(mergeResult, choices = {}, { measure = STUB_MEASURE } = {}) {
  const pick = { ours: [...mergeResult.applied.ours], theirs: [...mergeResult.applied.theirs] }
  const unresolved = []
  for (const c of mergeResult.conflicts) {
    const choice = choices[c.id]
    if (choice === 'ours' || choice === 'theirs') pick[choice].push(...c.changes[choice])
    else if (choice !== 'base') unresolved.push(c.id)
  }
  const r = build(mergeResult.base, mergeResult.changes, pick, measure)
  return { ...r, unresolved, valid: !unresolved.length && !r.errors.length }
}

/**
 * Accept part of a proposal without breaking references. `accepted` is a list
 * of change ids, or `{ all: true, except: [ids] }` (the excepted ids count as
 * rejected). Explicitly rejected changes (`options.rejected`, `except`) win:
 * anything that needs one of them is dropped too.
 * - accepting an edge (or an endpoint change, a zone or a membership) pulls in
 *   the additions of the nodes it needs (`required`);
 * - accepting a node or zone removal pulls in the removal of its edges,
 *   memberships and position (`required`);
 * - a change that needs a rejected change is dropped (`rejected`), as are
 *   positions and frame memberships of elements that don't end up in the result.
 * With `options.rules`, `brokenInvariants` lists rules that pass on both base
 * and proposal but fail on the result: `[{ rule, results }]` (null if rules
 * couldn't be fully evaluated).
 * Returns `{ value, applied, required, rejected, errors, warnings, valid, brokenInvariants, rules? }`.
 */
export function acceptChanges(base, proposal, accepted, { rejected: rejectedIds = [], rules, measure = STUB_MEASURE, ...ruleOptions } = {}) {
  const b = isObj(base) ? base : {}
  const changes = allChanges(diffModels(b, proposal))
  const byId = new Map(changes.map((c) => [c.id, c]))
  const errors = []
  const all = isObj(accepted) && accepted.all === true
  const except = isObj(accepted) ? arr(accepted.except) : []
  const asked = new Set(all ? changes.map((c) => c.id) : arr(accepted))
  const explicit = new Set([...arr(rejectedIds), ...except])
  for (const id of new Set([...(all ? [] : asked), ...explicit])) if (!byId.has(id)) errors.push({ path: 'accepted', message: `unknown change "${id}".` })

  const baseIndex = entities(b)
  const addOf = (id) => (typeof id === 'string' ? [changeId('node', id), changeId('zone', id)].find((k) => byId.get(k)?.type === 'add') : undefined)
  const memo = new Map()
  const needs = (c) => {
    if (memo.has(c.id)) return memo.get(c.id)
    const out = []
    memo.set(c.id, out)
    const need = (id) => {
      const k = addOf(id)
      if (k) out.push(k)
    }
    if (c.entity === 'edge' && c.type === 'add') [c.after.from, c.after.to].forEach(need)
    if (c.entity === 'edge' && c.type === 'change' && (c.field === 'from' || c.field === 'to')) need(c.after)
    if (c.entity === 'zone' && c.type === 'add') arr(c.after.contains).forEach(need)
    if (c.entity === 'zone' && c.type === 'change' && c.field.startsWith('contains.') && c.after === true) need(c.field.slice(9))
    if ((c.entity === 'node' || c.entity === 'zone') && c.type === 'remove') {
      for (const x of consequences(changes, baseIndex, c.key)) {
        // an edge on the removed element must go, or be reconnected away from it
        if (x.entity === 'edge' && x.type === 'change' && !((x.field === 'from' || x.field === 'to') && x.before === c.key)) continue
        if (x.type === 'change' && x.after === true) continue
        out.push(x.id)
      }
    }
    return out
  }

  const A = new Set(changes.filter((c) => asked.has(c.id) && !explicit.has(c.id)).map((c) => c.id))
  const R = new Set(explicit)
  const required = new Set(), dropped = new Set()
  for (let changed = true; changed;) {
    changed = false
    for (const id of [...A]) {
      const reqs = needs(byId.get(id))
      if (reqs.some((r) => R.has(r))) {
        A.delete(id)
        R.add(id)
        dropped.add(id)
        changed = true
        continue
      }
      for (const r of reqs) {
        if (A.has(r)) continue
        A.add(r)
        if (!asked.has(r)) required.add(r)
        changed = true
      }
    }
  }

  // elements that will exist; layout and presentation references to anything else are dropped
  const present = new Set(elementIds(b))
  for (const id of A) {
    const c = byId.get(id)
    if (c.entity === 'edge' || c.entity === 'diagram') continue
    if (c.type === 'remove') present.delete(c.key)
    if (c.type === 'add') present.add(c.key)
  }
  const list = []
  for (const c of changes) {
    if (!A.has(c.id)) continue
    const pos = c.entity === 'diagram' && c.field?.startsWith('positions.') && c.after !== undefined ? c.field.slice(10) : null
    const member = c.entity === 'frame' && c.type === 'change' && c.field.startsWith('contains.') && c.after === true ? c.field.slice(9) : null
    if ((pos && !present.has(pos)) || (member && !present.has(member))) {
      A.delete(c.id)
      dropped.add(c.id)
      continue
    }
    if (c.entity === 'frame' && c.type === 'add') {
      const contains = arr(c.after.contains).filter((m) => present.has(m))
      if (!contains.length) {
        A.delete(c.id)
        dropped.add(c.id)
        continue
      }
      list.push({ ...c, after: { ...c.after, contains } })
      continue
    }
    list.push(c)
  }
  const value = applyChanges(b, list)
  const checked = checkValue(value, { measure })
  errors.push(...checked.errors)

  let brokenInvariants = null, evaluation
  if (rules !== undefined) {
    const opts = { measure, ...ruleOptions }
    const [eb, ep, er] = [b, proposal, value].map((v) => evaluateRules(v, rules, opts))
    evaluation = er
    if ([eb, ep, er].every((e) => !e.errors.length && e.complete && !e.limits?.exceeded)) {
      const fb = failingRules(eb), fp = failingRules(ep)
      brokenInvariants = [...failingRules(er)].filter((r) => !fb.has(r) && !fp.has(r)).sort()
        .map((rule) => ({ rule, results: er.results.filter((x) => x.rule === rule && x.status === 'violation') }))
    }
  }
  const ordered = (set) => changes.filter((c) => set.has(c.id)).map((c) => c.id)
  return {
    value,
    applied: ordered(A),
    required: ordered(new Set([...required].filter((id) => A.has(id)))),
    rejected: ordered(new Set([...dropped].filter((id) => !explicit.has(id)))),
    errors,
    warnings: checked.warnings,
    valid: !errors.length,
    brokenInvariants,
    ...(evaluation && { rules: evaluation }),
  }
}
