// The practice rubric: a published, versioned list of checks over the typed
// graph, the lint results and the build history's timestamps. Scoring is
// local and deterministic; nothing is graded on a server or by a model.
// Every item returns its evidence: the elements behind it and when they were
// drawn, both as wall-clock time and as a position in the timelapse.
//
// The rubric scores what the diagram declares. It never reads what a note or
// label says, and an undeclared fact is listed as undeclared rather than
// counted as a mistake. ASSUMPTIONS and CANNOT_INFER are part of the published
// rubric and are shown with every score.

import { isNode } from '../core/elements.js'
import { createReplay } from '../core/replay.js'
import { bfs, pathTo } from './graph.js'
import { lint } from './lint.js'
import { GRACE, PHASES, PHASE_IDS, activity, phaseAt, timing } from './practice.js'

export const RUBRIC_VERSION = 1

export const ASSUMPTIONS = [
  'The score reads the declared model: node kinds, edges, capacity declarations, crossed-out nodes, notes and the build history\'s timestamps. Rules check the declared model, not a deployed system.',
  'Solid arrows are synchronous requests and dashed arrows asynchronous messages; the arrowhead gives the direction.',
  'Anything undeclared (replicas, auth, TTLs, ratings, load) is unknown. Items that depend on it score nothing and say what to declare; they are not marked wrong.',
  'Notes count by kind and timing, not by what they say: the rubric never reads your words.',
  'Phase timing comes from your own phase changes; a step belongs to the phase that was running when you committed it.',
]

export const CANNOT_INFER = [
  'Whether the requirements you wrote are the right ones, or complete.',
  'API design, data model and schema quality.',
  'Consistency, isolation and ordering guarantees, unless drawn as components.',
  'Whether your numbers are realistic: only that they are internally consistent.',
  'Security beyond declared authentication on entry paths.',
  'The quality of your trade-off reasoning, and everything you said out loud.',
]

const isNote = (el) => isNode(el) && (el.kind === 'note' || el.shape === 'note') && !el.crossed
const lines = (el) => String(el.text || '').split('\n').filter((l) => l.trim()).length
const LOAD_FIELDS = ['dau', 'writesPerUser', 'readsPerUser', 'writesPerDay', 'writesPerMonth', 'readWrite', 'writeQps', 'readQps']
const declaresLoad = (el) => !!el?.cap && LOAD_FIELDS.some((k) => el.cap[k] !== undefined)

/** Timeline index over the history: when each element first satisfied a predicate, in wall time and replay time. */
function timeline(base, done) {
  const replay = createReplay(base, done)
  /** First { t, replay } at which element `id` reached a state with pred(after) true, or null. */
  function when(id, pred = (a) => !!a) {
    if (base[id] && pred(base[id])) return { t: null, replay: 0 }
    let t = null
    for (const txn of done) {
      const c = txn.changes.find(([cid, , after]) => cid === id && after && pred(after))
      if (c) {
        t = txn.t
        break
      }
    }
    const i = replay.steps.findIndex((s) => s.changes.some(([cid, , after]) => cid === id && after && pred(after)))
    return t === null && i < 0 ? null : { t, replay: i < 0 ? null : replay.startOf(i) }
  }
  /** Wall-clock times at which element `id` was created or changed. */
  const touches = (id) => done.filter((txn) => txn.changes.some(([cid]) => cid === id)).map((txn) => txn.t)
  return { when, touches, replay }
}

const ev = (tl, ids, pred) => ids.map((id) => ({ id, at: tl.when(id, pred) }))

/**
 * The published items. `check(ctx)` returns { status, earned (0–1 fraction), detail, evidence }
 * with status 'met' | 'partial' | 'missed' | 'undeclared' | 'n/a'.
 */
