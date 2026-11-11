// Architecture lint: pure rules over the typed graph (review/graph.js). Rules
// check the declared model, not the deployed system.
//
// Every rule returns results in three kinds:
//   violation — the diagram demonstrates the problem; `witness` is the path or
//               edge that shows it (alternating node and edge ids);
//   unknown   — the answer depends on something the diagram doesn't declare
//               (replicas, auth, TTL, load …); the result says what to declare;
//   pass      — the diagram demonstrates the property; `witness` shows how.
// A missing annotation is never a violation. Results are deterministic (graph
// order is id order) and carry stable ids `rule:element+element`, so a critique
// or a later review can cite them.

import { MANAGED_KINDS, bfs, buildGraph, carriesWrites, cycles, isDurable, pathTo } from './graph.js'
import { propagate, formatInterval } from './capacity.js'
import { rate, size } from './units.js'

export const LINT_VERSION = 1
/** Larger graphs are reported as unknown rather than analysed (path rules are O(n²)). */
export const MAX_NODES = 600

const EDGE_TIER = new Set(['dns', 'cdn', 'load-balancer', 'rate-limiter', 'api-gateway'])
const managed = (n) => n.cap.managed === true || (MANAGED_KINDS.has(n.kind) && n.cap.managed !== false)
const writes = carriesWrites
/** Entry paths examined per entry node before the rule reports unknown instead of a verdict. */
export const MAX_ENTRY_PATHS = 1000
const sync = (e) => !e.async

const result = (rule, status, elementIds, message, extra = {}) => ({
  id: `${rule}:${elementIds.join('+')}`, rule, status, elementIds, message, witness: extra.witness ?? null, declare: extra.declare ?? null,
})

/** A path witness's nodes, labelled, for messages: "Client → LB → API". */
const say = (g, path) => path.filter((id) => g.nodes.has(id)).map((id) => g.nodes.get(id).label).join(' → ')
const name = (g, id) => `“${g.nodes.get(id).label}”`

