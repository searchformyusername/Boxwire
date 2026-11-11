// Turns edge elements into concrete polylines.
//
// Each frame: resolve endpoints from live node rects, pick faces, spread
// several edges sharing a face so they don't overlap, then route. Routes are
// memoised per edge by a key covering everything the result depends on —
// both ports and every obstacle in the search region — so any change that
// could alter a path (including an unrelated node sliding across it)
// invalidates exactly the affected edges.

import { OPPOSITE, SIDES, boundsOfPoints, center, inflate, intersects, rayExit, sidePoint, union } from './geometry.js'
import { isNode, outlineOf, shapeOf } from './elements.js'
import { MARGIN, costLowerBound, crossesRect, elbow, pickSides, routeCost, routeOrtho } from './route.js'

const REGION = 140 // how far around the endpoints obstacles are considered

const endRect = (end, doc) => {
  if (end.id) {
    const n = doc[end.id]
    return isNode(n) ? n : null
  }
  return Number.isFinite(end.x) ? { x: end.x, y: end.y, w: 0, h: 0 } : null
}

const rectKey = (r) => `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`

function cubic(a, b, n = 24) {
  const d = Math.max(40, Math.hypot(b.x - a.x, b.y - a.y) / 2.5)
  const c1 = { x: a.x + a.nx * d, y: a.y + a.ny * d }, c2 = { x: b.x + b.nx * d, y: b.y + b.ny * d }
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, u = 1 - t
    return {
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    }
  })
}

const NORM = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] }

/**
 * Obstacles in a uniform bucket grid, so "which obstacles touch this rectangle" costs what it returns
 * rather than a scan of the board. Results come back in the obstacles' own order, exactly as
 * obstacles.filter(o => intersects(o, r)) would give them.
 */
export function obstacleIndex(obstacles, cell = 256) {
  if (obstacles.length < 32) return { query: (r) => obstacles.filter((o) => intersects(o, r)) }
  const buckets = new Map()
  const key = (cx, cy) => cx * 131072 + cy
  const span = (r) => [Math.floor(r.x / cell), Math.floor((r.x + r.w) / cell), Math.floor(r.y / cell), Math.floor((r.y + r.h) / cell)]
  obstacles.forEach((o, i) => {
    const [x0, x1, y0, y1] = span(o)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = key(cx, cy), list = buckets.get(k)
        if (list) list.push(i)
        else buckets.set(k, [i])
      }
    }
  })
  return {
    query(r) {
      const [x0, x1, y0, y1] = span(r)
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > buckets.size) return obstacles.filter((o) => intersects(o, r))
      const seen = new Set()
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) for (const i of buckets.get(key(cx, cy)) ?? []) seen.add(i)
      return [...seen].sort((a, b) => a - b).map((i) => obstacles[i]).filter((o) => intersects(o, r))
    },
  }
}

/**
 * The connector router. Each call returns the routes for a document; between calls it keeps every route
 * whose result can't have changed: the same ports, and no obstacle that changed (moved, resized, added or
 * removed) touches the area the route depended on. That is the same test as comparing the obstacles in
 * that area, done by diffing the obstacles once per call instead of per route, so dragging one node
 * re-routes only the connectors near it.
 */