export const ITEMS = [
  {
    id: 'requirements-note', phase: 'requirements', points: 8, title: 'Requirements written down',
    rule: 'A note with at least 3 lines exists. In practice mode it must be created during the Requirements phase for full marks (half if later).',
    check({ doc, tl, practice }) {
      const notes = Object.values(doc).filter((el) => isNote(el) && lines(el) >= 3).sort((a, b) => (a.id < b.id ? -1 : 1))
      if (!notes.length) return { status: 'missed', earned: 0, detail: 'No note with 3+ lines on the board.', evidence: [] }
      if (!practice) return { status: 'met', earned: 1, detail: 'A requirements note exists (timing not checked outside practice).', evidence: ev(tl, [notes[0].id]) }
      const inPhase = notes.find((n) => { const at = tl.when(n.id); return at?.t != null && phaseAt(practice, at.t) === 0 })
      return inPhase
        ? { status: 'met', earned: 1, detail: 'Written during the Requirements phase.', evidence: ev(tl, [inPhase.id]) }
        : { status: 'partial', earned: 0.5, detail: 'A note exists, but it was written after the Requirements phase.', evidence: ev(tl, [notes[0].id]) }
    },
  },
  {
    id: 'load-declared', phase: 'estimates', points: 8, title: 'Load estimated before the design',
    rule: 'A client declares load (users and per-user rates, writes per day/month with a read:write ratio, or rates). In practice mode it must be declared before the High-level design phase ends (half if later).',
    check({ tl, practice, review }) {
      const clients = [...review.capacity?.sources.keys() ?? []]
      if (!clients.length) return { status: 'missed', earned: 0, detail: 'No client declares load, so nothing derives QPS, storage or bandwidth.', evidence: [] }
      const evidence = ev(tl, clients, declaresLoad)
      if (!practice) return { status: 'met', earned: 1, detail: `${clients.length} client(s) declare load.`, evidence }
      const hldEnd = practice.marks[PHASE_IDS.indexOf('hld') + 1]?.t ?? practice.endedAt ?? Infinity
      const early = evidence.find((e) => e.at?.t != null && e.at.t < hldEnd)
      return early
        ? { status: 'met', earned: 1, detail: 'Declared before the high-level design was finished.', evidence: [early] }
        : { status: 'partial', earned: 0.5, detail: 'Declared, but only after the High-level design phase.', evidence }
    },
  },
  {
    id: 'storage-derived', phase: 'estimates', points: 4, title: 'Storage estimated',
    rule: 'Some durable store derives a storage figure (a client declares writeKB and the store declares retentionYears).',
    check({ tl, review }) {
      const ids = [...(review.capacity?.nodes ?? [])].filter(([, n]) => n.storage && n.storage.need?.[0] > 0 && Number.isFinite(n.storage.need[0])).map(([id]) => id)
      if (ids.length) return { status: 'met', earned: 1, detail: `${ids.length} store(s) derive storage.`, evidence: ev(tl, ids) }
      const pending = [...(review.capacity?.nodes ?? [])].filter(([, n]) => n.storage).map(([id]) => id)
      return pending.length
        ? { status: 'undeclared', earned: 0, detail: 'Writes reach a store, but writeKB or retentionYears is undeclared.', evidence: ev(tl, pending) }
        : { status: 'missed', earned: 0, detail: 'No store receives declared writes.', evidence: [] }
    },
  },
  {
    id: 'entry-path', phase: 'hld', points: 8, title: 'Clients enter through an edge tier',
    rule: 'Some client reaches a compute node through a load balancer or API gateway. Not scored for problems with no public request path (an internal batch system such as a crawler).',
    check({ tl, review, problem }) {
      if (problem?.publicEntry === false) return { status: 'n/a', earned: 0, detail: 'This problem has no public request path.', evidence: [] }
      const g = review.graph
      for (const c of g.nodes.values()) {
        if (c.role !== 'client') continue
        const reach = bfs(g, c.id)
        for (const id of reach.keys()) {
          if (g.nodes.get(id).role !== 'compute') continue
          const path = pathTo(reach, id)
          const tier = path.find((x) => ['load-balancer', 'api-gateway'].includes(g.nodes.get(x)?.kind))
          if (tier) return { status: 'met', earned: 1, detail: `${path.filter((x) => g.nodes.has(x)).map((x) => g.nodes.get(x).label).join(' → ')}`, evidence: ev(tl, path.filter((x) => g.nodes.has(x))) }
        }
      }
      return { status: 'missed', earned: 0, detail: 'No client reaches a service through a load balancer or API gateway.', evidence: [] }
    },
  },
  {
    id: 'durable-writes', phase: 'hld', points: 8, title: 'Writes reach durable storage',
    rule: 'The write-without-durable-store lint rule passes for at least one client and has no violations.',
    check: (ctx) => fromRule(ctx, 'write-without-durable-store', { needPass: (r) => r.elementIds.length > 1 }),
  },
  {
    id: 'read-path-cache', phase: 'hld', points: 8, title: 'The hot read path is cached',
    rule: 'When the problem is read-heavy (or declared reads are ≥ 10× writes), a cache or CDN is reachable from a client.',
    check({ tl, review, problem }) {
      const g = review.graph
      const src = [...(review.capacity?.sources.values() ?? [])].map((s) => s.load)
      const heavy = problem?.readHeavy ?? src.some((l) => l.r[0] >= 10 * l.w[1] && l.r[0] > 0)
      if (!heavy) return { status: 'n/a', earned: 0, detail: 'Not a read-heavy problem.', evidence: [] }
      for (const c of g.nodes.values()) {
        if (c.role !== 'client') continue
        const reach = bfs(g, c.id)
        const hit = [...reach.keys()].find((id) => g.nodes.get(id).role === 'cache' || g.nodes.get(id).kind === 'cdn')
        if (hit) return { status: 'met', earned: 1, detail: `${g.nodes.get(hit).label} serves reads.`, evidence: ev(tl, pathTo(reach, hit).filter((x) => g.nodes.has(x))) }
      }
      return { status: 'missed', earned: 0, detail: 'Reads dominate but no cache or CDN sits on a client\'s path.', evidence: [] }
    },
  },
  {
    id: 'must-have-components', phase: 'hld', points: 12, title: 'The problem\'s must-have components',
    rule: 'For each component the problem lists, at least one node of an accepted kind exists (not crossed out). Points split evenly.',
    check({ tl, review, problem }) {
      if (!problem) return { status: 'n/a', earned: 0, detail: 'No problem selected.', evidence: [] }
      const nodes = [...review.graph.nodes.values()]
      const parts = problem.components.map((c) => ({ c, n: nodes.find((n) => c.anyOf.includes(n.kind)) }))
      const got = parts.filter((p) => p.n)
      const detail = parts.map((p) => `${p.n ? '✓' : '✗'} ${p.c.title}`).join(' · ')
      const earned = got.length / parts.length
      return { status: earned === 1 ? 'met' : earned ? 'partial' : 'missed', earned, detail, evidence: ev(tl, got.map((p) => p.n.id)) }
    },
  },
  {
    id: 'async-offload', phase: 'hld', points: 4, title: 'Slow work runs asynchronously',
    rule: 'At least one queue or stream has a consumer (the queue-without-consumer rule passes) and none is left unconsumed. Not scored when the problem lists no asynchronous component and the board has no queue.',
    check(ctx) {
      const QUEUES = ['message-queue', 'event-stream', 'pub-sub']
      const wanted = !ctx.problem || ctx.problem.components.some((c) => c.anyOf.some((k) => QUEUES.includes(k)))
      const present = [...ctx.review.graph.nodes.values()].some((n) => n.role === 'queue')
      if (!wanted && !present) return { status: 'n/a', earned: 0, detail: 'This problem doesn\'t call for asynchronous work.', evidence: [] }
      return fromRule(ctx, 'queue-without-consumer')
    },
  },
  {
    id: 'redundancy', phase: 'deep-dive', points: 8, title: 'No single points of failure',
    rule: 'Every node the single-point-of-failure rule examines passes. Partial credit is the fraction that pass; undeclared redundancy earns nothing for that node.',
    check: (ctx) => fromRule(ctx, 'single-point-of-failure', { proportional: true }),
  },
  {
    id: 'capacity-consistent', phase: 'deep-dive', points: 8, title: 'Capacity is declared and consistent',
    rule: 'The capacity-contradiction rule has at least one pass and no violations. Partial credit is the fraction of checked nodes that pass.',
    check: (ctx) => fromRule(ctx, 'capacity-contradiction', { proportional: true }),
  },
  {
    id: 'no-lint-errors', phase: 'deep-dive', points: 6, title: 'No error-level lint violations',
    rule: 'A client is drawn and connected, and no violation comes from an error-severity rule (write-without-durable-store, capacity-contradiction, client-to-datastore, queue-without-consumer).',
    check({ tl, review }) {
      if (![...review.graph.nodes.values()].some((n) => n.role === 'client') || !review.graph.edges.length) return { status: 'missed', earned: 0, detail: 'Nothing to check yet: draw a client and connect it.', evidence: [] }
      const bad = review.violations.filter((r) => r.severity === 'error')
      return bad.length
        ? { status: 'missed', earned: 0, detail: bad.map((r) => r.message).join(' '), evidence: ev(tl, [...new Set(bad.flatMap((r) => r.elementIds))]) }
        : { status: 'met', earned: 1, detail: 'No error-level violations.', evidence: [] }
    },
  },
  {
    id: 'rejected-alternative', phase: 'trade-offs', points: 6, title: 'A rejected alternative is shown',
    rule: 'At least one node is crossed out (X): an option considered and rejected, kept visible.',
    check({ doc, tl }) {
      const crossed = Object.values(doc).filter((el) => isNode(el) && el.crossed).map((el) => el.id).sort()
      return crossed.length
        ? { status: 'met', earned: 1, detail: `${crossed.length} crossed-out option(s).`, evidence: ev(tl, crossed, (a) => a.crossed) }
        : { status: 'missed', earned: 0, detail: 'Nothing is crossed out. Press X on a rejected option instead of deleting it.', evidence: [] }
    },
  },
  {
    id: 'trade-off-notes', phase: 'trade-offs', points: 4, title: 'Trade-offs written down',
    rule: 'In practice mode, a note is created or edited during the Trade-offs phase. Outside practice, at least two notes exist.',
    check({ doc, tl, practice }) {
      const notes = Object.values(doc).filter(isNote).map((el) => el.id).sort()
      if (!practice) return notes.length >= 2 ? { status: 'met', earned: 1, detail: `${notes.length} notes.`, evidence: ev(tl, notes) } : { status: 'missed', earned: 0, detail: 'Fewer than two notes.', evidence: ev(tl, notes) }
      const k = PHASE_IDS.indexOf('trade-offs')
      const hit = notes.find((id) => tl.touches(id).some((t) => phaseAt(practice, t) === k))
      return hit ? { status: 'met', earned: 1, detail: 'A note was written during Trade-offs.', evidence: ev(tl, [hit]) } : { status: 'missed', earned: 0, detail: 'No note was written during the Trade-offs phase.', evidence: [] }
    },
  },
  {
    id: 'phase-timing', phase: 'process', points: 8, title: 'Phases kept to time',
    rule: `Practice mode only: each finished phase took at most ${GRACE}× its budget and has at least one committed step in it. A phase with no work in it is skipped, not on time. Partial credit is the fraction on time.`,
    check({ practice, now, done }) {
      if (!practice) return { status: 'n/a', earned: 0, detail: 'Not a timed session.', evidence: [] }
      const rows = timing(practice, now)
      const steps = activity(practice, done)
      const finished = rows.filter((r) => r.status === 'done')
      if (!finished.length) return { status: 'undeclared', earned: 0, detail: 'No phase finished yet.', evidence: [] }
      const onTime = finished.filter((r) => r.elapsed <= r.budget * GRACE && steps[PHASES.findIndex((p) => p.id === r.id)] > 0)
      const earned = onTime.length / PHASES.length
      const detail = rows.map((r, i) => (r.status === 'done' && !steps[i] ? `${r.title} skipped` : `${r.title} ${Math.round(r.elapsed / 60000)}/${r.minutes} min`)).join(' · ')
      return { status: earned === 1 ? 'met' : earned ? 'partial' : 'missed', earned, detail, evidence: [] }
    },
  },
]

