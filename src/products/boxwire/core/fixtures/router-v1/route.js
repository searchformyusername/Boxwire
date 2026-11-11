// FROZEN COPY of the router at ae348a5, kept only as the reference the routing gate compares against
// (core/router.gate.test.js, scripts/boxwire-route-gate.mjs). Never imported by the app.
// Orthogonal connector routing.
//
// A* over a sparse orthogonal visibility grid: candidate x/y lines come from
// padded obstacle borders and the two port stubs, so the graph is O(k²) for k
// nearby obstacles instead of a pixel grid. Search state is (grid point,
// heading) so bends can be priced; a bend costs as much as BEND px of wire.

import { simplifyCollinear } from '../../geometry.js'

export const MARGIN = 14 // preferred obstacle clearance
const MARGINS = [MARGIN, 6, 2] // tighter clearances, tried when boxes sit closer than the preferred one
const BEND = 28
const BUDGET = 12000 // max state expansions per search

const DX = [0, 1, 0, -1] // n e s w
const DY = [-1, 0, 1, 0]
const DIR = { n: 0, e: 1, s: 2, w: 3 }

export class MinHeap {
  constructor() {
    this.keys = []
    this.vals = []
  }
  get size() { return this.keys.length }
  push(key, val) {
    const { keys, vals } = this
    let i = keys.length
    keys.push(key); vals.push(val)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (keys[p] <= key) break
      keys[i] = keys[p]; vals[i] = vals[p]
      i = p
    }
    keys[i] = key; vals[i] = val
  }
  pop() {
    const { keys, vals } = this
    const top = vals[0]
    const key = keys.pop(), val = vals.pop()
    const n = keys.length
    if (n) {
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && keys[c + 1] < keys[c]) c++
        if (keys[c] >= key) break
        keys[i] = keys[c]; vals[i] = vals[c]
        i = c
      }
      keys[i] = key; vals[i] = val
    }
    return top
  }
}

const uniqSorted = (arr) => [...new Set(arr.map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b)
const stubOf = (p, len) => (p.side ? { x: p.x + DX[DIR[p.side]] * len, y: p.y + DY[DIR[p.side]] * len } : p)
const inside = (b, p) => p.x > b.x + 0.01 && p.x < b.x + b.w - 0.01 && p.y > b.y + 0.01 && p.y < b.y + b.h - 0.01

/**
 * Route between two ports. A port is { x, y, side } where side is the outward
 * normal of the node face ('n'|'e'|'s'|'w'), or null for a free point.
 * Obstacles are raw node rects (include the source/target nodes). Returns
 * null when no clear path exists, e.g. a face pressed against another box.
 */
export function routeOrtho(src, dst, obstacles, { budget = BUDGET } = {}) {
  for (const margin of MARGINS) {
    const stub = margin + 4 // the stub tip must clear its own node's padded box
    const s0 = stubOf(src, stub), t0 = stubOf(dst, stub)
    const boxes = obstacles
      .map((r) => ({ x: r.x - margin, y: r.y - margin, w: r.w + 2 * margin, h: r.h + 2 * margin }))
      // a free endpoint that a box has slid over can only be reached through that box
      .filter((b) => (src.side || !inside(b, src)) && (dst.side || !inside(b, dst)))
    if (boxes.some((b) => inside(b, s0) || inside(b, t0))) continue
    const xs = uniqSorted([s0.x, t0.x, (s0.x + t0.x) / 2, ...boxes.flatMap((b) => [b.x, b.x + b.w])])
    const ys = uniqSorted([s0.y, t0.y, (s0.y + t0.y) / 2, ...boxes.flatMap((b) => [b.y, b.y + b.h])])
    const path = search(xs, ys, boxes, s0, t0, src.side ? DIR[src.side] : -1, dst.side ? (DIR[dst.side] + 2) % 4 : -1, budget)
    if (path) return simplifyCollinear([{ x: src.x, y: src.y }, ...path, { x: dst.x, y: dst.y }])
  }
  return null
}

/** True when any segment of an orthogonal polyline passes through the interior of rect r. */
export function crossesRect(pts, r) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    if (Math.max(a.x, b.x) > r.x + 0.5 && Math.min(a.x, b.x) < r.x + r.w - 0.5 && Math.max(a.y, b.y) > r.y + 0.5 && Math.min(a.y, b.y) < r.y + r.h - 0.5) return true
  }
  return false
}

