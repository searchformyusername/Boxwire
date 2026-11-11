// Plain-object geometry. Rects are { x, y, w, h }; points are { x, y }.

export const SIDES = ['n', 'e', 's', 'w']
export const NORMAL = { n: { x: 0, y: -1 }, e: { x: 1, y: 0 }, s: { x: 0, y: 1 }, w: { x: -1, y: 0 } }
export const OPPOSITE = { n: 's', s: 'n', e: 'w', w: 'e' }

export const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })
export const inflate = (r, d) => ({ x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d })
export const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
export const containsPt = (r, p) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
export const containsRect = (outer, r) =>
  r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h

export function union(rects) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const r of rects) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y)
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h)
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function rectFromPoints(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
}

export function boundsOfPoints(pts) {
  return union(pts.map((p) => ({ x: p.x, y: p.y, w: 0, h: 0 })))
}

/** Point on a rect side; t in [0,1] runs left→right (n/s) or top→bottom (e/w). */
export function sidePoint(r, side, t = 0.5) {
  switch (side) {
    case 'n': return { x: r.x + r.w * t, y: r.y }
    case 's': return { x: r.x + r.w * t, y: r.y + r.h }
    case 'e': return { x: r.x + r.w, y: r.y + r.h * t }
    default: return { x: r.x, y: r.y + r.h * t }
  }
}

/** Squared distance from p to segment ab. */
export function distToSegmentSq(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0
  const x = a.x + t * dx - p.x, y = a.y + t * dy - p.y
  return x * x + y * y
}

export function distToPolyline(p, pts) {
  let best = Infinity
  for (let i = 1; i < pts.length; i++) best = Math.min(best, distToSegmentSq(p, pts[i - 1], pts[i]))
  return Math.sqrt(best)
}

export function polylineLength(pts) {
  let len = 0
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return len
}

/** Point at fraction f of a polyline's length, plus the segment direction there. */
export function pointAlong(pts, f) {
  const total = polylineLength(pts)
  let left = total * Math.max(0, Math.min(1, f))
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const seg = Math.hypot(b.x - a.x, b.y - a.y)
    if (left <= seg || i === pts.length - 1) {
      const t = seg ? Math.min(1, left / seg) : 0
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x) }
    }
    left -= seg
  }
  return { ...pts[0], angle: 0 }
}

/** The prefix of a polyline covering fraction f of its length (for draw-on animation). */
export function truncatePolyline(pts, f) {
  if (f >= 1) return pts
  const total = polylineLength(pts)
  let left = total * Math.max(0, f)
  const out = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const seg = Math.hypot(b.x - a.x, b.y - a.y)
    if (left <= seg) {
      const t = seg ? left / seg : 0
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
      return out
    }
    out.push(b)
    left -= seg
  }
  return out
}

/** Drop points that sit on a straight line between their neighbours. */
export function simplifyCollinear(pts) {
  const out = []
  for (const p of pts) {
    const n = out.length
    if (n && Math.abs(out[n - 1].x - p.x) < 0.01 && Math.abs(out[n - 1].y - p.y) < 0.01) continue
    if (n >= 2) {
      const a = out[n - 2], b = out[n - 1]
      if ((Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - p.x) < 0.01) || (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - p.y) < 0.01)) {
        out[n - 1] = p
        continue
      }
    }
    out.push(p)
  }
  return out
}

/** Ramer–Douglas–Peucker simplification for freehand strokes. */
export function simplifyRDP(pts, eps) {
  if (pts.length < 3) return pts
  const keep = new Uint8Array(pts.length)
  keep[0] = keep[pts.length - 1] = 1
  const stack = [[0, pts.length - 1]]
  const epsSq = eps * eps
  while (stack.length) {
    const [i, j] = stack.pop()
    let best = -1, bestD = epsSq
    for (let k = i + 1; k < j; k++) {
      const d = distToSegmentSq(pts[k], pts[i], pts[j])
      if (d > bestD) { bestD = d; best = k }
    }
    if (best >= 0) {
      keep[best] = 1
      stack.push([i, best], [best, j])
    }
  }
  return pts.filter((_, i) => keep[i])
}

/**
 * Where the ray from `from` toward `to` first leaves polygon `poly`
 * (used to clip straight edges to the real shape outline).
 */
export function rayExit(poly, from, to) {
  const dx = to.x - from.x, dy = to.y - from.y
  let best = null
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const ex = b.x - a.x, ey = b.y - a.y
    const den = dx * ey - dy * ex
    if (Math.abs(den) < 1e-9) continue
    const t = ((a.x - from.x) * ey - (a.y - from.y) * ex) / den
    const u = ((a.x - from.x) * dy - (a.y - from.y) * dx) / den
    if (t >= 0 && u >= 0 && u <= 1 && (best === null || t < best)) best = t
  }
  return best === null ? from : { x: from.x + dx * best, y: from.y + dy * best }
}

export const rectPolygon = (r) => [
  { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
]

export function ellipsePolygon(r, n = 40) {
  const c = center(r)
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2
    return { x: c.x + (Math.cos(a) * r.w) / 2, y: c.y + (Math.sin(a) * r.h) / 2 }
  })
}

export const diamondPolygon = (r) => [
  { x: r.x + r.w / 2, y: r.y }, { x: r.x + r.w, y: r.y + r.h / 2 },
  { x: r.x + r.w / 2, y: r.y + r.h }, { x: r.x, y: r.y + r.h / 2 },
]

export function hexagonPolygon(r) {
  const k = Math.min(r.w * 0.25, r.h * 0.5)
  return [
    { x: r.x + k, y: r.y }, { x: r.x + r.w - k, y: r.y }, { x: r.x + r.w, y: r.y + r.h / 2 },
    { x: r.x + r.w - k, y: r.y + r.h }, { x: r.x + k, y: r.y + r.h }, { x: r.x, y: r.y + r.h / 2 },
  ]
}
