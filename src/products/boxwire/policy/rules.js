// A small declarative rule language over the typed architecture graph
// (review/graph.js). A `boxwire-rules` document lists rules of five kinds:
// no-cycle, forbid-edge, layers, no-path and require. Rules are data, never
// code: each kind is evaluated here with SCCs (Tarjan) and BFS witnesses, and
// every result is a violation with a concrete witness, or a pass. Two built-in
// rules, dangling-reference and duplicate-id, always run on the authoring
// value itself. Rules check the declared model, not the deployed system.

import { CAPACITY_FIELDS, NODE_KINDS, TRUST_LEVELS } from '../author/vocabulary.js'
import { metaKeyOk } from '../core/declared.js'
import { ROLES, bfs, buildGraph, cycles, pathTo } from '../review/graph.js'
import { STUB_MEASURE, arr, checkValue, cmp, edgeTriple, isObj, keyEdges, withEdgeIds } from '../change/model.js'
import { cached, lru, measureKey, valueKey } from '../change/memo.js'

export const RULES_FORMAT = 'boxwire-rules'
export const RULES_VERSION = 1
export const MAX_RULES = 200
/** Graphs above this many architecture nodes get a limits result instead of answers. */
export const MAX_GRAPH_NODES = 2000
/** Edge examinations allowed across all rules of one evaluation. */
export const DEFAULT_BUDGET = 250000
export const SCOPE_NOTE = 'Rules check the declared model, not the deployed system.'
export { TRUST_LEVELS }
export const BUILTIN_RULES = ['dangling-reference', 'duplicate-id']
export const SEVERITIES = ['error', 'warning', 'info']
const EDGE_MODES = { 'no-cycle': ['sync', 'all'], 'forbid-edge': ['sync', 'async', 'all'], layers: ['sync', 'async', 'all'], 'no-path': ['sync', 'async', 'all'] }
const DEFAULT_MODE = { 'no-cycle': 'sync', 'forbid-edge': 'all', layers: 'all', 'no-path': 'all' }

/** Fields each rule kind accepts (besides id, kind, severity, description). */
export const RULE_KINDS = {
  'no-cycle': { required: [], optional: ['among', 'edges'] },
  'forbid-edge': { required: ['from', 'to'], optional: ['edges'] },
  layers: { required: ['order'], optional: ['edges'] },
  'no-path': { required: ['from', 'to'], optional: ['unless', 'edges'] },
  require: { required: ['of', 'fields'], optional: [] },
}
const COMMON = ['id', 'kind', 'severity', 'description']
const SELECTOR_KEYS = ['kind', 'role', 'zone', 'trust', 'meta', 'id']
const RULE_ID = /^[a-z][a-z0-9-]{0,63}$/
const ARCH_KINDS = Object.keys(NODE_KINDS)
const json = (v) => {
  const s = JSON.stringify(v) ?? String(v)
  return s.length > 64 ? s.slice(0, 64) + '…' : s
}
const list = (opts) => opts.map((o) => `"${o}"`).join(', ')

function validateSelector(err, sel, path) {
  if (Array.isArray(sel)) {
    if (!sel.length) return err(path, 'must be a selector or a non-empty array of selectors (any of them).')
    return sel.forEach((s, i) => validateSelector(err, s, `${path}[${i}]`))
  }
  if (!isObj(sel)) return err(path, 'must be a selector object like { "role": ["store"] }.')
  for (const [k, v] of Object.entries(sel)) {
    const p = `${path}.${k}`
    if (!SELECTOR_KEYS.includes(k)) {
      err(p, `unknown selector key; use ${list(SELECTOR_KEYS)}.`)
      continue
    }
    if (k === 'meta') {
      if (!isObj(v) || !Object.keys(v).length) {
        err(p, 'must be an object of { key: value or [values] }.')
        continue
      }
      for (const [mk, mv] of Object.entries(v)) {
        if (!metaKeyOk(mk)) err(`${p}.${mk}`, 'is not a valid metadata key (a lowercase letter, then up to 31 letters, digits, "_" or "-").')
        const vals = Array.isArray(mv) ? mv : [mv]
        if (!vals.length || !vals.every((x) => typeof x === 'string')) err(`${p}.${mk}`, 'must be a string or a non-empty array of strings (metadata values are strings).')
      }
      continue
    }
    if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'string')) {
      err(p, 'must be a non-empty array of strings.')
      continue
    }
    const allowed = k === 'kind' ? ARCH_KINDS : k === 'role' ? Object.keys(ROLES) : k === 'trust' ? TRUST_LEVELS : null
    if (allowed) v.forEach((x, i) => !allowed.includes(x) && err(`${p}[${i}]`, `unknown ${k} ${json(x)}; expected one of ${list(allowed)}.`))
  }
}