/** Score an item from one lint rule's results: violations miss, unknowns are undeclared, passes meet. */
function fromRule({ tl, review }, rule, { proportional = false, needPass = () => true } = {}) {
  const rs = review.results.filter((r) => r.rule === rule)
  const v = rs.filter((r) => r.status === 'violation'), u = rs.filter((r) => r.status === 'unknown'), p = rs.filter((r) => r.status === 'pass' && needPass(r))
  const ids = (list) => ev(tl, [...new Set(list.flatMap((r) => (r.witness ?? r.elementIds).filter((id) => review.graph.nodes.has(id))))])
  if (v.length && !proportional) return { status: 'missed', earned: 0, detail: v.map((r) => r.message).join(' '), evidence: ids(v) }
  if (!p.length && !v.length && !u.length) return { status: 'missed', earned: 0, detail: 'Nothing on the board for this check yet.', evidence: [] }
  if (proportional) {
    const earned = rs.length ? p.length / rs.length : 0
    const status = earned === 1 ? 'met' : v.length ? (earned ? 'partial' : 'missed') : u.length ? (earned ? 'partial' : 'undeclared') : 'missed'
    const detail = [v.length && `${v.length} violation(s): ${v.map((r) => r.message).join(' ')}`, u.length && `${u.length} undeclared: ${u.map((r) => r.message).join(' ')}`, p.length && `${p.length} pass`].filter(Boolean).join(' · ')
    return { status, earned, detail, evidence: ids(v.length ? v : u.length ? u : p) }
  }
  if (!p.length) return { status: 'undeclared', earned: 0, detail: u.map((r) => r.message).join(' '), evidence: ids(u) }
  return { status: 'met', earned: 1, detail: p[0].message, evidence: ids(p.slice(0, 1)) }
}