export const RULES = [
  {
    id: 'single-point-of-failure',
    severity: 'warning',
    title: 'Single point of failure',
    checks: 'A node that every path from some client to some durable store goes through (or that durable store itself), excluding managed kinds (dns, cdn, object-storage, external-api, payments, notifications, email-sms, webhook) and nodes declared managed.',
    violation: 'It declares replicas: 1.',
    unknown: 'It declares neither replicas nor managed.',
    pass: 'It declares replicas ≥ 2 or managed: true.',
    fix: 'Run at least two replicas (behind a load balancer for services, leader + followers for stores), or declare a managed, multi-AZ service.',
    check({ g }) {
      const out = []
      const done = new Set()
      for (const c of g.nodes.values()) {
        if (c.role !== 'client') continue
        const reach = bfs(g, c.id)
        const stores = [...reach.keys()].filter((id) => isDurable(g.nodes.get(id)))
        for (const s of stores) {
          for (const v of reach.keys()) {
            const n = g.nodes.get(v)
            if (done.has(v) || v === c.id || !['edge', 'auth', 'compute', 'store', 'queue', 'cache'].includes(n.role) || managed(n)) continue
            if (v !== s && bfs(g, c.id, { skip: v }).has(s)) continue
            done.add(v)
            const witness = v === s ? pathTo(reach, s) : [...pathTo(reach, v), ...pathTo(bfs(g, v), s).slice(1)]
            const via = v === s ? `holds the data ${name(g, c.id)} reaches` : `is on every path from ${name(g, c.id)} to ${name(g, s)}`
            const r = n.cap.replicas
            if (r >= 2) out.push(result(this.id, 'pass', [v], `${name(g, v)} ${via} and runs ${r} replicas.`, { witness }))
            else if (r === 1) out.push(result(this.id, 'violation', [v], `${name(g, v)} ${via} and declares a single replica: if it fails, ${say(g, witness)} stops.`, { witness }))
            else out.push(result(this.id, 'unknown', [v], `${name(g, v)} ${via}, but its redundancy isn't declared.`, { witness, declare: 'replicas or managed' }))
          }
        }
      }
      return out
    },
  },
  {
    id: 'cache-without-invalidation',
    severity: 'warning',
    title: 'Cache without an invalidation path',
    checks: 'Each cache: does it expire entries, or does a write path reach it? A writer is a node with a write-carrying edge to a durable store; it invalidates the cache when it also has a write-carrying edge to the cache. A consumer of a queue or stream that writes to the cache also counts.',
    violation: 'It declares ttlSec: 0 (never expires) and some writer updates the store behind it without touching the cache.',
    unknown: 'No TTL is declared and no invalidation edge is drawn.',
    pass: 'It declares ttlSec > 0, or an invalidation edge is drawn.',
    fix: 'Give entries a TTL, or draw the invalidation: the writer deletes or updates the key (write-through), or an event consumer does.',
    check({ g }) {
      const out = []
      const writers = [...g.nodes.values()].filter((n) => g.out.get(n.id).some((e) => writes(e) && isDurable(g.nodes.get(e.to))))
      for (const c of g.nodes.values()) {
        if (c.role !== 'cache') continue
        if (c.cap.ttlSec > 0) {
          out.push(result(this.id, 'pass', [c.id], `${name(g, c.id)} expires entries after ${c.cap.ttlSec} s.`))
          continue
        }
        const touch = writers.map((w) => g.out.get(w.id).find((e) => e.to === c.id && writes(e)) && w).find(Boolean)
        if (touch) {
          const e = g.out.get(touch.id).find((x) => x.to === c.id && writes(x))
          out.push(result(this.id, 'pass', [c.id, touch.id], `${name(g, touch.id)} writes the store and updates ${name(g, c.id)} on the same path.`, { witness: [touch.id, e.id, c.id] }))
          continue
        }
        const consumer = g.inn.get(c.id).find((e) => writes(e) && g.inn.get(e.from).some((x) => g.nodes.get(x.from).role === 'queue'))
        if (consumer) {
          const q = g.inn.get(consumer.from).find((x) => g.nodes.get(x.from).role === 'queue')
          out.push(result(this.id, 'pass', [c.id, consumer.from], `${name(g, consumer.from)} consumes ${name(g, q.from)} and updates ${name(g, c.id)}.`, { witness: [q.from, q.id, consumer.from, consumer.id, c.id] }))
          continue
        }
        // which stores does this cache front? read-through (cache → store) or cache-aside (a reader of both)
        const fronted = new Set(g.out.get(c.id).map((e) => e.to).filter((id) => isDurable(g.nodes.get(id))))
        for (const e of g.inn.get(c.id)) for (const x of g.out.get(e.from)) if (isDurable(g.nodes.get(x.to))) fronted.add(x.to)
        const bypass = writers.map((w) => [w, g.out.get(w.id).find((e) => writes(e) && fronted.has(e.to))]).find(([, e]) => e)
        if (c.cap.ttlSec === 0 && bypass) {
          const [w, e] = bypass
          out.push(result(this.id, 'violation', [c.id, w.id, e.to], `${name(g, c.id)} never expires (ttlSec 0) and ${name(g, w.id)} writes ${name(g, e.to)} without touching it, so reads can stay stale indefinitely.`, { witness: [w.id, e.id, e.to] }))
        } else {
          out.push(result(this.id, 'unknown', [c.id], `${name(g, c.id)} has no declared TTL and no drawn invalidation path.`, { declare: 'ttlSec, or a writer → cache edge' }))
        }
      }
      return out
    },
  },
  {
    id: 'write-without-durable-store',
    severity: 'error',
    title: 'Writes never reach a durable store',
    checks: 'From each client with outgoing edges, follow every edge that carries writes (carries is not "reads"), through any node, and look for a durable store (sql-database, nosql-store, object-storage, search-index, vector-db, data-warehouse). A cache is not durable.',
    violation: 'The client declares writes (a write rate above 0 or an edge with carries: "writes") and no durable store is reachable.',
    unknown: 'No durable store is reachable but the client doesn\'t declare whether it writes.',
    pass: 'A durable store is reachable on a write path, or the client declares zero writes.',
    fix: 'Persist writes in a durable store (directly, or through a queue and a consumer). A cache alone loses data on restart or eviction.',
    check({ g, cap }) {
      const out = []
      for (const c of g.nodes.values()) {
        if (c.role !== 'client' || !g.out.get(c.id).length) continue
        const seen = bfs(g, c.id, { follow: writes })
        const store = [...seen.keys()].find((id) => isDurable(g.nodes.get(id)))
        const src = cap.sources.get(c.id)?.load
        if (src && src.w[1] === 0) {
          out.push(result(this.id, 'pass', [c.id], `${name(g, c.id)} declares no writes.`))
        } else if (store) {
          const witness = pathTo(seen, store)
          out.push(result(this.id, 'pass', [c.id, store], `Writes from ${name(g, c.id)} reach ${name(g, store)}: ${say(g, witness)}.`, { witness }))
        } else if ((src && src.w[0] > 0) || g.edges.some((e) => e.carries === 'writes' && seen.has(e.from))) {
          const last = [...seen.keys()].at(-1)
          const witness = pathTo(seen, last)
          out.push(result(this.id, 'violation', [c.id, last], `Writes from ${name(g, c.id)} end at ${name(g, last)} (${say(g, witness)}) and never reach a durable store.`, { witness }))
        } else {
          out.push(result(this.id, 'unknown', [c.id], `No durable store is reachable from ${name(g, c.id)}, and it doesn't declare whether it writes.`, { declare: 'the client\'s write rate, or carries: "reads" on its edges' }))
        }
      }
      return out
    },
  },
  {
    id: 'capacity-contradiction',
    severity: 'error',
    title: 'Capacity contradiction',
    checks: 'Load declared at clients, propagated along edges (see "Capacity"), against each node\'s declared rating per instance (qpsPerNode) and each store\'s declared storageTB.',
    violation: 'The load per instance exceeds the rating, or the data retained exceeds the storage, for every value of what is undeclared.',
    unknown: 'The node carries load but declares no rating, or the outcome depends on undeclared replicas, shards, hit ratios or payload sizes.',
    pass: 'The rating covers the load (and storage covers the data) for every value of what is undeclared.',
    fix: 'Add replicas or shards, put a cache in front, or raise the rating; for storage, add shards, shorten retention or tier cold data to object storage.',
    check({ g, cap }) {
      if (!cap.declared) return [result(this.id, 'unknown', [], 'No client declares load, so capacity can\'t be checked.', { declare: 'dau and writes/reads per user (or writeQps/readQps) on a client' })]
      const out = []
      for (const [id, info] of cap.nodes) {
        const r = info.rating
        if (r) {
          const per = formatInterval(r.per, rate)
          if (r.status === 'violation') out.push(result(this.id, 'violation', [id], `${name(g, id)} receives ${per} per instance (${r.formula}) but is rated ${rate(r.limit)}.`))
          else if (r.status === 'pass') out.push(result(this.id, 'pass', [id], `${name(g, id)} handles ${per} per instance within its ${rate(r.limit)} rating.`))
          else out.push(result(this.id, 'unknown', [id], `${name(g, id)} carries ${per} per instance; ${r.reason}.`, { declare: r.limit == null ? 'qpsPerNode' : r.reason.replace('depends on undeclared ', '') }))
        }
        const s = info.storage
        if (s && s.limit != null) {
          const need = formatInterval(s.need, size)
          if (s.status === 'violation') out.push(result(this.id, 'violation', [id], `${name(g, id)} must hold ${need} (${s.formula}) but declares ${size(s.limit)}.`))
          else if (s.status === 'pass') out.push(result(this.id, 'pass', [id], `${name(g, id)} holds ${need} within ${size(s.limit)}.`))
          else out.push(result(this.id, 'unknown', [id], `${name(g, id)} storage ${need} vs ${size(s.limit)}: ${s.reason}.`, { declare: 'writeKB and replicationFactor' }))
        }
      }
      return out
    },
  },
  {
    id: 'unauthenticated-public-entry',
    severity: 'warning',
    title: 'Unauthenticated public entry',
    checks: 'Each entry node (the first node past the edge tier: dns, cdn, load-balancer, rate-limiter, api-gateway) and every synchronous path to it from every client through the edge tier. Auth services, stores, caches and queues are skipped (client-to-datastore covers data reached directly).',
    violation: 'Some entry path has a node that declares auth: false and nothing on that path authenticates or declares public: true.',
    unknown: 'Some entry path has nothing that declares auth, connects to an auth-service, or declares public (or there are too many paths to check).',
    pass: 'Every entry path has a node that declares auth: true or has an edge to an auth-service, or declares public: true. One authenticated route never hides another.',
    fix: 'Authenticate at the gateway or entry service (draw its edge to the auth service, or declare auth: true), or declare the entry public if anonymous access is intended.',
    check({ g }) {
      // Every entry path counts: one authenticated route must not hide another. Paths are every simple
      // path from any client through edge-tier nodes only to a first non-edge node, enumerated exhaustively.
      const isEntry = (n) => !EDGE_TIER.has(n.kind) && !['client', 'auth', 'store', 'cache', 'queue'].includes(n.role)
      const talksToAuth = (x) => [...g.out.get(x.id), ...g.inn.get(x.id)].some((e) => g.nodes.get(e.from === x.id ? e.to : e.from).role === 'auth')
      const paths = new Map() // entry id → [{ client, path (node and edge ids) }]
      let overflow = false, steps = 0
      for (const c of g.nodes.values()) {
        if (c.role !== 'client') continue
        const walk = (v, path, seen) => {
          if (overflow || ++steps > MAX_ENTRY_PATHS * 100) return void (overflow = true)
          for (const e of g.out.get(v)) {
            if (!sync(e) || seen.has(e.to)) continue
            const n = g.nodes.get(e.to)
            const next = [...path, e.id, e.to]
            if (isEntry(n)) {
              const list = paths.get(e.to) ?? []
              if (list.length >= MAX_ENTRY_PATHS) overflow = true
              else list.push({ client: c.id, path: next })
              paths.set(e.to, list)
            } else if (EDGE_TIER.has(n.kind)) walk(e.to, next, new Set([...seen, e.to]))
          }
        }
        walk(c.id, [c.id], new Set([c.id]))
      }
      const out = []
      for (const [v, list] of [...paths].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const verdicts = list.map(({ client, path }) => {
          const onPath = path.filter((id) => g.nodes.has(id)).map((id) => g.nodes.get(id))
          const authed = onPath.find((x) => x.cap.auth === true || talksToAuth(x))
          const pub = onPath.find((x) => x.cap.public === true)
          const denied = onPath.find((x) => x.cap.auth === false)
          return { client, path, status: authed ? 'auth' : pub ? 'public' : denied ? 'denied' : 'unknown', by: authed ?? pub ?? denied }
        })
        const bad = verdicts.find((p) => p.status === 'denied')
        const open = verdicts.find((p) => p.status === 'unknown')
        const routes = `${list.length} entry path${list.length > 1 ? 's' : ''}`
        if (bad) out.push(result(this.id, 'violation', [v], `${name(g, v)} is reachable from ${name(g, bad.client)} through ${say(g, bad.path)}, and ${name(g, bad.by.id)} declares no authentication (${routes} checked).`, { witness: bad.path }))
        else if (open || overflow) out.push(result(this.id, 'unknown', [v], open ? `${name(g, v)} is a public entry through ${say(g, open.path)} with no declared authentication (${routes} checked).` : `${name(g, v)} has more than ${MAX_ENTRY_PATHS} entry paths; not all were checked.`, { witness: open?.path ?? null, declare: 'auth on the gateway or service, an edge to the auth service, or public' }))
        else {
          const p = verdicts[0]
          out.push(result(this.id, 'pass', [v], p.status === 'auth' && verdicts.every((x) => x.status === 'auth' && x.by.id === p.by.id) ? `${name(g, v)} is reached through ${say(g, p.path)}; ${name(g, p.by.id)} authenticates (${routes} checked).` : `Every entry path to ${name(g, v)} is authenticated or deliberately public (${routes} checked).`, { witness: p.path }))
        }
      }
      return out
    },
  },
  {
    id: 'client-to-datastore',
    severity: 'error',
    title: 'Client talks to a datastore directly',
    checks: 'Edges from a client straight to a store, cache or queue. Object storage is exempt (pre-signed URLs are the standard pattern).',
    violation: 'Such an edge is drawn.',
    unknown: 'Never: this rule reads only what is drawn.',
    pass: 'The client has edges and none of them goes to a datastore.',
    fix: 'Put a service (or API gateway) between the client and the data, so access control, validation and schema changes live server-side. For uploads, use pre-signed object-storage URLs.',
    check({ g }) {
      const out = []
      for (const c of g.nodes.values()) {
        if (c.role !== 'client' || !g.out.get(c.id).length) continue
        const bad = g.out.get(c.id).filter((e) => {
          const t = g.nodes.get(e.to)
          return ['store', 'cache', 'queue'].includes(t.role) && t.kind !== 'object-storage'
        })
        for (const e of bad) out.push(result(this.id, 'violation', [c.id, e.to], `${name(g, c.id)} connects directly to ${name(g, e.to)}.`, { witness: [c.id, e.id, e.to] }))
        if (!bad.length) out.push(result(this.id, 'pass', [c.id], `${name(g, c.id)} reaches data only through services.`))
      }
      return out
    },
  },
  {
    id: 'orphan-component',
    severity: 'info',
    title: 'Unconnected component',
    checks: 'Architecture nodes with no edge to another architecture node. Ops kinds (monitoring, logs, analytics, config) are exempt: they observe everything implicitly.',
    violation: 'The node has no edges.',
    unknown: 'Never.',
    pass: 'Not listed per node.',
    fix: 'Connect it to what calls it or what it calls, or cross it out (X) if it is a rejected option.',
    check({ g }) {
      return [...g.nodes.values()]
        .filter((n) => n.role !== 'ops' && !g.out.get(n.id).length && !g.inn.get(n.id).length)
        .map((n) => result(this.id, 'violation', [n.id], `${name(g, n.id)} isn't connected to anything.`))
    },
  },
  {
    id: 'queue-without-consumer',
    severity: 'error',
    title: 'Queue without a consumer',
    checks: 'Every message-queue, event-stream and pub-sub node needs an outgoing edge to whatever consumes it.',
    violation: 'The queue has no outgoing edge.',
    unknown: 'Never.',
    pass: 'At least one consumer is drawn.',
    fix: 'Draw the consumer (a worker or service) reading from the queue, or remove the queue.',
    check({ g }) {
      const out = []
      for (const q of g.nodes.values()) {
        if (q.role !== 'queue') continue
        const consumer = g.out.get(q.id)[0]
        if (consumer) out.push(result(this.id, 'pass', [q.id], `${name(g, q.id)} is consumed by ${name(g, consumer.to)}.`, { witness: [q.id, consumer.id, consumer.to] }))
        else {
          const producer = g.inn.get(q.id)[0]
          out.push(result(this.id, 'violation', [q.id], `Nothing consumes ${name(g, q.id)}; messages pile up until retention drops them.`, { witness: producer ? [producer.from, producer.id, q.id] : [q.id] }))
        }
      }
      return out
    },
  },
  {
    id: 'deep-sync-chain',
    severity: 'warning',
    title: 'Deep synchronous call chain',
    checks: 'The longest path of solid (synchronous) edges through compute and auth nodes. More than 4 services in a row multiplies latency and failure probability.',
    violation: 'A synchronous chain of 5 or more services is drawn.',
    unknown: 'Never.',
    pass: 'No synchronous service chain is longer than 4.',
    fix: 'Make the tail of the chain asynchronous (a queue), collapse services, or call independent services in parallel from one place.',
    check({ g }) {
      const svc = (id) => ['compute', 'auth'].includes(g.nodes.get(id).role)
      const memo = new Map(), visiting = new Set()
      const longest = (v) => {
        if (memo.has(v)) return memo.get(v)
        visiting.add(v)
        let best = [v]
        for (const e of g.out.get(v)) {
          if (!sync(e) || !svc(e.to) || visiting.has(e.to)) continue
          const p = longest(e.to)
          if (p.length + 2 > best.length) best = [v, e.id, ...p]
        }
        visiting.delete(v)
        memo.set(v, best)
        return best
      }
      let best = []
      for (const id of g.nodes.keys()) if (svc(id)) {
        const p = longest(id)
        if (p.length > best.length) best = p
      }
      const count = best.filter((id) => g.nodes.has(id)).length
      if (count > 4) return [result(this.id, 'violation', best.filter((id) => g.nodes.has(id)), `${count} services call each other synchronously: ${say(g, best)}.`, { witness: best })]
      return count ? [result(this.id, 'pass', [], `The longest synchronous service chain is ${count}.`, { witness: best })] : []
    },
  },
  {
    id: 'sync-cycle',
    severity: 'warning',
    title: 'Synchronous call cycle',
    checks: 'Strongly connected components of solid (synchronous) edges among non-client nodes.',
    violation: 'Services call each other in a cycle: a slow member can deadlock or amplify load around it.',
    unknown: 'Never.',
    pass: 'No synchronous cycle.',
    fix: 'Break the cycle: make one direction asynchronous (an event), or move the shared logic into one service.',
    check({ g }) {
      const follow = (e) => sync(e) && g.nodes.get(e.from).role !== 'client' && g.nodes.get(e.to).role !== 'client'
      const comps = cycles(g, follow)
      if (!comps.length) return g.edges.length ? [result(this.id, 'pass', [], 'No synchronous cycles.')] : []
      return comps.map((comp) => {
        const inComp = new Set(comp)
        const start = comp[0]
        // shortest cycle through `start` inside the component
        let witness = null
        for (const e of g.out.get(start)) {
          if (!follow(e) || !inComp.has(e.to)) continue
          const back = bfs(g, e.to, { follow, enter: (n) => inComp.has(n.id) })
          const p = pathTo(back, start)
          if (p && (!witness || p.length + 2 < witness.length)) witness = [start, e.id, ...p]
        }
        return result(this.id, 'violation', comp, `Synchronous cycle: ${say(g, witness ?? comp)}.`, { witness })
      })
    },
  },
]

