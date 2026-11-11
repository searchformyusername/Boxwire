// Orthogonal connector routing.
//
// A* over a sparse orthogonal visibility grid: candidate x/y lines come from
// padded obstacle borders and the two port stubs, so the graph is O(k²) for k
// nearby obstacles instead of a pixel grid. Search state is (grid point,
// heading) so bends can be priced; a bend costs as much as BEND px of wire.

import { simplifyCollinear } from './geometry.js'

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
export function routeOrtho(src, dst, obstacles, { budget = BUDGET, fast = true, cap = Infinity } = {}) {
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
    const startDir = src.side ? DIR[src.side] : -1, arriveDir = dst.side ? (DIR[dst.side] + 2) % 4 : -1
    // The classic search first, with its expansion budget: wherever it finds a path, that path is the
    // result, unchanged. It gives up on long routes through dense boards (the goal is reachable, the
    // budget isn't enough), and then a bend-aware search, optimal for the same cost, finishes the job
    // at this clearance instead of falling back to tighter clearances or other faces.
    // Small grids (every reference route: the largest is 1,900 states) are searched exactly as they always
    // were; a grid larger than the classic budget goes straight to the bend-aware search.
    const states = xs.length * ys.length * 4
    let found = !fast || states <= budget ? search(xs, ys, boxes, s0, t0, startDir, arriveDir, budget, false) : { path: null, budget: true }
    if (!found.path && found.budget && fast) found = { ...search(xs, ys, boxes, s0, t0, startDir, arriveDir, FAST_BUDGET, true, cap, Math.abs(s0.x - src.x) + Math.abs(s0.y - src.y) + Math.abs(t0.x - dst.x) + Math.abs(t0.y - dst.y)), bendAware: true }
    // a capped search that proved nothing beats the cap: tighter clearances would only rank lower
    if (found.capped) return null
    if (found.path) {
      const pts = simplifyCollinear([{ x: src.x, y: src.y }, ...found.path, { x: dst.x, y: dst.y }])
      // how it was found, for the caller choosing between faces (not part of the route)
      Object.defineProperty(pts, 'how', { value: { margin, bendAware: found.bendAware === true }, enumerable: false })
      return pts
    }
  }
  return null
}

/** Expansion budget of the bend-aware search, which needs far fewer expansions per route. */
const FAST_BUDGET = 200000

/**
 * Fewest turns from heading `dir` to cover the displacement signs (sx, sy) and arrive heading `arrive`
 * (-1: any). A lower bound on the turns any path needs, ignoring obstacles; segments may have zero length.
 * Table over dir (4) × arrive (5) × sx (3) × sy (3), built once by breadth-first search over headings.
 */
const TURNS = (() => {
  const t = new Uint8Array(4 * 5 * 9).fill(255)
  for (let dir = 0; dir < 4; dir++) {
    // states: (heading, covered mask of e/w/n/s) → fewest turns
    const best = new Map([[`${dir}:${1 << dir}`, 0]])
    const q = [[dir, 1 << dir, 0]]
    while (q.length) {
      const [h, mask, k] = q.shift()
      if (k >= 6) continue
      for (const nh of [(h + 1) % 4, (h + 3) % 4]) {
        const m = mask | (1 << nh), key = `${nh}:${m}`
        if (best.has(key)) continue
        best.set(key, k + 1)
        q.push([nh, m, k + 1])
      }
    }
    for (let arrive = -1; arrive < 4; arrive++) {
      for (let sx = -1; sx <= 1; sx++) {
        for (let sy = -1; sy <= 1; sy++) {
          // n=0 e=1 s=2 w=3: dx>0 needs e, dx<0 needs w, dy<0 needs n, dy>0 needs s
          const need = (sx > 0 ? 2 : 0) | (sx < 0 ? 8 : 0) | (sy < 0 ? 1 : 0) | (sy > 0 ? 4 : 0)
          let m = 255
          for (const [key, k] of best) {
            const [h, mask] = key.split(':').map(Number)
            if ((mask & need) === need && (arrive < 0 || h === arrive)) m = Math.min(m, k)
          }
          t[((dir * 5 + arrive + 1) * 3 + sx + 1) * 3 + sy + 1] = m
        }
      }
    }
  }
  return t
})()

/** True when any segment of an orthogonal polyline passes through the interior of rect r. */
export function crossesRect(pts, r) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    if (Math.max(a.x, b.x) > r.x + 0.5 && Math.min(a.x, b.x) < r.x + r.w - 0.5 && Math.max(a.y, b.y) > r.y + 0.5 && Math.min(a.y, b.y) < r.y + r.h - 0.5) return true
  }
  return false
}