function validateFields(err, fields, path) {
  if (!Array.isArray(fields) || !fields.length) return err(path, 'must be a non-empty array of field paths like "meta.owner" or "capacity.replicas".')
  fields.forEach((f, i) => {
    const p = `${path}[${i}]`
    if (typeof f !== 'string') return err(p, 'must be a string.')
    if (['label', 'name', 'kind'].includes(f)) return
    if (f.startsWith('meta.') && metaKeyOk(f.slice(5))) return
    if (f.startsWith('capacity.') && Object.hasOwn(CAPACITY_FIELDS, f.slice(9))) return
    err(p, `unsupported field ${json(f)}; use "label", "name", "kind", "meta.<key>" or "capacity.<field>".`)
  })
}

/**
 * Validate a rules document. Returns `{ errors: [{ path, message }], rules }`;
 * `rules` is the list of rules (with defaults filled in) when there are no errors.
 * Unknown fields are errors: a misspelt rule must not pass silently.
 */
export function validateRules(doc) {
  const errors = []
  const err = (path, message) => errors.length < 200 && errors.push({ path, message })
  if (!isObj(doc)) return { errors: [{ path: '', message: 'the rules file must be a JSON object.' }], rules: [] }
  if (doc.format !== RULES_FORMAT) err('format', `must be "${RULES_FORMAT}"; got ${json(doc.format)}.`)
  if (doc.version !== RULES_VERSION) err('version', `unsupported version ${json(doc.version)}; this reviewer reads version ${RULES_VERSION}.`)
  if (errors.length) return { errors, rules: [] }
  for (const k of Object.keys(doc)) if (!['$schema', 'format', 'version', 'name', 'description', 'rules'].includes(k)) err(k, 'unknown field.')
  if (!Array.isArray(doc.rules)) return err('rules', 'must be an array of rules.'), { errors, rules: [] }
  if (doc.rules.length > MAX_RULES) return err('rules', `has ${doc.rules.length} rules; the limit is ${MAX_RULES}.`), { errors, rules: [] }
  const ids = new Set(BUILTIN_RULES)
  const rules = []
  doc.rules.forEach((r, i) => {
    const p = `rules[${i}]`
    if (!isObj(r)) return err(p, 'must be an object.')
    if (typeof r.id !== 'string' || !RULE_ID.test(r.id)) err(`${p}.id`, `must be a lowercase id like "no-sync-cycles"; got ${json(r.id)}.`)
    else if (ids.has(r.id)) err(`${p}.id`, BUILTIN_RULES.includes(r.id) ? `"${r.id}" is a built-in rule and always runs.` : `duplicate rule id "${r.id}".`)
    else ids.add(r.id)
    const spec = Object.hasOwn(RULE_KINDS, r.kind) ? RULE_KINDS[r.kind] : null
    if (!spec) return err(`${p}.kind`, `unknown rule kind ${json(r.kind)}; expected one of ${list(Object.keys(RULE_KINDS))}.`)
    for (const k of Object.keys(r)) if (![...COMMON, ...spec.required, ...spec.optional].includes(k)) err(`${p}.${k}`, `unknown field for a "${r.kind}" rule.`)
    for (const k of spec.required) if (r[k] === undefined) err(`${p}.${k}`, 'is required.')
    if (r.severity !== undefined && !SEVERITIES.includes(r.severity)) err(`${p}.severity`, `must be one of ${list(SEVERITIES)}.`)
    if (r.description !== undefined && (typeof r.description !== 'string' || r.description.length > 500)) err(`${p}.description`, 'must be a string of at most 500 characters.')
    if (r.edges !== undefined && !EDGE_MODES[r.kind]?.includes(r.edges)) err(`${p}.edges`, `must be one of ${list(EDGE_MODES[r.kind])}.`)
    for (const k of ['among', 'from', 'to', 'of']) if (r[k] !== undefined && [...spec.required, ...spec.optional].includes(k)) validateSelector(err, r[k], `${p}.${k}`)
    if (r.kind === 'layers' && r.order !== undefined) {
      if (!Array.isArray(r.order) || r.order.length < 2) err(`${p}.order`, 'must be an array of at least two selectors, outermost layer first.')
      else r.order.forEach((s, j) => validateSelector(err, s, `${p}.order[${j}]`))
    }
    if (r.kind === 'no-path' && r.unless !== undefined) {
      if (!isObj(r.unless) || Object.keys(r.unless).some((k) => k !== 'through') || r.unless.through === undefined) err(`${p}.unless`, 'must be { "through": selector }.')
      else validateSelector(err, r.unless.through, `${p}.unless.through`)
    }
    if (r.kind === 'require' && r.fields !== undefined) validateFields(err, r.fields, `${p}.fields`)
    rules.push({ ...r, severity: r.severity ?? 'error', ...(EDGE_MODES[r.kind] && { edges: r.edges ?? DEFAULT_MODE[r.kind] }) })
  })
  return { errors, rules: errors.length ? [] : rules }
}

