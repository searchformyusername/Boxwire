// Back-of-envelope capacity over the typed graph. Load starts at clients that
// declare it, flows along edges in topological order and is checked against
// each node's declared rating. The semantics are written out in the guide
// (public/products/boxwire/llm.md, "Capacity") and every derived number comes
// with the formula that produced it.
//
// Every quantity is an interval [lo, hi]. A declared value is a point; an
// undeclared one spans everything it could be (an undeclared hit ratio is
// [0, 1], undeclared replicas [1, ∞)). So a contradiction is reported only
// when it holds for every possible value of what wasn't declared, a pass only
// when it holds for all of them, and anything in between is "unknown".
//
// A load is eight intervals: reads/s and writes/s at peak (r, w), the same at
// the average rate (rA, wA), and their payload rates in KB/s (rKB, wKB, rAKB,
// wAKB). Ratings are checked against peak rates; storage accumulates at the
// average write rate. Sizes are decimal KB.

import { MANAGED_KINDS, cycles as sccs } from './graph.js'
import { compact, exact, range, rate, size } from './units.js'

const DAY = 86400
const YEAR_S = DAY * 365
const ZERO = [0, 0], UNKNOWN = [0, Infinity]
const pt = (v) => [v, v]
const add = (a, b) => [a[0] + b[0], a[1] + b[1]]
const mulN = (a, b) => (a === 0 || b === 0 ? 0 : a * b)
const mul = (a, b) => [mulN(a[0], b[0]), mulN(a[1], b[1])]
/** a / b for b ⊂ [1, ∞): the smallest quotient divides by the largest divisor. */
const div = (a, b) => [b[1] === Infinity ? 0 : a[0] / b[1], a[1] / b[0]]
const known = (v) => v[0] === v[1]
const isUnknown = (v) => v[0] === 0 && v[1] === Infinity
const fmt = (v, f = compact) => (isUnknown(v) ? 'unknown' : range(v, f))
const perSec = (kb) => size(kb) + '/s'

const R_KEYS = ['r', 'rA', 'rKB', 'rAKB']
const W_KEYS = ['w', 'wA', 'wKB', 'wAKB']
const KEYS = [...R_KEYS, ...W_KEYS]
const emptyLoad = () => Object.fromEntries(KEYS.map((k) => [k, ZERO]))
const addLoad = (a, b) => Object.fromEntries(KEYS.map((k) => [k, add(a[k], b[k])]))
/** Multiply the read side by kr and the write side by kw. */
const scale = (l, kr, kw = kr) => Object.fromEntries(KEYS.map((k) => [k, mul(l[k], R_KEYS.includes(k) ? kr : kw)]))
const hasLoad = (l) => l.r[1] > 0 || l.w[1] > 0
const total = (l) => add(l.r, l.w)

/**
 * Rating and storage comparisons allow for binary floating-point representation error only
 * (1000 × (1 − 0.7) is 300.00000000000006): a relative 1e-9, far below any meaningful rate.
 */
const EPS = 1e-9
const over = (v, limit) => v > limit + Math.max(Math.abs(limit), 1) * EPS
const within = (v, limit) => !over(v, limit)

/** An undeclared count field ∈ [1, ∞); declared, a point. */
const count = (cap, k) => (cap[k] === undefined ? [1, Infinity] : pt(cap[k]))
/** Miss fraction 1 − hit as an interval; undeclared hit ratio ∈ [0, 1]. */
const missOf = (n) => (n.cap.hitRatio === undefined ? [0, 1] : pt(1 - n.cap.hitRatio))
const hitText = (n) => (n.cap.hitRatio === undefined ? `${n.label} hit ratio (undeclared)` : exact(n.cap.hitRatio))
/** Nodes that answer reads from their own copy and pass only misses on. */
const absorbsReads = (n) => n.role === 'cache' || n.kind === 'cdn'

