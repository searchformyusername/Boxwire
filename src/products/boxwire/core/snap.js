// Figma-style alignment snapping. Built once per gesture from the stationary
// rects: sorted arrays of their left/centre/right x and top/middle/bottom y,
// so each pointermove is a few binary searches instead of a scan.

function lowerBound(arr, v) {
  let lo = 0, hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid].v < v) lo = mid + 1
    else hi = mid
  }
  return lo
}

function axis(rects, pos, size) {
  const out = []
  for (const r of rects) for (const f of [0, 0.5, 1]) out.push({ v: r[pos] + r[size] * f, r })
  return out.sort((a, b) => a.v - b.v)
}

/** Best offset bringing any of `values` within `tol` of an indexed line, or null. */
function nearest(lines, values, tol) {
  let best = null
  for (const v of values) {
    for (let i = lowerBound(lines, v - tol); i < lines.length && lines[i].v <= v + tol; i++) {
      const d = lines[i].v - v
      if (best === null || Math.abs(d) < Math.abs(best)) best = d
    }
  }
  return best
}

export function createSnapper(rects) {
  const xs = axis(rects, 'x', 'w')
  const ys = axis(rects, 'y', 'h')

  /** Guides (world-space segments) for every line the snapped box now touches. */
  function guidesFor(box) {
    const out = []
    const add = (lines, values, vertical) => {
      for (const v of values) {
        const hits = []
        for (let i = lowerBound(lines, v - 0.5); i < lines.length && lines[i].v <= v + 0.5; i++) hits.push(lines[i].r)
        if (!hits.length) continue
        const all = [box, ...hits]
        out.push(vertical
          ? { x1: v, x2: v, y1: Math.min(...all.map((r) => r.y)), y2: Math.max(...all.map((r) => r.y + r.h)) }
          : { y1: v, y2: v, x1: Math.min(...all.map((r) => r.x)), x2: Math.max(...all.map((r) => r.x + r.w)) })
      }
    }
    add(xs, [box.x, box.x + box.w / 2, box.x + box.w], true)
    add(ys, [box.y, box.y + box.h / 2, box.y + box.h], false)
    return out
  }

  return {
    /** Snap a moving box; returns the offset to apply and guides to draw. */
    move(box, tol) {
      const dx = nearest(xs, [box.x, box.x + box.w / 2, box.x + box.w], tol)
      const dy = nearest(ys, [box.y, box.y + box.h / 2, box.y + box.h], tol)
      if (dx === null && dy === null) return { dx: 0, dy: 0, guides: [] }
      const snapped = { ...box, x: box.x + (dx ?? 0), y: box.y + (dy ?? 0) }
      return { dx: dx ?? 0, dy: dy ?? 0, guides: guidesFor(snapped) }
    },
    /** Snap individual edge coordinates (used while resizing). */
    x: (v, tol) => nearest(xs, [v], tol) ?? 0,
    y: (v, tol) => nearest(ys, [v], tol) ?? 0,
    guidesFor,
  }
}