// ---------- facts and selectors ----------

/** Per-node facts the compiled graph doesn't carry: authoring node, meta, zones, trust. */
function nodeFacts(value) {
  const facts = new Map()
  for (const n of arr(value.nodes)) if (isObj(n) && typeof n.id === 'string' && !facts.has(n.id)) facts.set(n.id, { node: n, meta: isObj(n.meta) ? n.meta : {}, zones: [], trust: new Set() })
  for (const z of arr(value.zones)) {
    if (!isObj(z) || typeof z.id !== 'string') continue
    for (const m of arr(z.contains)) {
      const f = facts.get(m)
      if (!f) continue
      f.zones.push(z.id)
      if (typeof z.trust === 'string') f.trust.add(z.trust)
    }
  }
  return facts
}

function matcher(sel, facts) {
  if (sel === undefined) return () => true
  if (Array.isArray(sel)) {
    const any = sel.map((s) => matcher(s, facts))
    return (n) => any.some((m) => m(n))
  }
  return (n) => {
    const f = facts.get(n.id) ?? { meta: {}, zones: [], trust: new Set() }
    if (sel.kind && !sel.kind.includes(n.kind)) return false
    if (sel.role && !sel.role.includes(n.role)) return false
    if (sel.id && !sel.id.includes(n.id)) return false
    if (sel.zone && !f.zones.some((z) => sel.zone.includes(z))) return false
    if (sel.trust && ![...f.trust].some((t) => sel.trust.includes(t))) return false
    if (sel.meta) for (const [k, v] of Object.entries(sel.meta)) if (!(Array.isArray(v) ? v : [v]).includes(f.meta[k])) return false
    return true
  }
}

const select = (g, sel, facts) => {
  const m = matcher(sel, facts)
  return new Set([...g.nodes.values()].filter(m).map((n) => n.id))
}

function describe(sel) {
  if (Array.isArray(sel)) return sel.map(describe).join(' or ')
  const parts = Object.entries(sel).map(([k, v]) => (k === 'meta' ? Object.entries(v).map(([mk, mv]) => `${mk} ${[].concat(mv).join('/')}`).join(', ') : `${k} ${v.join('/')}`))
  return parts.length ? parts.join(', ') : 'any node'
}

// ---------- evaluation ----------

const BUDGET = Symbol('budget')
const say = (g, path) => path.filter((id) => g.nodes.has(id)).map((id) => g.nodes.get(id).label).join(' → ')
const name = (g, id) => `“${g.nodes.get(id)?.label ?? id}”`
const res = (rule, status, elementIds, message, witness = null) => ({ id: `${rule.id}:${elementIds.join('+')}`, rule: rule.id, kind: rule.kind, severity: rule.severity, status, message, elementIds, witness })
const passOr = (rule, out, message) => (out.length ? out : [res(rule, 'pass', [], message)])
const modeOf = (mode) => (mode === 'sync' ? (e) => !e.async : mode === 'async' ? (e) => e.async : () => true)
const MODE_WORD = { sync: 'synchronous ', async: 'asynchronous ', all: '' }

/** Shortest cycle through comp[0] inside the component (alternating node and edge ids, closed). */
function cycleWitness(g, comp, follow) {
  const inComp = new Set(comp)
  const start = comp[0]
  let best = null
  for (const e of g.out.get(start)) {
    if (!inComp.has(e.to) || !follow(e)) continue
    const p = pathTo(bfs(g, e.to, { follow, enter: (n) => inComp.has(n.id) }), start)
    if (p && (!best || p.length + 2 < best.length)) best = [start, e.id, ...p]
  }
  return best
}