/**
 * A client's declared load. Writes/s: `writeQps`, else writes per day
 * (`writesPerDay`, `writesPerMonth` ÷ 30, or `dau × writesPerUser`) ÷ 86 400, × `peak`.
 * Reads/s: `readQps`, else `dau × readsPerUser` ÷ 86 400 × `peak`, else writes/s × `readWrite`.
 * `writeQps`/`readQps` are taken as peak rates. Returns null when the client declares no load.
 */
export function sourceLoad(cap) {
  const peak = cap.peak ?? 1
  const steps = []
  const peakNote = cap.peak ? ` × peak ${exact(peak)}` : ''
  let w = null, r = null // peak rates
  if (cap.writeQps !== undefined) {
    w = cap.writeQps
    steps.push({ label: 'Writes', formula: `declared ${exact(w)} writes/s`, value: rate(w) })
  } else {
    let perDay = null, how = ''
    if (cap.writesPerDay !== undefined) [perDay, how] = [cap.writesPerDay, `${exact(cap.writesPerDay)}/day`]
    else if (cap.writesPerMonth !== undefined) [perDay, how] = [cap.writesPerMonth / 30, `${exact(cap.writesPerMonth)}/month ÷ 30 days`]
    else if (cap.dau !== undefined && cap.writesPerUser !== undefined) [perDay, how] = [cap.dau * cap.writesPerUser, `${exact(cap.dau)} users × ${exact(cap.writesPerUser)} writes/day`]
    if (perDay !== null) {
      w = (perDay / DAY) * peak
      steps.push({ label: 'Writes', formula: `${how} ÷ 86,400 s${peakNote}`, value: rate(w) })
    }
  }
  if (cap.readQps !== undefined) {
    r = cap.readQps
    steps.push({ label: 'Reads', formula: `declared ${exact(r)} reads/s`, value: rate(r) })
  } else if (cap.dau !== undefined && cap.readsPerUser !== undefined) {
    r = ((cap.dau * cap.readsPerUser) / DAY) * peak
    steps.push({ label: 'Reads', formula: `${exact(cap.dau)} users × ${exact(cap.readsPerUser)} reads/day ÷ 86,400 s${peakNote}`, value: rate(r) })
  } else if (w !== null && cap.readWrite !== undefined) {
    r = w * cap.readWrite
    steps.push({ label: 'Reads', formula: `${rate(w)} writes × ${exact(cap.readWrite)} reads per write`, value: rate(r) })
  }
  if (w === null && r === null) return null
  if (r === null) steps.push({ label: 'Reads', formula: 'not declared (readQps, readsPerUser or readWrite)', value: 'unknown' })
  if (w === null) steps.push({ label: 'Writes', formula: 'not declared (writeQps, writesPerDay, writesPerMonth or dau × writesPerUser)', value: 'unknown' })
  const R = r === null ? UNKNOWN : pt(r), W = w === null ? UNKNOWN : pt(w)
  const RA = r === null ? UNKNOWN : pt(r / peak), WA = w === null ? UNKNOWN : pt(w / peak)
  const kb = (v, k) => mul(v, cap[k] === undefined ? UNKNOWN : pt(cap[k])) // 0 × unknown size = 0
  const load = { r: R, w: W, rA: RA, wA: WA, rKB: kb(R, 'readKB'), wKB: kb(W, 'writeKB'), rAKB: kb(RA, 'readKB'), wAKB: kb(WA, 'writeKB') }
  if (cap.writeKB !== undefined) steps.push({ label: 'Ingress', formula: `${fmt(W, rate)} × ${exact(cap.writeKB)} KB`, value: fmt(load.wKB, perSec) })
  if (cap.readKB !== undefined) steps.push({ label: 'Egress', formula: `${fmt(R, rate)} × ${exact(cap.readKB)} KB`, value: fmt(load.rKB, perSec) })
  return { load, steps }
}

/**
 * Edges that would close a cycle carry no load. They're found deterministically:
 * a DFS from clients first (then every node), in id order, marks back edges.
 */
