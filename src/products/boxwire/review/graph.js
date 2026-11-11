// The typed architecture graph: the board read as declared intent. Nodes are
// keyed by their stable element ids and carry a semantic kind and role; edges
// carry a direction and a mode (sync or async). Lint, capacity and the rubric
// all read this one structure, never the drawing, so a rule can't depend on
// how a box looks or what its label says.
//
// What is deliberately left out: crossed-out nodes (rejected options) and every
// edge touching them, zones, frames, notes, text and plain shapes, and edges
// whose ends aren't both architecture nodes.

import { isEdge, isNode } from '../core/elements.js'
import { NODE_KINDS } from '../author/vocabulary.js'

/** Role of each architecture kind. Anything not listed is an annotation and stays out of the graph. */
export const ROLES = {
  client: ['web-client', 'mobile-app', 'user'],
  edge: ['dns', 'cdn', 'load-balancer', 'api-gateway', 'rate-limiter'],
  auth: ['auth-service'],
  compute: ['service', 'worker', 'serverless-function', 'scheduler', 'llm-inference', 'agent', 'container'],
  store: ['sql-database', 'nosql-store', 'object-storage', 'search-index', 'vector-db', 'data-warehouse'],
  cache: ['cache'],
  queue: ['message-queue', 'event-stream', 'pub-sub'],
  external: ['external-api', 'payments', 'notifications', 'email-sms', 'webhook'],
  ops: ['monitoring', 'logs', 'analytics', 'config'],
}
const ROLE_OF = Object.fromEntries(Object.entries(ROLES).flatMap(([role, kinds]) => kinds.map((k) => [k, role])))
export const roleOf = (kind) => ROLE_OF[kind] ?? null

/**
 * Kinds operated as managed, highly available services by default: the review
 * treats their availability as declared. Anything else needs `replicas` or
 * `managed: true` before availability counts as known.
 */
export const MANAGED_KINDS = new Set(['dns', 'cdn', 'object-storage', 'external-api', 'payments', 'notifications', 'email-sms', 'webhook'])

// Boards drawn before kinds were stored (or with raw shapes) still read: a kind
// is inferred only from the catalog's own unambiguous shape + icon (+ colour) presets.
const PRESETS = Object.values(NODE_KINDS).filter((it) => ROLE_OF[it.kind])
function inferKind(el) {
  const matches = PRESETS.filter((it) => it.shape === el.shape && (it.icon ?? null) === (el.icon ?? null))
  if (matches.length === 1) return matches[0].kind
  const byColor = matches.filter((it) => (it.color ?? 'ink') === el.color)
  return byColor.length === 1 ? byColor[0].kind : null
}

/** Semantic kind of a node: as stored, else inferred from its catalog preset. `{ kind, inferred }`. */
export function kindOfNode(el) {
  if (el.kind && Object.hasOwn(NODE_KINDS, el.kind)) return { kind: el.kind, inferred: false }
  const kind = el.shape === 'component' || el.shape === 'cylinder' || el.shape === 'queue' || el.shape === 'actor' || el.shape === 'cloud' ? inferKind(el) : null
  return { kind, inferred: !!kind }
}

/** First line of a node's label, for messages. */
export const labelOf = (el) => (String(el.text || '').split('\n').find((l) => l.trim()) || el.kind || el.shape).replace(/^[«*]+|[»*]+$/g, '').trim()

/**
 * An edge's request direction: the end with an arrowhead is where the request
 * goes. A connector with a head only at its start points backwards; one with
 * none (or both) reads from → to. Dashed connectors are asynchronous.
 */
function direction(el) {
  const head = el.head && el.head !== 'none', tail = el.tail && el.tail !== 'none'
  return !head && tail ? [el.to.id, el.from.id] : [el.from.id, el.to.id]
}

const ARCH_HEADS = new Set(['none', 'arrow', 'open'])

/**
 * Build the graph from a document map. Deterministic: nodes and edges are in id order.
 * Returns { nodes: Map<id, GNode>, edges: GEdge[], out: Map<id, GEdge[]>, inn: Map<id, GEdge[]> }.
 * GNode = { id, kind, role, inferred, label, cap, el }; GEdge = { id, from, to, async, carries, el }.
 */