export const RULE_BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]))

/**
 * Lint a document map. Returns { version, results, violations, unknowns, passes, graph, capacity }.
 * Results are ordered by rule, then status (violation, unknown, pass), then id.
 */
export function lint(doc, { graph = buildGraph(doc) } = {}) {
  const g = graph
  if (g.nodes.size > MAX_NODES) {
    const results = [result('limits', 'unknown', [], `The architecture graph has ${g.nodes.size} nodes; review analyses up to ${MAX_NODES}.`)]
    return { version: LINT_VERSION, results, violations: [], unknowns: results, passes: [], graph: g, capacity: null }
  }
  const capacity = propagate(g)
  const RANK = { violation: 0, unknown: 1, pass: 2 }
  const results = RULES.flatMap((rule) => rule.check({ g, cap: capacity }).map((r) => ({ ...r, severity: rule.severity })))
    .sort((a, b) => RULES.indexOf(RULE_BY_ID[a.rule]) - RULES.indexOf(RULE_BY_ID[b.rule]) || RANK[a.status] - RANK[b.status] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return {
    version: LINT_VERSION,
    results,
    violations: results.filter((r) => r.status === 'violation'),
    unknowns: results.filter((r) => r.status === 'unknown'),
    passes: results.filter((r) => r.status === 'pass'),
    graph: g,
    capacity,
  }
}