const EVALUATE = {
  'no-cycle'(rule, { g, facts, count }) {
    const among = select(g, rule.among, facts)
    const mode = modeOf(rule.edges)
    const follow = count((e) => mode(e) && among.has(e.from) && among.has(e.to))
    const out = cycles(g, follow).map((comp) => {
      const witness = cycleWitness(g, comp, follow)
      return res(rule, 'violation', comp, `The declared model has a ${MODE_WORD[rule.edges]}dependency cycle: ${say(g, witness ?? comp)}.`, witness)
    })
    return passOr(rule, out, `No ${MODE_WORD[rule.edges]}dependency cycle${rule.among ? ` among ${describe(rule.among)}` : ''}.`)
  },
  'forbid-edge'(rule, { g, facts, count }) {
    const from = select(g, rule.from, facts), to = select(g, rule.to, facts)
    const mode = count(modeOf(rule.edges))
    const out = new Map()
    for (const e of g.edges) {
      if (!mode(e) || !from.has(e.from) || !to.has(e.to)) continue
      const k = `${e.from}+${e.to}`
      if (!out.has(k)) out.set(k, res(rule, 'violation', [e.from, e.to], `${name(g, e.from)} → ${name(g, e.to)} is a forbidden ${MODE_WORD[rule.edges]}dependency (${describe(rule.from)} must not depend on ${describe(rule.to)}).`, [e.from, e.id, e.to]))
    }
    return passOr(rule, [...out.values()], `No ${MODE_WORD[rule.edges]}edge from ${describe(rule.from)} to ${describe(rule.to)}.`)
  },
  layers(rule, { g, facts, count }) {
    const sets = rule.order.map((s) => select(g, s, facts))
    const layer = (id) => sets.findIndex((s) => s.has(id))
    const mode = count(modeOf(rule.edges))
    const out = new Map()
    for (const e of g.edges) {
      if (!mode(e)) continue
      const lf = layer(e.from), lt = layer(e.to)
      if (lf < 0 || lt < 0 || lt >= lf) continue
      const k = `${e.from}+${e.to}`
      if (!out.has(k)) out.set(k, res(rule, 'violation', [e.from, e.to], `${name(g, e.from)} (layer ${lf + 1}, ${describe(rule.order[lf])}) depends on ${name(g, e.to)} (layer ${lt + 1}, ${describe(rule.order[lt])}); a layer may only depend on later layers.`, [e.from, e.id, e.to]))
    }
    return passOr(rule, [...out.values()], `Every ${MODE_WORD[rule.edges]}edge respects the declared layer order.`)
  },
  'no-path'(rule, { g, facts, count }) {
    const from = select(g, rule.from, facts), to = select(g, rule.to, facts)
    const through = rule.unless ? select(g, rule.unless.through, facts) : new Set()
    const follow = count(modeOf(rule.edges))
    const best = new Map()
    for (const s of from) {
      if (through.has(s)) continue
      const seen = bfs(g, s, { follow, enter: (n) => !through.has(n.id) })
      for (const t of seen.keys()) {
        if (t === s || !to.has(t)) continue
        const p = pathTo(seen, t)
        if (!best.has(t) || p.length < best.get(t).path.length) best.set(t, { s, path: p })
      }
    }
    const via = rule.unless ? ` without passing through ${describe(rule.unless.through)}` : ''
    const out = [...best.entries()].sort(([a], [b]) => cmp(a, b)).map(([t, { s, path }]) =>
      res(rule, 'violation', [s, t], `The declared model has a ${MODE_WORD[rule.edges]}path from ${name(g, s)} to ${name(g, t)}${via}: ${say(g, path)}.`, path))
    return passOr(rule, out, `No ${MODE_WORD[rule.edges]}path from ${describe(rule.from)} to ${describe(rule.to)}${via}.`)
  },
  require(rule, { g, facts }) {
    const of = select(g, rule.of, facts)
    const out = []
    for (const id of of) {
      const n = facts.get(id)?.node ?? {}
      const missing = rule.fields.filter((f) => {
        const v = f.startsWith('meta.') ? n.meta?.[f.slice(5)] : f.startsWith('capacity.') ? n.capacity?.[f.slice(9)] : n[f]
        return v === undefined || v === null || v === ''
      })
      if (missing.length) out.push(res(rule, 'violation', [id], `${name(g, id)} doesn't declare ${missing.join(', ')}.`, [id]))
    }
    return passOr(rule, out, `Every node matching ${describe(rule.of)} declares ${rule.fields.join(', ')}.`)
  },
}