function cutEdges(g) {
  const state = new Map(), cut = new Set()
  const all = [...g.nodes.values()] // already in id order
  const roots = [...all.filter((n) => n.role === 'client'), ...all.filter((n) => n.role !== 'client')].map((n) => n.id)
  for (const root of roots) {
    if (state.has(root)) continue
    const stack = [[root, 0]]
    state.set(root, 1)
    while (stack.length) {
      const top = stack[stack.length - 1]
      const edges = g.out.get(top[0])
      if (top[1] < edges.length) {
        const e = edges[top[1]++]
        const s = state.get(e.to)
        if (s === 1) cut.add(e.id)
        else if (!s) {
          state.set(e.to, 1)
          stack.push([e.to, 0])
        }
        continue
      }
      state.set(top[0], 2)
      stack.pop()
    }
  }
  return cut
}

/** Rating check for one node. Returns { status, per, limit, formula, reason, utilisation } or null when nothing is checked. */
function rating(n, load) {
  // clients generate load rather than serve it; managed and external services publish no rating unless one is declared
  if (!hasLoad(load) || n.role === 'client') return null
  if (n.cap.qpsPerNode === undefined && (n.role === 'external' || n.cap.managed === true || MANAGED_KINDS.has(n.kind))) return null
  const cap = n.cap
  const replicas = count(cap, 'replicas'), shards = count(cap, 'shards')
  let per, formula
  if (n.role === 'store' || n.role === 'cache') {
    // reads spread over every replica of every shard; writes go to one leader per shard
    per = add(div(load.r, mul(replicas, shards)), div(load.w, shards))
    formula = `${fmt(load.r, rate)} reads ÷ (${fmtCount(replicas, 'replicas')} × ${fmtCount(shards, 'shards')}) + ${fmt(load.w, rate)} writes ÷ ${fmtCount(shards, 'shards')}`
  } else if (n.role === 'queue') {
    per = div(total(load), shards)
    formula = `${fmt(total(load), rate)} messages ÷ ${fmtCount(shards, 'partitions')}`
  } else {
    per = div(total(load), replicas)
    formula = `${fmt(total(load), rate)} requests ÷ ${fmtCount(replicas, 'replicas')}`
  }
  const limit = cap.qpsPerNode
  if (limit === undefined) return { status: 'unknown', per, limit: null, formula, reason: 'no rated throughput (qpsPerNode) declared' }
  const status = over(per[0], limit) ? 'violation' : within(per[1], limit) ? 'pass' : 'unknown'
  const reason = status === 'unknown' ? (load.cyclic ? 'its load is in a feedback loop that has no solved upper bound' : `depends on undeclared ${undeclared(n, load)}`) : null
  return { status, per, limit, formula, reason, utilisation: [per[0] / limit, per[1] / limit] }
}

const fmtCount = (v, unit) => (known(v) ? `${exact(v[0])} ${unit}` : `${unit} (undeclared)`)

function undeclared(n, load) {
  const out = []
  if (n.cap.replicas === undefined && n.role !== 'queue') out.push('replicas')
  if (n.cap.shards === undefined && ['store', 'cache', 'queue'].includes(n.role)) out.push('shards')
  if (!known(load.r) || !known(load.w)) out.push('upstream load (an undeclared hit ratio or rate)')
  return out.join(', ') || 'values'
}