/**
 * Score a board. `doc` must be the committed document (fold(base, done)).
 * Returns { version, percent, earned, max, items, assumptions, cannotInfer, review }.
 */
export function scoreBoard({ doc, base = {}, done = [], practice = null, problem = null, now = Date.now() }) {
  const review = lint(doc)
  const tl = timeline(base, done)
  const ctx = { doc, tl, review, practice, problem, now, done }
  const items = ITEMS.map((it) => {
    const r = it.check(ctx)
    const points = r.status === 'n/a' ? 0 : it.points
    return { id: it.id, phase: it.phase, title: it.title, rule: it.rule, points, earned: Math.round(points * r.earned * 10) / 10, status: r.status, detail: r.detail, evidence: r.evidence }
  })
  const max = items.reduce((s, i) => s + i.points, 0)
  const earned = Math.round(items.reduce((s, i) => s + i.earned, 0) * 10) / 10
  return { version: RUBRIC_VERSION, percent: max ? Math.round((earned / max) * 100) : 0, earned, max, items, assumptions: ASSUMPTIONS, cannotInfer: CANNOT_INFER, review }
}

/** The published rubric as plain data (for the guide, critique bundles and agents). */
export const rubricDefinition = () => ({
  version: RUBRIC_VERSION,
  phases: PHASES.map(({ id, title, minutes, goal }) => ({ id, title, minutes, goal })),
  items: ITEMS.map(({ id, phase, points, title, rule }) => ({ id, phase, points, title, rule })),
  assumptions: ASSUMPTIONS,
  cannotInfer: CANNOT_INFER,
})
