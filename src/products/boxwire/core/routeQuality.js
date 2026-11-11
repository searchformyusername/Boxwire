// Route quality, measured from the polylines alone, so two routers can be compared edge by edge:
// how many obstacles a route passes through, how much clearance it keeps from the others, and its cost
// under the router's own objective (length + 28 px per bend). Used by the routing gate
// (scripts/boxwire-route-gate.mjs) and its tests; not part of the app.

import { crossesRect, routeCost } from './route.js'

const LEVELS = [14, 6, 2, 0]
export { routeCost }

/**
 * { crossings, clearance, cost, bends } for one route. `others` are the obstacles that aren't the route's own
 * endpoints. clearance is the largest of 14 / 6 / 2 / 0 px such that no other obstacle grown by it (less
 * half a pixel) is crossed: the clearance levels the router tries, in order.
 */
export function routeQuality(pts, others, preferred = null, authored = null) {
  const crossings = others.filter((o) => crossesRect(pts, o)).length
  // an end whose side the source declares (fromSide / toSide) is a constraint: leaving or arriving through
  // another face breaks it, however short the route
  const [f0, f1] = facesOf(pts)
  const brokenPorts = authored ? Number(authored[0] != null && authored[0] !== f0) + Number(authored[1] != null && authored[1] !== f1) : 0
  const grow = (o, m) => ({ x: o.x - m + 0.5, y: o.y - m + 0.5, w: o.w + 2 * m - 1, h: o.h + 2 * m - 1 })
  const clearance = LEVELS.find((m) => m === 0 || !others.some((o) => crossesRect(pts, grow(o, m))))
  const [from, to] = facesOf(pts)
  // the faces the router prefers for this pair (pickSides, or the sides the edge declares); null ends don't count
  const faces = preferred ? (preferred[0] == null || preferred[0] === from) && (preferred[1] == null || preferred[1] === to) : true
  return { brokenPorts, crossings, clearance, faces, ...routeCost(pts) }
}

/**
 * -1 when a is better, 1 when worse, 0 when equal. First, constraints the author declared: a route that
 * leaves or enters through a face other than a declared fromSide / toSide (brokenPorts) is worse than any
 * other. Then only what a reader sees counts, ranked by how much it hurts: a route through a box (crossings), then one that grazes boxes (clearance), then its visual weight,
 * length plus 28 px per bend (the trade the router itself makes between a bend and a detour). Which auto-picked
 * faces a route uses (sides nobody declared) is the router's own soft preference, not something a reader can
 * judge, so it is reported (`faces`) but never decides: counting it would score the router by its own
 * preferences, and a change in it is never presented as an improvement.
 */
export function compareQuality(a, b) {
  if ((a.brokenPorts ?? 0) !== (b.brokenPorts ?? 0)) return (a.brokenPorts ?? 0) < (b.brokenPorts ?? 0) ? -1 : 1
  if (a.crossings !== b.crossings) return a.crossings < b.crossings ? -1 : 1
  if (a.clearance !== b.clearance) return a.clearance > b.clearance ? -1 : 1
  if (Math.abs(a.cost - b.cost) > 1e-6) return a.cost < b.cost ? -1 : 1
  return 0
}

/** The face a route leaves from (first segment) or arrives at (last segment, read backwards). */
const faceOf = (a, b) => (a.x === b.x ? (b.y < a.y ? 'n' : 's') : b.x > a.x ? 'e' : 'w')
export const facesOf = (pts) => [faceOf(pts[0], pts[1]), faceOf(pts.at(-1), pts.at(-2))]