/** Storage a durable store accumulates: average write KB/s × seconds retained × replication factor. */
function storage(n, load) {
  if (n.role !== 'store' || !(load.w[1] > 0)) return null
  const years = n.cap.retentionYears
  if (years === undefined) return { status: 'unknown', reason: 'no retention (retentionYears) declared', need: UNKNOWN, limit: n.cap.storageTB === undefined ? null : n.cap.storageTB * 1e9 }
  const rf = count(n.cap, 'replicationFactor')
  const need = mul(mul(load.wAKB, pt(YEAR_S * years)), rf)
  const formula = `${fmt(load.wAKB, perSec)} average × 86,400 s × 365 d × ${exact(years)} y × ${known(rf) ? `RF ${exact(rf[0])}` : 'RF (undeclared)'}`
  const limit = n.cap.storageTB === undefined ? null : n.cap.storageTB * 1e9
  if (limit === null) return { status: isUnknown(need) ? 'unknown' : 'estimate', need, formula, limit: null, reason: isUnknown(need) ? 'write payload (writeKB) undeclared upstream' : null }
  const status = over(need[0], limit) ? 'violation' : within(need[1], limit) ? 'pass' : 'unknown'
  return { status, need, formula, limit, reason: status === 'unknown' ? (load.cyclic ? 'its writes are in a feedback loop that has no solved upper bound' : 'depends on undeclared writeKB or replicationFactor') : null }
}

/**
 * The load an edge carries, from what its source node sends on (`out`) and
 * what it handles (`handled`, its input before fan-out): `carries: "reads"`
 * keeps only reads, `"writes"` only writes, `"lookups"` is one read per
 * request the node handles (a write path that reads something, e.g. a fan-out
 * worker loading a post's followers once per post, not once per follower);
 * `share` (0–1) takes that fraction of the result.
 */
function edgeLoad(out, e, handled = out) {
  let l = out
  // 'misses' carries everything here; its reads are cut to the caller's cache misses by the caller (cache-aside)
  if (e.carries === 'reads') l = scale(l, pt(1), ZERO)
  else if (e.carries === 'writes') l = scale(l, ZERO, pt(1))
  else if (e.carries === 'lookups') {
    l = emptyLoad()
    l.r = total(handled)
    l.rA = add(handled.rA, handled.wA)
    l.rKB = mul(l.r, UNKNOWN)
    l.rAKB = mul(l.rA, UNKNOWN)
  }
  return e.el.share === undefined ? l : scale(l, pt(e.el.share))
}

/** Fixed-point passes allowed for feedback loops. */
const MAX_PASSES = 500
/** A loop's contraction is certified only with this margin below 1, far above floating-point noise. */
const GAIN_MARGIN = 1e-6
/** Largest feedback matrix (cut edges × load keys) and highest power tried when certifying a bound. */
const MAX_DIM = 64, MAX_POWER = 64
/** Load keys that are rates (counts), as opposed to payload sizes. */
const COUNT_KEYS = ['r', 'rA', 'w', 'wA']

/**
 * Fraction of a caller's reads that its caches don't serve. Each cache edge covers part of the reads:
 * its `share` (default 1), or an unknown part [0, 1] for a "lookups" edge, whose count isn't the
 * caller's reads. That cache serves coverage × hit ratio of them, and nothing it never received.
 * One cache is exact: 1 − share × hit, so a zero-share cache serves nothing and a half-share 90% cache
 * leaves 55%. Several caches read in parallel declare only marginals (which requests each serves isn't
 * declared), so what none of them serves lies between max(0, 1 − Σ served) (they never overlap) and
 * 1 − max served (they serve the same requests). Demand is conserved: served + unserved = all reads.
 */
function jointMiss(entries) {
  const served = entries.map(({ node, edge }) => {
    const hit = node.cap.hitRatio === undefined ? [0, 1] : pt(node.cap.hitRatio)
    const cover = edge.carries === 'lookups' ? [0, 1] : pt(edge.el.share ?? 1)
    return [cover[0] * hit[0], cover[1] * hit[1]]
  })
  const lo = Math.max(0, 1 - served.reduce((t, x) => t + x[1], 0))
  const hi = 1 - Math.max(...served.map((x) => x[0]))
  return [lo, Math.max(lo, hi)]
}