export function createRouter() {
  const cache = new Map() // edge id -> { ports, pts, area? }
  let previous = new Map() // obstacle id -> rect, as of the last call
  let last = new Map() // edge id -> { ports, pts } as last returned, for provisional routes

  /**
   * Returns Map<edgeId, pts[]> for every edge whose endpoints resolve. With `deadline` (a performance.now()
   * time), routing stops there: connectors whose ends moved go first, and any left are given a provisional
   * route (their last one if their ends didn't move, else a plain elbow) and listed in the map's `pending`
   * set. They are not cached, so the next call (or adopt()) completes them. Without a deadline every route
   * is exact.
   */
  function computeRoutes(doc, obstacles, { deadline = null } = {}) {
    invalidate(obstacles)
    const index = obstacleIndex(obstacles)
    // Map insertion order changes on undo; equal-position ports must stay stable in replay.
    const edges = Object.values(doc).filter((e) => e.type === 'edge')
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const resolved = []
    const faces = new Map() // "nodeId:side" -> ends sharing that face

    for (const e of edges) {
      const ra = endRect(e.from, doc), rb = endRect(e.to, doc)
      if (!ra || !rb) continue
      const [sa, sb] = pickSides(ra, rb)
      const ends = [
        { end: e.from, rect: ra, side: e.from.id ? e.from.side ?? sa : null, other: rb },
        { end: e.to, rect: rb, side: e.to.id ? e.to.side ?? sb : null, other: ra },
      ]
      for (const x of ends) {
        x.t = x.end.t ?? 0.5
        if (e.route !== 'straight' && x.end.id && x.end.t == null && shapeOf(x.rect).spread) {
          const k = `${x.end.id}:${x.side}`
          if (!faces.has(k)) faces.set(k, [])
          faces.get(k).push(x)
        }
      }
      resolved.push({ e, ends })
    }

    for (const group of faces.values()) {
      if (group.length < 2) continue
      const horizontalFace = group[0].side === 'n' || group[0].side === 's'
      group.sort((a, b) => (horizontalFace ? center(a.other).x - center(b.other).x : center(a.other).y - center(b.other).y))
      group.forEach((x, i) => {
        x.t = (i + 1) / (group.length + 1)
        x.shared = true
      })
    }

    // Facing faces whose spans overlap share one coordinate, so nearly aligned boxes get a straight wire.
    for (const { e, ends: [a, b] } of resolved) {
      if (e.route === 'straight' || !a.end.id || !b.end.id || a.side !== OPPOSITE[b.side]) continue
      if (a.end.t != null || b.end.t != null || a.shared || b.shared || !shapeOf(a.rect).spread || !shapeOf(b.rect).spread) continue
      const [p, s] = a.side === 'e' || a.side === 'w' ? ['y', 'h'] : ['x', 'w']
      const lo = Math.max(a.rect[p], b.rect[p]) + 8, hi = Math.min(a.rect[p] + a.rect[s], b.rect[p] + b.rect[s]) - 8
      if (hi < lo) continue
      const ca = a.rect[p] + a.rect[s] / 2, cb = b.rect[p] + b.rect[s] / 2
      const v = ca >= lo && ca <= hi ? ca : cb >= lo && cb <= hi ? cb : (lo + hi) / 2
      a.t = (v - a.rect[p]) / a.rect[s]
      b.t = (v - b.rect[p]) / b.rect[s]
    }

    const out = new Map()
    const pending = new Set(), dirty = [], portsOf = new Map()
    for (const { e, ends } of resolved) {
      const [a, b] = ends
      if (e.route === 'straight') {
        out.set(e.id, [clip(a, b), clip(b, a)])
        continue
      }
      const pa = port(a), pb = port(b)
      const ports = `${e.route}|${pa.x},${pa.y},${pa.side}|${pb.x},${pb.y},${pb.side}`
      portsOf.set(e.id, ports)
      if (e.route === 'curve') {
        const hit = cache.get(e.id)
        const pts = hit?.ports === ports ? hit.pts : cubic(withNormal(pa), withNormal(pb))
        cache.set(e.id, { ports, pts })
        out.set(e.id, pts)
        continue
      }
      // A route depends on every obstacle touching the endpoint region plus wherever the path actually
      // went (`area`); invalidate() drops it as soon as any of those changes.
      const hit = cache.get(e.id)
      if (hit?.ports === ports && hit.area) {
        out.set(e.id, hit.pts)
        continue
      }
      out.set(e.id, null) // keeps the map in edge order; filled below
      dirty.push({ e, a, b, pa, pb, ports, moved: last.get(e.id)?.ports !== ports })
    }
    // connectors whose ends moved first: they are the ones a drag is looking at
    if (deadline != null) dirty.sort((x, y) => Number(y.moved) - Number(x.moved))
    let routed = 0
    for (const d of dirty) {
      // at least one route per call, so repeated calls always make progress however short the deadline
      if (deadline != null && routed > 0 && performance.now() > deadline) {
        const prev = last.get(d.e.id)
        out.set(d.e.id, !d.moved && prev ? prev.pts : elbow(d.pa, d.pb))
        pending.add(d.e.id)
        continue
      }
      const { e, a, b, pa, pb, ports } = d
      const region = { x: Math.min(pa.x, pb.x) - REGION, y: Math.min(pa.y, pb.y) - REGION, w: Math.abs(pa.x - pb.x) + 2 * REGION, h: Math.abs(pa.y - pb.y) + 2 * REGION }
      const pts = orthoPath(a, b, pa, pb, index, region)
      const area = union([region, inflate(boundsOfPoints(pts), MARGIN + 2)])
      cache.set(e.id, { ports, pts, area })
      out.set(e.id, pts)
      routed++
    }
    if (cache.size > out.size * 2 + 64) for (const id of cache.keys()) if (!out.has(id)) cache.delete(id)
    last = new Map([...out].map(([id, pts]) => [id, { ports: portsOf.get(id), pts }]))
    out.pending = pending
    return out
  }

  /** Cached routes for these edge ids, as plain data another router can adopt(). */
  computeRoutes.entries = (ids) => ids.flatMap((id) => (cache.get(id)?.area ? [[id, cache.get(id)]] : []))
  /**
   * Take routes computed elsewhere (a worker running this same router) for the document this router last
   * routed: they are exact for its current obstacles, so they are cached as if computed here.
   */
  computeRoutes.adopt = (entries) => {
    for (const [id, entry] of entries) cache.set(id, entry)
  }
  return computeRoutes

  /** Drop every cached orthogonal route that an obstacle changed since the last call could affect. */
  function invalidate(obstacles) {
    const now = new Map()
    const changed = []
    for (const o of obstacles) {
      const id = o.id ?? rectKey(o)
      const k = rectKey(o)
      now.set(id, { k, r: o })
      const before = previous.get(id)
      if (!before) changed.push(o)
      else if (before.k !== k) changed.push(o, before.r)
    }
    for (const [id, before] of previous) if (!now.has(id)) changed.push(before.r)
    previous = now
    if (!changed.length) return
    if (changed.length > 256) {
      for (const [id, entry] of cache) if (entry.area) cache.delete(id)
      return
    }
    for (const [id, entry] of cache) if (entry.area && changed.some((r) => intersects(r, entry.area))) cache.delete(id)
  }
}
const withNormal = (p) => ({ ...p, nx: p.side ? NORM[p.side][0] : 0, ny: p.side ? NORM[p.side][1] : 0 })

