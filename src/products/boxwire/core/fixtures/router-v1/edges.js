// FROZEN COPY of the router at ae348a5, kept only as the reference the routing gate compares against
// (core/router.gate.test.js, scripts/boxwire-route-gate.mjs). Never imported by the app.
// Turns edge elements into concrete polylines.
//
// Each frame: resolve endpoints from live node rects, pick faces, spread
// several edges sharing a face so they don't overlap, then route. Routes are
// memoised per edge by a key covering everything the result depends on —
// both ports and every obstacle in the search region — so any change that
// could alter a path (including an unrelated node sliding across it)
// invalidates exactly the affected edges.

import { OPPOSITE, SIDES, boundsOfPoints, center, inflate, intersects, rayExit, sidePoint, union } from '../../geometry.js'
import { isNode, outlineOf, shapeOf } from '../../elements.js'
import { MARGIN, crossesRect, elbow, pickSides, routeOrtho } from './route.js'

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

export function createRouter() {
  const cache = new Map() // edge id -> { key, pts }

  /** Returns Map<edgeId, pts[]> for every edge whose endpoints resolve. */
  return function computeRoutes(doc, obstacles) {
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
    for (const { e, ends } of resolved) {
      const [a, b] = ends
      if (e.route === 'straight') {
        out.set(e.id, [clip(a, b), clip(b, a)])
        continue
      }
      const pa = port(a), pb = port(b)
      const ports = `${e.route}|${pa.x},${pa.y},${pa.side}|${pb.x},${pb.y},${pb.side}`
      if (e.route === 'curve') {
        const hit = cache.get(e.id)
        const pts = hit?.ports === ports ? hit.pts : cubic(withNormal(pa), withNormal(pb))
        cache.set(e.id, { ports, pts })
        out.set(e.id, pts)
        continue
      }
      // The memo key lists every obstacle touching the area the path could depend on:
      // the endpoint region plus wherever the last path actually went.
      const hit = cache.get(e.id)
      if (hit?.ports === ports && hit.key === obstacleKey(obstacles, hit.area)) {
        out.set(e.id, hit.pts)
        continue
      }
      const region = { x: Math.min(pa.x, pb.x) - REGION, y: Math.min(pa.y, pb.y) - REGION, w: Math.abs(pa.x - pb.x) + 2 * REGION, h: Math.abs(pa.y - pb.y) + 2 * REGION }
      const pts = orthoPath(a, b, pa, pb, obstacles, region)
      const area = union([region, inflate(boundsOfPoints(pts), MARGIN + 2)])
      cache.set(e.id, { ports, pts, area, key: obstacleKey(obstacles, area) })
      out.set(e.id, pts)
    }
    if (cache.size > out.size * 2 + 64) for (const id of cache.keys()) if (!out.has(id)) cache.delete(id)
    return out
  }
}

const obstacleKey = (obstacles, area) => obstacles.filter((o) => intersects(o, area)).map(rectKey).join(';')
const withNormal = (p) => ({ ...p, nx: p.side ? NORM[p.side][0] : 0, ny: p.side ? NORM[p.side][1] : 0 })

/**
 * Search with the obstacles near the endpoints, then check the whole path
 * against every obstacle; any it crosses join the search and it runs again.
 * If a face is blocked outright, other faces of auto-sided ends are tried.
 */
function orthoPath(a, b, pa, pb, obstacles, region) {
  const faces = (x, p) => (x.end.id && !x.end.side ? [p, ...SIDES.filter((s) => s !== p.side).map((side) => ({ ...sidePoint(x.rect, side), side }))] : [p])
  const pairs = faces(a, pa).flatMap((p) => faces(b, pb).map((q) => [p, q]))
  const dist = ([p, q]) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y)
  const ordered = [pairs[0], ...pairs.slice(1).sort((u, v) => dist(u) - dist(v))].slice(0, 8)
  for (const [p, q] of ordered) {
    const near = new Set(obstacles.filter((o) => intersects(o, region)))
    for (let round = 0; round < 4; round++) {
      const pts = routeOrtho(p, q, [...near])
      if (!pts) break
      const missed = obstacles.filter((o) => !near.has(o) && crossesRect(pts, o))
      if (!missed.length) return pts
      for (const o of missed) near.add(o)
    }
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