/**
 * Propagate declared load through the graph.
 * Returns { sources, nodes: Map<id, NodeCap>, edges: Map<edgeId, Load>, cut: Set<edgeId>, feedback, declared, cycles }.
 * NodeCap = { in, out, steps: [{ label, formula, value }], rating, storage }.
 *
 * Feedback loops: every transform here (share, carries, fan-out, hit ratios, queues) is linear with
 * non-negative coefficients, so the fed-back load is the least fixed point f = f0 + G·f. The edges that
 * close a cycle are cut for ordering and re-fed with the previous pass's load; from zero every pass is a
 * lower bound f_n = Σ_{t<n} Gᵗ·f0 ≤ f. An upper bound is claimed only when it is certified: G is
 * measured exactly (a unit load into each cut edge and load key, no sources, upper coefficients), and
 * some power m must have ‖Gᵐ‖∞ = q < 1 − 1e-6. Then the remaining tail is at most
 * M·‖f0‖·m·q^⌊n/m⌋ / (1 − q), with M = max over r < m of ‖Gʳ‖ (a nilpotent loop, such as a lookup
 * that never re-enters as a write, has q = 0 and no tail). Otherwise the fed-back load keeps its lower
 * bound and gets no upper bound, so nothing downstream can pass a rating.
 * Neither outcome depends on which edges the search cut or on nodes that carry no load: either bound
 * holds for every cut.
 */
export function propagate(g) {
  const cut = cutEdges(g)
  const sources = new Map()
  for (const n of g.nodes.values()) {
    const s = n.role === 'client' ? sourceLoad(n.cap) : null
    if (s) sources.set(n.id, s)
  }
  // Kahn's algorithm over the uncut edges, ties broken by id for determinism
  const indeg = new Map([...g.nodes.keys()].map((id) => [id, 0]))
  for (const e of g.edges) if (!cut.has(e.id)) indeg.set(e.to, indeg.get(e.to) + 1)
  const ready = [...indeg].filter(([, d]) => !d).map(([id]) => id).sort()
  const order = []
  while (ready.length) {
    const v = ready.shift()
    order.push(v)
    for (const e of g.out.get(v)) {
      if (cut.has(e.id)) continue
      indeg.set(e.to, indeg.get(e.to) - 1)
      if (!indeg.get(e.to)) {
        ready.push(e.to)
        ready.sort()
      }
    }
  }

  let result = pass(g, order, sources, cut, new Map(), null)
  let feedback = null
  if (cut.size) {
    const f0 = result.cutLoads
    const ids = [...cut]
    const cert = certify(feedbackMatrix(g, order, cut), ids.flatMap((id) => KEYS.map((k) => f0.get(id)?.[k][1] ?? 0)))
    const at = (i, k) => i * KEYS.length + KEYS.indexOf(k)
    const tail = (n) => (cert ? cert.M * norm0(f0, ids, cert.R) * cert.m * cert.q ** Math.floor(n / cert.m) / (1 - cert.q) : Infinity)
    // iterate until the certified tail is negligible (a nilpotent loop needs exactly m passes). Two equal
    // floating-point passes are not a proof of a fixed point, so an uncertified loop only ever yields its
    // lower bound, however settled it looks.
    let last = result, passes = 1
    for (; passes < MAX_PASSES; passes++) {
      if (cert && passes >= cert.m && tail(passes) <= 1e-12 * Math.max(1, norm0(f0, ids, cert.R))) break // tail and norm are finite on R
      const next = pass(g, order, sources, cut, last.cutLoads, null)
      const same = sameLoads(last.cutLoads, next.cutLoads)
      last = next
      if (same && !cert) break
    }
    const t = tail(passes)
    const tailAt = (i, k) => (cert && cert.R.has(at(i, k)) ? t : Infinity)
    const bounded = new Map(ids.map((id, i) => {
      const l = last.cutLoads.get(id) ?? emptyLoad()
      return [id, Object.fromEntries(KEYS.map((k) => {
        const [lo, hi] = l[k], extra = tailAt(i, k)
        return [k, [lo, extra === 0 ? hi : hi + extra]]
      }))]
    }))
    const certified = !!cert && ids.every((_, i) => COUNT_KEYS.every((k) => cert.R.has(at(i, k))))
    const loop = { passes, certified, contraction: cert && { power: cert.m, norm: cert.q }, tail: certified ? t : Infinity }
    result = pass(g, order, sources, cut, bounded, loop)
    feedback = loop
  }
  return { sources, nodes: result.nodes, edges: result.edges, cut, feedback, declared: sources.size > 0, cycles: sccs(g).length }
}