/**
 * Search with the obstacles near the endpoints, then check the whole path
 * against every obstacle; any it crosses join the search and it runs again.
 * If a face is blocked outright, other faces of auto-sided ends are tried.
 */
function orthoPath(a, b, pa, pb, index, region) {
  const faces = (x, p) => (x.end.id && !x.end.side ? [p, ...SIDES.filter((s) => s !== p.side).map((side) => ({ ...sidePoint(x.rect, side), side }))] : [p])
  const pairs = faces(a, pa).flatMap((p) => faces(b, pb).map((q) => [p, q]))
  const dist = ([p, q]) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y)
  const ordered = [pairs[0], ...pairs.slice(1).sort((u, v) => dist(u) - dist(v))].slice(0, 8)
  const attempt = ([p, q], cap = Infinity) => {
    const near = new Set(index.query(region))
    for (let round = 0; round < 4; round++) {
      const pts = routeOrtho(p, q, [...near], { cap })
      if (!pts) return null
      // an obstacle the path crosses overlaps the path's bounds, so only those are checked
      const missed = index.query(inflate(boundsOfPoints(pts), 1)).filter((o) => !near.has(o) && crossesRect(pts, o))
      if (!missed.length) return pts
      for (const o of missed) near.add(o)
    }
    return null
  }
  for (let k = 0; k < ordered.length; k++) {
    const pts = attempt(ordered[k])
    if (!pts) continue
    // A route the classic search found is taken as it always was (the first face pair that works). One found
    // by the bend-aware search (a large grid) competes with the other face pairs instead: widest clearance,
    // then lowest cost (length + 28 px a bend), earlier pair on ties. A pair whose straight-line distance
    // can't beat the best full-clearance cost is skipped.
    if (!pts.how?.bendAware) return pts
    let best = pts, bestCost = routeCost(pts).cost
    // the other pairs, most promising first, while one could still be cheaper than the best so far
    const rest = ordered.slice(k + 1).map((pair) => ({ pair, lb: costLowerBound(pair[0], pair[1]) })).sort((u, v) => u.lb - v.lb)
    for (const { pair, lb } of rest) {
      if (best.how.margin === MARGIN && lb >= bestCost) break
      // only a route cheaper than the best at full clearance can win: the search stops once it can't
      const other = attempt(pair, best.how.margin === MARGIN ? bestCost : Infinity)
      if (!other) continue
      const c = routeCost(other).cost, m = other.how?.margin ?? 0
      if (m > best.how.margin || (m === best.how.margin && c < bestCost)) [best, bestCost] = [other, c]
    }
    return best
  }
  return elbow(pa, pb)
}

function port(x) {
  if (!x.end.id) return { x: x.rect.x, y: x.rect.y, side: null }
  const p = sidePoint(x.rect, x.side, x.t)
  return { x: Math.round(p.x * 2) / 2, y: Math.round(p.y * 2) / 2, side: x.side }
}

function clip(a, b) {
  const ca = center(a.rect)
  return a.end.id ? rayExit(outlineOf(a.rect), ca, center(b.rect)) : ca
}

/** Nodes that connectors should route around. */
export const routingObstacles = (nodes) => nodes.filter((n) => shapeOf(n).obstacle !== false)