/**
 * Which grid points and unit grid edges lie strictly inside some box, as bitsets over the boxes: a grid
 * point (i, j) is inside box b iff column xs[i] is inside b's x-range and row ys[j] inside its y-range, so
 * blocked(i, j) = (cols[i] & rows[j]) ≠ 0. A unit edge is tested at its midpoint, exactly as before: a
 * horizontal one uses the half-column between xs[i] and xs[i+1] and row j, a vertical one column i and the
 * half-row. Same predicate as boxes.some(inside), evaluated by a few word ANDs instead of a scan.
 */
function blockMasks(xs, ys, boxes) {
  const W = Math.max(1, Math.ceil(boxes.length / 32))
  const nx = xs.length, ny = ys.length
  const mids = (a) => a.slice(1).map((v, i) => (a[i] + v) / 2)
  const xm = mids(xs), ym = mids(ys)
  const cols = new Uint32Array(nx * W), rows = new Uint32Array(ny * W)
  const colMid = new Uint32Array(Math.max(1, nx - 1) * W), rowMid = new Uint32Array(Math.max(1, ny - 1) * W)
  // first index whose value is > lo (strictly), and first whose value is >= hi
  const above = (arr, v) => {
    let lo = 0, hi = arr.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (arr[m] > v) hi = m
      else lo = m + 1
    }
    return lo
  }
  const below = (arr, v) => {
    let lo = 0, hi = arr.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (arr[m] < v) lo = m + 1
      else hi = m
    }
    return lo
  }
  const mark = (bits, arr, from, to, bi) => {
    // indices k with arr[k] > from and arr[k] < to
    const word = bi >> 5, bit = 1 << (bi & 31)
    for (let k = above(arr, from), end = below(arr, to); k < end; k++) bits[k * W + word] |= bit
  }
  boxes.forEach((b, bi) => {
    const x0 = b.x + 0.01, x1 = b.x + b.w - 0.01, y0 = b.y + 0.01, y1 = b.y + b.h - 0.01
    mark(cols, xs, x0, x1, bi)
    mark(rows, ys, y0, y1, bi)
    mark(colMid, xm, x0, x1, bi)
    mark(rowMid, ym, y0, y1, bi)
  })
  const any = (a, ia, b, ib) => {
    for (let w = 0; w < W; w++) if (a[ia * W + w] & b[ib * W + w]) return true
    return false
  }
  return {
    point: (i, j) => any(cols, i, rows, j),
    hEdge: (i, j) => any(colMid, i, rows, j), // between (i, j) and (i + 1, j)
    vEdge: (i, j) => any(cols, i, rowMid, j), // between (i, j) and (i, j + 1)
  }
}

// Search state reused across searches: arrays sized to the largest grid seen so far and reset through the
// list of entries a search touched, so a search costs what it expands rather than the size of its grid.
const POOL_LIMIT = 1 << 21 // states; larger grids keep their state in maps
const pool = { cap: 0, g: null, from: null, blk: null }
function pooled(states) {
  if (pool.cap < states) {
    const cap = Math.max(states, pool.cap * 2, 4096)
    pool.cap = cap
    pool.g = new Float64Array(cap).fill(Infinity)
    pool.from = new Int32Array(cap).fill(-1)
    pool.blk = new Uint8Array(cap)
  }
  return pool
}

/**
 * A* over the grid. State (point, heading); a bend costs BEND. Returns { path } or { path: null, budget }
 * (budget: true when it stopped at the expansion budget rather than proving there is no path).
 * Classic mode (bendAware false) is the original search: heuristic = Manhattan distance. Bend-aware mode adds
 * BEND × the fewest turns still needed (admissible and consistent: a move can lower it by at most its cost) and
 * breaks ties toward deeper states, so long routes through dense boards need a fraction of the expansions.
 */