/**
 * The feedback map G as a matrix over (cut edge, load key): column (j, k) is what comes back on every
 * cut edge, per key, when a unit load of key k is fed into cut edge j alone (no sources; upper
 * coefficients, so undeclared ratios count at their worst). Null when the matrix would be too big.
 */
function feedbackMatrix(g, order, cut) {
  const ids = [...cut], n = KEYS.length, d = ids.length * n
  if (d > MAX_DIM) return null
  const G = Array.from({ length: d }, () => new Float64Array(d))
  ids.forEach((j, jj) => KEYS.forEach((kIn, kk) => {
    const unit = emptyLoad()
    unit[kIn] = [1, 1]
    const out = pass(g, order, new Map(), cut, new Map([[j, unit]]), null).cutLoads
    ids.forEach((i, ii) => KEYS.forEach((kOut, ko) => {
      G[ii * n + ko][jj * n + kk] = out.get(i)?.[kOut][1] ?? 0
    }))
  }))
  return G
}

const matNorm = (P, R) => Math.max(0, ...[...R].map((i) => [...R].reduce((t, j) => t + P[i][j], 0)))
const matMul = (A, B, R) => A.map((row, i) => {
  const out = new Float64Array(B.length)
  if (!R.has(i)) return out
  for (const k of R) if (row[k]) for (const j of R) out[j] += row[k] * B[k][j]
  return out
})

/**
 * Certify the part of G that can be bounded. Entries that are unknown (∞: an undeclared payload size)
 * and loads that are already unbounded before any feedback (f0, e.g. an undeclared rate) poison their
 * row and every row they feed, transitively; those stay unbounded. On the rest R, which nothing
 * unbounded reaches, find the smallest power m with ‖G_Rᵐ‖∞ = q < 1 − margin.
 * Returns { R, m, q, M } with M = max over r < m of ‖G_Rʳ‖, or null when nothing can be certified.
 */
function certify(G, f0) {
  if (!G) return null
  const d = G.length
  const bad = new Set()
  for (let i = 0; i < d; i++) if (G[i].some((v) => !Number.isFinite(v)) || !Number.isFinite(f0[i])) bad.add(i)
  // rows fed by an unbounded row are unbounded too (G[i][j] > 0: index j flows into index i)
  for (let changed = true; changed;) {
    changed = false
    for (let i = 0; i < d; i++) if (!bad.has(i) && [...bad].some((j) => G[i][j] > 0)) bad.add(i), (changed = true)
  }
  const R = new Set([...Array(d).keys()].filter((i) => !bad.has(i)))
  if (!R.size) return null
  let P = G, M = 1
  for (let m = 1; m <= MAX_POWER; m++) {
    const q = matNorm(P, R)
    if (!Number.isFinite(q)) return null
    if (q < 1 - GAIN_MARGIN) return { R, m, q, M }
    M = Math.max(M, q)
    P = matMul(P, G, R)
  }
  return null
}

/** ‖f0‖∞ over the certified indices: the largest upper load fed back with nothing yet fed back. */
function norm0(f0, ids, R) {
  let m = 0
  ids.forEach((id, i) => KEYS.forEach((k, ko) => {
    if (R.has(i * KEYS.length + ko)) m = Math.max(m, f0.get(id)?.[k][1] ?? 0)
  }))
  return m
}

const sameLoads = (a, b) => [...b].every(([id, l]) => KEYS.every((k) => a.get(id)?.[k][0] === l[k][0] && a.get(id)?.[k][1] === l[k][1]))