/** Built-in checks on the authoring value: duplicate ids and references to nothing. */
function builtins(value) {
  const v = isObj(value) ? value : {}
  const R = (id) => ({ id, kind: 'builtin', severity: 'error' })
  const where = new Map()
  const note = (id, path, entity) => {
    if (typeof id !== 'string') return
    if (!where.has(id)) where.set(id, [])
    where.get(id).push({ path, entity })
  }
  for (const [coll, entity] of [['nodes', 'node'], ['zones', 'zone'], ['edges', 'edge'], ['frames', 'frame'], ['strokes', 'stroke']]) arr(v[coll]).forEach((o, i) => isObj(o) && note(o.id, `${coll}[${i}]`, entity))
  const dup = [...where.entries()].filter(([, w]) => w.length > 1).sort(([a], [b]) => cmp(a, b))
    .map(([id, w]) => ({ ...res(R('duplicate-id'), 'violation', [id], `The id "${id}" is declared ${w.length} times (${w.map((x) => x.path).join(', ')}).`, [id]), paths: w.map((x) => x.path) }))
  const nodes = new Set(arr(v.nodes).filter((n) => isObj(n) && typeof n.id === 'string').map((n) => n.id))
  const zones = new Set(arr(v.zones).filter((z) => isObj(z) && typeof z.id === 'string').map((z) => z.id))
  const all = new Set(where.keys())
  const keys = keyEdges(v.edges)
  const dangling = []
  const ref = (referrer, missing, path, what) => dangling.push({ ...res(R('dangling-reference'), 'violation', [referrer, missing], `${what} refers to "${missing}", which isn't declared.`, [referrer]), paths: [path] })
  arr(v.edges).forEach((e, i) => {
    if (!isObj(e)) return
    for (const end of ['from', 'to']) if (typeof e[end] === 'string' && !nodes.has(e[end]) && !zones.has(e[end])) ref(typeof e.id === 'string' ? e.id : keys[i], e[end], `edges[${i}].${end}`, `Edge ${edgeTriple(e)} (${end})`)
  })
  arr(v.zones).forEach((z, i) => isObj(z) && arr(z.contains).forEach((m, j) => typeof m === 'string' && !nodes.has(m) && ref(z.id, m, `zones[${i}].contains[${j}]`, `Zone "${z.id}"`)))
  arr(v.frames).forEach((f, i) => isObj(f) && arr(f.contains).forEach((m, j) => typeof m === 'string' && !nodes.has(m) && !zones.has(m) && ref(f.id, m, `frames[${i}].contains[${j}]`, `Frame "${f.id}"`)))
  if (isObj(v.positions)) for (const id of Object.keys(v.positions).sort()) if (!all.has(id)) ref('positions', id, `positions.${id}`, 'A position')
  dangling.sort((a, b) => cmp(a.id, b.id))
  return [
    ...passOr(R('dangling-reference'), dangling, 'Every reference names a declared element.'),
    ...passOr(R('duplicate-id'), dup, 'Every id is declared once.'),
  ]
}

/** Entity and authoring index of each element id a result mentions (graph edge ids are compiler ids). */
function elementInfo(value, results) {
  const v = withEdgeIds(isObj(value) ? value : {})
  const keys = keyEdges(isObj(value) ? value.edges : [])
  const info = new Map()
  for (const [coll, entity] of [['nodes', 'node'], ['zones', 'zone'], ['frames', 'frame']]) arr(v[coll]).forEach((o, index) => isObj(o) && typeof o.id === 'string' && !info.has(o.id) && info.set(o.id, { entity, index }))
  arr(v.edges).forEach((e, index) => isObj(e) && typeof e.id === 'string' && !info.has(e.id) && info.set(e.id, { entity: 'edge', index, key: keys[index] }))
  keys.forEach((k, index) => !info.has(k) && info.set(k, { entity: 'edge', index, key: k }))
  const out = {}
  for (const r of results) for (const id of [...r.elementIds, ...(r.witness ?? [])]) if (info.has(id)) out[id] = { id, ...info.get(id) }
  return out
}