function search(xs, ys, boxes, s0, t0, startDir, arriveDir, budget, bendAware, cap = Infinity, stubCost = 0) {
  const nx = xs.length, ny = ys.length, n = nx * ny
  const find = (arr, v) => arr.indexOf(Math.round(v * 100) / 100)
  const start = find(ys, s0.y) * nx + find(xs, s0.x)
  const goal = find(ys, t0.y) * nx + find(xs, t0.x)
  const GOAL = n * 4
  const masks = blockMasks(xs, ys, boxes)
  const gx = xs[goal % nx], gy = ys[(goal / nx) | 0]

  // state storage: pooled typed arrays (touched entries reset afterwards), or maps for very large grids
  let G, F, BLK, touched = null, touchedB = null
  if (GOAL + 1 <= POOL_LIMIT) {
    const p = pooled(GOAL + 1)
    G = p.g; F = p.from; BLK = p.blk
    touched = []; touchedB = []
  }
  const gm = new Map(), fm = new Map(), bm = new Map()
  const gGet = touched ? (s) => G[s] : (s) => gm.get(s) ?? Infinity
  const gSet = touched ? (s, v) => { if (G[s] === Infinity) touched.push(s); G[s] = v } : (s, v) => gm.set(s, v)
  const fGet = touched ? (s) => F[s] : (s) => fm.get(s) ?? -1
  const fSet = touched ? (s, v) => { F[s] = v } : (s, v) => fm.set(s, v)
  // 0 unknown, 1 free, 2 blocked (a grid point inside a box; start and goal never are)
  const isBlocked = (idx, i, j) => {
    let b = touched ? BLK[idx] : bm.get(idx) ?? 0
    if (!b) {
      b = idx !== start && idx !== goal && masks.point(i, j) ? 2 : 1
      if (touched) { BLK[idx] = b; touchedB.push(idx) } else bm.set(idx, b)
    }
    return b === 2
  }
  try {
    const heap = new MinHeap()
    const h = (idx, d) => {
      const dx = gx - xs[idx % nx], dy = gy - ys[(idx / nx) | 0]
      const m = Math.abs(dx) + Math.abs(dy)
      return bendAware ? m + BEND * TURNS[((d * 5 + arriveDir + 1) * 3 + Math.sign(dx) + 1) * 3 + Math.sign(dy) + 1] : m
    }
    const key = (f, gv) => (bendAware ? f - gv * 1e-9 : f)

    for (let d = 0; d < 4; d++) {
      if (startDir >= 0 && d !== startDir) continue
      gSet(start * 4 + d, 0)
      heap.push(key(h(start, d), 0), start * 4 + d)
    }

    let expanded = 0
    while (heap.size) {
      // with a consistent heuristic no route can cost less than the smallest key left: past the cap, give up.
      // The cap counts the route's whole polyline (stubs included), so the comparison uses that same measure.
      if (cap < Infinity && heap.keys[0] + stubCost > cap) return { path: null, budget: false, capped: true }
      const state = heap.pop()
      if (state === GOAL) break
      if (++expanded > budget) return { path: null, budget: true }
      const idx = (state / 4) | 0, dir = state % 4
      const cost = gGet(state)
      if (idx === goal) {
        const turn = arriveDir < 0 || dir === arriveDir ? 0 : dir === (arriveDir + 2) % 4 ? 3 * BEND : BEND
        if (cost + turn < gGet(GOAL)) {
          gSet(GOAL, cost + turn)
          fSet(GOAL, state)
          heap.push(key(cost + turn, cost + turn), GOAL)
        }
        continue
      }
      const i = idx % nx, j = (idx / nx) | 0
      const back = (dir + 2) % 4
      for (let d = 0; d < 4; d++) {
        if (d === back) continue
        const ni = i + DX[d], nj = j + DY[d]
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue
        const next = nj * nx + ni
        if (isBlocked(next, ni, nj)) continue
        // a unit grid edge crosses a box interior iff its midpoint is inside it
        if (d % 2 === 0 ? masks.vEdge(i, Math.min(j, nj)) : masks.hEdge(Math.min(i, ni), j)) continue
        const step = Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]) + (d === dir ? 0 : BEND)
        const ns = next * 4 + d
        if (cost + step < gGet(ns)) {
          gSet(ns, cost + step)
          fSet(ns, state)
          heap.push(key(cost + step + h(next, d), cost + step), ns)
        }
      }
    }
    if (fGet(GOAL) < 0) return { path: null, budget: false }

    const out = []
    for (let s = fGet(GOAL); s >= 0; s = fGet(s)) {
      const idx = (s / 4) | 0
      out.push({ x: xs[idx % nx], y: ys[(idx / nx) | 0] })
    }
    return { path: out.reverse() }
  } finally {
    if (touched) {
      for (const s of touched) { G[s] = Infinity; F[s] = -1 }
      for (const i of touchedB) BLK[i] = 0
    }
  }
}

/**
 * A lower bound on the cost (length + BEND per bend) of any route between two ports: their Manhattan
 * distance, plus BEND for each turn the headings force (leaving along src's face normal, arriving against
 * dst's), ignoring obstacles.
 */
export function costLowerBound(src, dst) {
  const dx = dst.x - src.x, dy = dst.y - src.y
  const m = Math.abs(dx) + Math.abs(dy)
  if (!src.side) return m
  const d = DIR[src.side], arrive = dst.side ? (DIR[dst.side] + 2) % 4 : -1
  return m + BEND * TURNS[((d * 5 + arrive + 1) * 3 + Math.sign(dx) + 1) * 3 + Math.sign(dy) + 1]
}

/** A route's cost under the search's own objective: length plus BEND per bend. */
export function routeCost(pts) {
  let len = 0, bends = 0
  for (let i = 1; i < pts.length; i++) {
    len += Math.abs(pts[i].x - pts[i - 1].x) + Math.abs(pts[i].y - pts[i - 1].y)
    if (i >= 2 && (pts[i - 1].y === pts[i - 2].y) !== (pts[i].y === pts[i - 1].y)) bends++
  }
  return { len, bends, cost: len + BEND * bends }
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