export function buildGraph(doc) {
  const nodes = new Map()
  const ids = Object.keys(doc).sort()
  for (const id of ids) {
    const el = doc[id]
    if (!isNode(el) || el.crossed) continue
    const { kind, inferred } = kindOfNode(el)
    const role = roleOf(kind)
    if (!role) continue
    nodes.set(id, { id, kind, role, inferred, label: labelOf(el), cap: el.cap ?? {}, el })
  }
  const edges = []
  for (const id of ids) {
    const el = doc[id]
    if (!isEdge(el) || !el.from.id || !el.to.id) continue
    // UML/ER relations (inheritance, crow's feet) aren't request flows
    if (!ARCH_HEADS.has(el.head) || !ARCH_HEADS.has(el.tail)) continue
    const [from, to] = direction(el)
    if (!nodes.has(from) || !nodes.has(to) || from === to) continue
    edges.push({ id, from, to, async: el.dash === 'dashed', carries: el.carries ?? null, el })
  }
  const out = new Map([...nodes.keys()].map((k) => [k, []]))
  const inn = new Map([...nodes.keys()].map((k) => [k, []]))
  for (const e of edges) {
    out.get(e.from).push(e)
    inn.get(e.to).push(e)
  }
  return { nodes, edges, out, inn }
}

export const isDurable = (n) => n?.role === 'store'

/**
 * Whether an edge can carry writes, by the same semantics capacity uses: everything unless it
 * declares `carries: "reads"` or `"lookups"` (one read per request handled, never a write).
 */
export const carriesWrites = (e) => e.carries !== 'reads' && e.carries !== 'lookups'

/**
 * Breadth-first search from `start` over edges accepted by `follow(edge)`,
 * never entering nodes rejected by `enter(node)` (except `start`). Returns a
 * Map<id, { prev, edge }> of visited nodes, so any target yields a shortest witness path.
 */
export function bfs(g, start, { follow = () => true, enter = () => true, skip = null } = {}) {
  const seen = new Map([[start, { prev: null, edge: null }]])
  const queue = [start]
  for (let i = 0; i < queue.length; i++) {
    const v = queue[i]
    for (const e of g.out.get(v) ?? []) {
      if (seen.has(e.to) || e.to === skip || !follow(e) || !enter(g.nodes.get(e.to))) continue
      seen.set(e.to, { prev: v, edge: e.id })
      queue.push(e.to)
    }
  }
  return seen
}

/** Witness path from a bfs() result: alternating node and edge ids, start → target. */
export function pathTo(seen, target) {
  if (!seen.has(target)) return null
  const out = []
  for (let v = target; v != null; v = seen.get(v).prev) {
    out.unshift(v)
    const e = seen.get(v).edge
    if (e) out.unshift(e)
  }
  return out
}

/** Strongly connected components (Tarjan, iterative) over edges accepted by `follow`. Only components with a cycle are returned. */
export function cycles(g, follow = () => true) {
  let index = 0
  const idx = new Map(), low = new Map(), onStack = new Set(), stack = [], out = []
  for (const root of g.nodes.keys()) {
    if (idx.has(root)) continue
    const work = [[root, 0]]
    idx.set(root, index); low.set(root, index); index++
    stack.push(root); onStack.add(root)
    while (work.length) {
      const frame = work[work.length - 1]
      const [v] = frame
      const edges = (g.out.get(v) ?? []).filter(follow)
      if (frame[1] < edges.length) {
        const w = edges[frame[1]++].to
        if (!idx.has(w)) {
          idx.set(w, index); low.set(w, index); index++
          stack.push(w); onStack.add(w)
          work.push([w, 0])
        } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)))
        continue
      }
      work.pop()
      if (work.length) low.set(work[work.length - 1][0], Math.min(low.get(work[work.length - 1][0]), low.get(v)))
      if (low.get(v) === idx.get(v)) {
        const comp = []
        let w
        do {
          w = stack.pop()
          onStack.delete(w)
          comp.push(w)
        } while (w !== v)
        if (comp.length > 1) out.push(comp.sort())
      }
    }
  }
  return out
}