/**
 * Evaluate a rules document (or null: built-ins only) against an authoring value.
 * Returns `{ format, version, note, errors, diagnostics, results, elements, limits }`:
 * - `errors`: rules-document problems (then nothing is evaluated);
 * - `diagnostics`: compile errors of the diagram (then only built-in rules ran and `complete` is false);
 * - `results`: `{ id: 'rule-id:elem+elem', rule, kind, severity, status: 'violation'|'pass', message, elementIds, witness, ranges? }`,
 *   built-ins first, then document order; violations before the pass;
 * - `elements`: `{ [id]: { id, entity, index, key? } }` for every id cited;
 * - `limits`: `{ exceeded, reason?, message?, nodes, maxNodes, budget, used }`. When exceeded, `results` is empty.
 * `spanOf({ entity, id, index, key })` → source range or null attaches `ranges` per witness element.
 */
export function evaluateRules(value, rulesDoc, { spanOf, measure = STUB_MEASURE, maxNodes = MAX_GRAPH_NODES, budget = DEFAULT_BUDGET } = {}) {
  const vk = valueKey(value), rk = valueKey(rulesDoc ?? null)
  const key = vk === null || rk === null ? null : `${measureKey(measure)}|${maxNodes}|${budget}|${rk}|${vk}`
  const out = cached(evaluations, key, () => evaluateCore(value, rulesDoc, { measure, maxNodes, budget }))
  if (!spanOf || !out.results.length) return out
  const { elements } = out
  const results = out.results.map((r) => ({
    ...r,
    ranges: (r.witness ?? r.elementIds).filter((id) => elements[id]).map((id) => ({ id, entity: elements[id].entity, range: spanOf(elements[id]) ?? null })).filter((x) => x.range),
  }))
  return { ...out, results }
}

/** A `boxwire-diagram` with no nodes, zones, edges, frames or strokes. */
export const isEmptyDiagram = (v) => isObj(v) && v.format === 'boxwire-diagram' && v.version === 1 && ['nodes', 'zones', 'edges', 'frames', 'strokes'].every((k) => v[k] === undefined || (Array.isArray(v[k]) && !v[k].length))

/** Evaluations by content (value, rules, options); source ranges are attached per call. */
const evaluations = lru(12)

function evaluateCore(value, rulesDoc, { measure, maxNodes, budget }) {
  const head = { format: 'boxwire-rules-result', version: RULES_VERSION, note: SCOPE_NOTE }
  // no rules document: the built-in checks still run
  const checked = validateRules(rulesDoc ?? { format: RULES_FORMAT, version: RULES_VERSION, rules: [] })
  if (checked.errors.length) return { ...head, errors: checked.errors, diagnostics: [], complete: false, results: [], elements: {}, limits: null }
  let results = builtins(value)
  // compiled as written: the compiler gives id-less edges exactly the ids withEdgeIds would (e1, e2 … skipping taken ids).
  // An empty diagram (the baseline of an import) declares nothing, so nothing in it can violate a rule: it is
  // evaluated as the empty graph rather than reported as a diagram that doesn't compile.
  const compiled = isEmptyDiagram(value) ? { errors: [], warnings: [], doc: {} } : checkValue(value, { measure })
  let limits = { exceeded: false, nodes: 0, maxNodes, budget, used: 0 }
  if (compiled.doc) {
    const g = buildGraph(compiled.doc)
    limits.nodes = g.nodes.size
    if (g.nodes.size > maxNodes) {
      return { ...head, errors: [], diagnostics: [], complete: false, results: [], elements: {}, limits: { ...limits, exceeded: true, reason: 'nodes', message: `The architecture graph has ${g.nodes.size} nodes; rules are evaluated up to ${maxNodes}. ${SCOPE_NOTE}` } }
    }
    const facts = nodeFacts(value)
    let used = 0
    const count = (fn) => (e) => {
      if (++used > budget) throw BUDGET
      return fn(e)
    }
    try {
      results = [...results, ...checked.rules.flatMap((rule) => EVALUATE[rule.kind](rule, { g, facts, count }))]
    } catch (e) {
      if (e !== BUDGET) throw e
      return { ...head, errors: [], diagnostics: [], complete: false, results: [], elements: {}, limits: { ...limits, exceeded: true, reason: 'budget', used: budget, message: `Evaluation stopped after examining ${budget} edges; no partial answers are reported. ${SCOPE_NOTE}` } }
    }
    limits.used = used
  }
  const elements = elementInfo(value, results)
  return { ...head, errors: [], diagnostics: compiled.errors, complete: !!compiled.doc, results, elements, limits }
}

/** Rule ids with at least one violation in an evaluation. */
export const failingRules = (evaluation) => new Set(evaluation.results.filter((r) => r.status === 'violation').map((r) => r.rule))