function search(xs, ys, boxes, s0, t0, startDir, arriveDir, budget) {
  const nx = xs.length, ny = ys.length, n = nx * ny
  const find = (arr, v) => arr.indexOf(Math.round(v * 100) / 100)
  const start = find(ys, s0.y) * nx + find(xs, s0.x)
  const goal = find(ys, t0.y) * nx + find(xs, t0.x)
  const blocked = new Uint8Array(n) // 0 unknown, 1 free, 2 blocked
  const isBlocked = (idx) => {
    if (!blocked[idx]) {
      const p = { x: xs[idx % nx], y: ys[(idx / nx) | 0] }
      blocked[idx] = idx !== start && idx !== goal && boxes.some((b) => inside(b, p)) ? 2 : 1
    }
    return blocked[idx] === 2
  }
  // Box borders are grid lines, so a unit grid edge crosses a box interior iff its midpoint is inside it.
  const edgeBlocked = (a, b) => {
    const p = { x: (xs[a % nx] + xs[b % nx]) / 2, y: (ys[(a / nx) | 0] + ys[(b / nx) | 0]) / 2 }
    return boxes.some((box) => inside(box, p))
  }

  const GOAL = n * 4
  const g = new Float64Array(GOAL + 1).fill(Infinity)
  const from = new Int32Array(GOAL + 1).fill(-1)
  const heap = new MinHeap()
  const gx = xs[goal % nx], gy = ys[(goal / nx) | 0]
  const h = (idx) => Math.abs(xs[idx % nx] - gx) + Math.abs(ys[(idx / nx) | 0] - gy)

  for (let d = 0; d < 4; d++) {
    if (startDir >= 0 && d !== startDir) continue
    g[start * 4 + d] = 0
    heap.push(h(start), start * 4 + d)
  }

  let expanded = 0
  while (heap.size) {
    const state = heap.pop()
    if (state === GOAL) break
    if (++expanded > budget) return null
    const idx = (state / 4) | 0, dir = state % 4
    const cost = g[state]
    if (idx === goal) {
      const turn = arriveDir < 0 || dir === arriveDir ? 0 : dir === (arriveDir + 2) % 4 ? 3 * BEND : BEND
      if (cost + turn < g[GOAL]) {
        g[GOAL] = cost + turn
        from[GOAL] = state
        heap.push(cost + turn, GOAL)
      }
      continue
    }
    const i = idx % nx, j = (idx / nx) | 0
    for (let d = 0; d < 4; d++) {
      if (d === (dir + 2) % 4) continue
      const ni = i + DX[d], nj = j + DY[d]
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue
      const next = nj * nx + ni
      if (isBlocked(next) || edgeBlocked(idx, next)) continue
      const step = Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]) + (d === dir ? 0 : BEND)
      const ns = next * 4 + d
      if (cost + step < g[ns]) {
        g[ns] = cost + step
        from[ns] = state
        heap.push(cost + step + h(next), ns)
      }
    }
  }
  if (from[GOAL] < 0) return null

  const out = []
  for (let s = from[GOAL]; s >= 0; s = from[s]) {
    const idx = (s / 4) | 0
    out.push({ x: xs[idx % nx], y: ys[(idx / nx) | 0] })
  }
  return out.reverse()
}

/** Deterministic Z-shaped route, used only when every clear route has failed. */
export function elbow(src, dst) {
  const s0 = stubOf(src, MARGIN + 4), t0 = stubOf(dst, MARGIN + 4)
  const horizontal = src.side ? src.side === 'e' || src.side === 'w' : Math.abs(t0.x - s0.x) >= Math.abs(t0.y - s0.y)
  const mid = horizontal
    ? [s0, { x: (s0.x + t0.x) / 2, y: s0.y }, { x: (s0.x + t0.x) / 2, y: t0.y }, t0]
    : [s0, { x: s0.x, y: (s0.y + t0.y) / 2 }, { x: t0.x, y: (s0.y + t0.y) / 2 }, t0]
  return simplifyCollinear([{ x: src.x, y: src.y }, ...mid, { x: dst.x, y: dst.y }])
}

/** Which faces two rects should connect through, judged by the gap between them. */
export function pickSides(a, b) {
  const gapX = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w))
  const gapY = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h))
  const dx = b.x + b.w / 2 - (a.x + a.w / 2)
  const dy = b.y + b.h / 2 - (a.y + a.h / 2)
  const horizontal = gapX > 0 || gapY > 0 ? gapX >= gapY : Math.abs(dx) >= Math.abs(dy)
  if (horizontal) return dx >= 0 ? ['e', 'w'] : ['w', 'e']
  return dy >= 0 ? ['s', 'n'] : ['n', 's']
}