/** One propagation pass in topological order; `fed` is the load each cut edge feeds back into its target. */
function pass(g, order, sources, cut, fed, loop) {
  const nodes = new Map(), edges = new Map(), cutLoads = new Map()
  for (const n of g.nodes.values()) nodes.set(n.id, { in: emptyLoad(), out: emptyLoad(), steps: sources.has(n.id) ? [...sources.get(n.id).steps] : [], rating: null, storage: null })
  const asides = new Map() // store id → cache-aside steps, shown after its "In" line
  const cyclic = new Set() // nodes whose load includes an unsolved feedback loop

  for (const id of order) {
    const n = g.nodes.get(id), info = nodes.get(id)
    const incoming = g.inn.get(id).filter((e) => !cut.has(e.id))
    if (sources.has(id)) info.in = addLoad(info.in, sources.get(id).load)
    const back = g.inn.get(id).filter((e) => cut.has(e.id))
    for (const e of back) {
      const l = fed.get(e.id)
      if (l) info.in = addLoad(info.in, l)
    }
    if (incoming.length) {
      info.steps.push({
        label: 'In',
        formula: incoming.length > 1 ? `Σ ${incoming.length} incoming edges` : `from ${g.nodes.get(incoming[0].from).label}`,
        value: `${fmt(info.in.r, rate)} reads + ${fmt(info.in.w, rate)} writes`,
      })
    }
    if (back.length && loop) {
      info.steps.push(loop.certified
        ? { label: 'Feedback', formula: `${back.length} edge(s) close a loop; ‖G^${loop.contraction.power}‖ = ${exact(loop.contraction.norm)} < 1 certifies it, ${loop.passes} passes, remaining tail ≤ ${rate(loop.tail)}`, value: `${fmt(info.in.r, rate)} reads + ${fmt(info.in.w, rate)} writes` }
        : { label: 'Feedback', formula: `${back.length} edge(s) close a loop that isn't certified to contract (no power of its gain matrix is below 1); only a lower bound is known after ${loop.passes} passes`, value: `≥ ${rate(info.in.r[0])} reads + ≥ ${rate(info.in.w[0])} writes` })
      if (!loop.certified) cyclic.add(id)
    }
    if (g.inn.get(id).some((e) => cyclic.has(e.from))) cyclic.add(id)
    if (cyclic.has(id)) info.in = { ...info.in, cyclic: true }
    info.steps.push(...(asides.get(id) ?? []))
    if (n.role !== 'client' && n.cap.writeKB !== undefined && info.in.w[1] > 0) {
      // a node can re-declare the record size from here on (a metadata store beside blob storage)
      info.in = { ...info.in, wKB: mul(info.in.w, pt(n.cap.writeKB)), wAKB: mul(info.in.wA, pt(n.cap.writeKB)) }
      info.steps.push({ label: 'Record size', formula: `${fmt(info.in.w, rate)} writes × ${exact(n.cap.writeKB)} KB`, value: fmt(info.in.wKB, perSec) })
    }
    // how the node transforms what it receives into what it sends on
    let out = info.in
    if (absorbsReads(n)) {
      out = scale(info.in, missOf(n), pt(1))
      if (hasLoad(info.in) && g.out.get(id).length) info.steps.push({ label: 'Misses on', formula: `${fmt(info.in.r, rate)} reads × (1 − ${hitText(n)})`, value: fmt(out.r, rate) })
    } else if (n.role === 'queue') {
      // a queue turns every request it receives into one message (a write) for its consumers
      out = emptyLoad()
      for (const [rk, wk] of R_KEYS.map((k, i) => [k, W_KEYS[i]])) out[wk] = add(info.in[rk], info.in[wk])
    } else if (n.cap.fanout !== undefined) {
      out = scale(info.in, pt(n.cap.fanout))
      if (hasLoad(info.in)) info.steps.push({ label: 'Fan-out', formula: `each input × ${exact(n.cap.fanout)}`, value: `${fmt(out.r, rate)} reads + ${fmt(out.w, rate)} writes` })
    }
    info.out = out

    // cache-aside is declared, never assumed: an edge with carries "misses" gets the reads that miss every
    // cache this node reads (one cache is exact; several give the joint-miss bounds). Any other read edge
    // from a node that reads caches, to a store, may or may not be behind them, even when it is the only one:
    // nothing says which store a cache fronts, so it gets the range [misses, all reads]. A "misses" edge to a
    // cache is a serial second level, so it is not one of the caches read in parallel. These relationships
    // come from the full declared graph, never from the edges left after cutting cycles, so they can't change
    // with the search order.
    const outs = g.out.get(id)
    const cacheEdges = outs.filter((e) => e.carries !== 'misses' && absorbsReads(g.nodes.get(e.to)) && carriesReads(e)).map((e) => ({ node: g.nodes.get(e.to), edge: e }))
    const caches = cacheEdges.map((c) => c.node)
    const coverText = ({ edge }) => (edge.carries === 'lookups' ? 'an undeclared share (lookups) × ' : edge.el.share !== undefined ? `share ${exact(edge.el.share)} × ` : '')
    const missText = () => (cacheEdges.length > 1 ? `joint miss of ${cacheEdges.map((c) => `(1 − ${coverText(c)}${hitText(c.node)})`).join(', ')}` : `(1 − ${coverText(cacheEdges[0])}${hitText(caches[0])})`)
    for (const e of outs) {
      let l = edgeLoad(out, e, info.in)
      const target = g.nodes.get(e.to)
      let aside = null
      if (e.carries === 'misses') {
        if (caches.length) {
          l = scale(l, jointMiss(cacheEdges), pt(1))
          aside = { formula: `reads from ${n.label} × ${missText()} (declared: carries "misses")${caches.length > 1 ? `; ${caches.length} caches read in parallel, so which requests each serves isn't declared and the joint miss is a range` : ''}` }
        } else if (l.r[1] > 0) {
          aside = { formula: `reads from ${n.label}, all of them: the edge declares carries "misses" but ${n.label} reads no cache` }
        }
      } else if (caches.length && target.role === 'store' && carriesReads(e) && l.r[1] > 0) {
        l = scale(l, [jointMiss(cacheEdges)[0], 1], pt(1))
        aside = { formula: `reads from ${n.label} × [${missText()}, 1] (${n.label} reads ${caches.length > 1 ? `${caches.length} caches` : `the cache ${caches[0].label}`}, but this edge doesn't declare carries "misses", so whether ${caches.length > 1 ? 'they front' : 'it fronts'} ${target.label} isn't declared)` }
      }
      if (aside) {
        const steps = asides.get(e.to) ?? []
        steps.push({ label: 'Cache-aside', formula: aside.formula, value: fmt(l.r, rate) })
        asides.set(e.to, steps)
      }
      if (cyclic.has(id)) l = { ...l, cyclic: true }
      if (cut.has(e.id)) {
        cutLoads.set(e.id, l)
        continue
      }
      edges.set(e.id, l)
      const t = nodes.get(e.to)
      t.in = addLoad(t.in, l)
    }
    info.rating = rating(n, info.in)
    if (info.rating) info.steps.push({ label: 'Per instance', formula: info.rating.formula, value: `${fmt(info.rating.per, rate)}${info.rating.limit != null ? ` of ${rate(info.rating.limit)} rated` : ''}` })
    info.storage = storage(n, info.in)
    if (info.storage?.formula) info.steps.push({ label: 'Storage', formula: info.storage.formula, value: `${fmt(info.storage.need, size)}${info.storage.limit != null ? ` of ${size(info.storage.limit)}` : ''}` })
  }
  for (const [id, l] of cutLoads) edges.set(id, l)
  return { nodes, edges, cutLoads }
}

/** Whether an edge carries reads to its target (not a writes-only edge). */
const carriesReads = (e) => e.carries !== 'writes'

export { fmt as formatInterval }
