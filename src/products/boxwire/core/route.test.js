import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { MinHeap, crossesRect, elbow, pickSides, routeOrtho } from './route.js'
import { createRouter } from './edges.js'
import { makeEdge, makeNode } from './elements.js'
import { createDocStore } from './history.js'
import { createReplay } from './replay.js'

const crossesInterior = (pts, r) => {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    for (let k = 1; k < 20; k++) {
      const x = a.x + ((b.x - a.x) * k) / 20, y = a.y + ((b.y - a.y) * k) / 20
      if (x > r.x + 1 && x < r.x + r.w - 1 && y > r.y + 1 && y < r.y + r.h - 1) return true
    }
  }
  return false
}
const isOrthogonal = (pts) => pts.every((p, i) => !i || Math.abs(p.x - pts[i - 1].x) < 0.01 || Math.abs(p.y - pts[i - 1].y) < 0.01)

describe('MinHeap', () => {
  it('pops in key order', () => {
    const h = new MinHeap()
    const keys = [5, 3, 9, 1, 1, 7, 2, 8, 0, 6]
    keys.forEach((k, i) => h.push(k, i))
    const out = []
    while (h.size) out.push(keys[h.pop()])
    expect(out).toEqual([...keys].sort((a, b) => a - b))
  })
})

describe('routeOrtho', () => {
  const A = { x: 0, y: 0, w: 100, h: 60 }
  const B = { x: 400, y: 0, w: 100, h: 60 }

  it('draws a straight wire between aligned nodes', () => {
    const pts = routeOrtho({ x: 100, y: 30, side: 'e' }, { x: 400, y: 30, side: 'w' }, [A, B])
    expect(pts).toEqual([{ x: 100, y: 30 }, { x: 400, y: 30 }])
  })

  it('goes around an obstacle in the way, staying orthogonal and ending on the ports', () => {
    const wall = { x: 200, y: -80, w: 60, h: 220 }
    const pts = routeOrtho({ x: 100, y: 30, side: 'e' }, { x: 400, y: 30, side: 'w' }, [A, B, wall])
    expect(pts[0]).toEqual({ x: 100, y: 30 })
    expect(pts.at(-1)).toEqual({ x: 400, y: 30 })
    expect(isOrthogonal(pts)).toBe(true)
    expect(crossesInterior(pts, wall)).toBe(false)
    expect(crossesInterior(pts, A)).toBe(false)
    expect(crossesInterior(pts, B)).toBe(false)
  })

  it('leaves and enters along the face normals', () => {
    const C = { x: 300, y: 300, w: 100, h: 60 }
    const pts = routeOrtho({ x: 50, y: 60, side: 's' }, { x: 300, y: 330, side: 'w' }, [A, C])
    expect(pts[1].x).toBe(50) // first segment goes straight down
    expect(pts[1].y).toBeGreaterThan(60)
    expect(pts.at(-2).y).toBe(330) // last segment arrives horizontally
    expect(pts.at(-2).x).toBeLessThan(300)
    expect(pts.length).toBeLessThanOrEqual(4) // a single bend
  })

  it('reports failure instead of crossing when fully boxed in, and the elbow fallback is deterministic', () => {
    const cage = [
      { x: -100, y: -100, w: 700, h: 40 }, { x: -100, y: 120, w: 700, h: 40 },
      { x: -100, y: -100, w: 40, h: 260 }, { x: 560, y: -100, w: 40, h: 260 },
      { x: 200, y: -100, w: 40, h: 260 },
    ]
    expect(routeOrtho({ x: 100, y: 30, side: 'e' }, { x: 400, y: 30, side: 'w' }, [A, B, ...cage])).toBeNull()
    const a = elbow({ x: 100, y: 30, side: 'e' }, { x: 400, y: 30, side: 'w' })
    expect(a).toEqual(elbow({ x: 100, y: 30, side: 'e' }, { x: 400, y: 30, side: 'w' }))
    expect(isOrthogonal(a)).toBe(true)
  })

  it('threads the gap when a box sits closer than the preferred clearance', () => {
    const C = { x: 170, y: 10, w: 60, h: 60 } // 10px from A's east face
    const pts = routeOrtho({ x: 100, y: 30, side: 'e' }, { x: 400, y: 30, side: 'w' }, [A, B, C])
    expect(pts).not.toBeNull()
    expect(crossesRect(pts, C)).toBe(false)
  })
})

describe('pickSides', () => {
  it('chooses facing sides by gap', () => {
    expect(pickSides({ x: 0, y: 0, w: 100, h: 50 }, { x: 300, y: 20, w: 100, h: 50 })).toEqual(['e', 'w'])
    expect(pickSides({ x: 0, y: 0, w: 100, h: 50 }, { x: 30, y: 300, w: 100, h: 50 })).toEqual(['s', 'n'])
    expect(pickSides({ x: 300, y: 0, w: 100, h: 50 }, { x: 0, y: 0, w: 100, h: 50 })).toEqual(['w', 'e'])
  })
})

describe('computeRoutes', () => {
  const scene = () => {
    const a = { ...makeNode('rect', 0, 0), id: 'a' }
    const b = { ...makeNode('rect', 500, 0), id: 'b' }
    const e = { ...makeEdge({ id: 'a' }, { id: 'b' }), id: 'e' }
    return { a, b, e }
  }
  const nodes = (doc) => Object.values(doc).filter((x) => x.type === 'node')

  it('keeps edges attached when a node is resized', () => {
    const route = createRouter()
    const doc = scene()
    const before = route(doc, nodes(doc)).get('e')
    expect(before[0]).toEqual({ x: 160, y: 36 })
    const grown = { ...doc, a: { ...doc.a, w: 260, h: 200 } }
    const after = route(grown, nodes(grown)).get('e')
    expect(after[0].x).toBe(260) // still on the (moved) east face
    expect(after[0].y).toBeGreaterThan(0)
    expect(after[0].y).toBeLessThan(200)
    expect(after.at(-1)).toEqual({ x: 500, y: after[0].y }) // and straight, since the faces overlap
  })

  it('re-routes when an unrelated node moves across an existing edge', () => {
    const route = createRouter()
    const doc = { ...scene(), c: { ...makeNode('rect', 1000, 400), id: 'c' } }
    expect(route(doc, nodes(doc)).get('e')).toHaveLength(2)
    const moved = { ...doc, c: { ...doc.c, x: 250, y: -10 } }
    const pts = route(moved, nodes(moved)).get('e')
    expect(pts.length).toBeGreaterThan(2)
    expect(crossesInterior(pts, moved.c)).toBe(false)
    // and moves back off it
    expect(route(doc, nodes(doc)).get('e')).toHaveLength(2)
  })

  // Regression cases for obstacles near endpoints and outside the initial search region.
  const rect = (id, x, y, w, h) => ({ id, type: 'node', shape: 'rect', x, y, w, h })
  const pair = (...extras) => {
    const doc = Object.fromEntries([rect('a', 0, 0, 160, 72), rect('b', 500, 0, 160, 72), ...extras].map((v) => [v.id, v]))
    doc.e = { id: 'e', type: 'edge', route: 'ortho', from: { id: 'a' }, to: { id: 'b' } }
    return doc
  }

  it('never ignores a box pressed close to the source face', () => {
    const doc = pair(rect('c', 170, 10, 60, 60))
    const pts = createRouter()(doc, nodes(doc)).get('e')
    expect(crossesRect(pts, doc.c)).toBe(false)
    expect(isOrthogonal(pts)).toBe(true)
  })

  it('checks the whole path, including obstacles outside the endpoint region', () => {
    const doc = pair(rect('c', 250, -300, 30, 1000), rect('d', 150, -335, 200, 40))
    const pts = createRouter()(doc, nodes(doc)).get('e')
    for (const id of ['a', 'b', 'c', 'd']) expect(crossesRect(pts, doc[id])).toBe(false)
  })

  it('invalidates a cached detour when a far-away box moves onto it', () => {
    const route = createRouter()
    const doc = pair(rect('c', 250, -300, 30, 1000))
    const first = route(doc, nodes(doc)).get('e')
    const top = Math.min(...first.map((p) => p.y))
    expect(top).toBeLessThan(-300)
    // a box outside the endpoint region slides onto the detour
    const moved = { ...doc, d: rect('d', 150, top - 20, 200, 40) }
    const pts = route(moved, nodes(moved)).get('e')
    expect(crossesRect(pts, moved.d)).toBe(false)
  })

  it('straightens wires between nearly aligned boxes', () => {
    const route = createRouter()
    const doc = scene()
    doc.b = { ...doc.b, y: 14, h: 90 }
    const pts = route(doc, nodes(doc)).get('e')
    expect(pts).toHaveLength(2)
    expect(pts[0].y).toBe(pts[1].y)
  })

  it('spreads several edges that share a face', () => {
    const route = createRouter()
    const doc = scene()
    doc.c = { ...makeNode('rect', 500, 300), id: 'c' }
    doc.f = { ...makeEdge({ id: 'a' }, { id: 'c', side: 'w' }), id: 'f' }
    doc.e = { ...doc.e, to: { id: 'b', side: 'w' } }
    doc.f = { ...doc.f, from: { id: 'a', side: 'e' } }
    const r = route(doc, nodes(doc))
    expect(r.get('e')[0].y).toBeLessThan(r.get('f')[0].y)
    expect(r.get('e')[0].x).toBe(160)
  })

  it('keeps live and replay ports identical after undo restores a parallel edge', () => {
    const { a, b, e } = scene()
    const f = { ...makeEdge({ id: 'a' }, { id: 'b' }, { text: 'response' }), id: 'f' }
    const store = createDocStore({ base: { a, b } })
    store.apply([['e', { ...e, text: 'request' }], ['f', f]], 'connect')
    const route = createRouter()
    route(store.doc, nodes(store.doc))
    store.set('e', null, 'delete')
    route(store.doc, nodes(store.doc))
    store.undo() // restores e after f in the map; replay restores their original order

    const liveRoutes = route(store.doc, nodes(store.doc))
    const replay = createReplay(store.history.base, store.history.done)
    expect(replay.finalDoc).toEqual(store.doc)
    const replayRoutes = createRouter()(replay.finalDoc, nodes(replay.finalDoc))
    for (const id of ['e', 'f']) expect(liveRoutes.get(id)).toEqual(replayRoutes.get(id))
  })

  it('routes a realistic 60-node / 80-edge scene fast enough for interactive drags', () => {
    const doc = {}
    for (let i = 0; i < 60; i++) doc['n' + i] = { ...makeNode('rect', (i % 10) * 240, Math.floor(i / 10) * 180), id: 'n' + i }
    for (let i = 0; i < 80; i++) {
      const a = (i * 7) % 60, b = (i * 13 + 5) % 60
      if (a !== b) doc['e' + i] = { ...makeEdge({ id: 'n' + a }, { id: 'n' + b }), id: 'e' + i }
    }
    const route = createRouter()
    const list = nodes(doc)
    let t = performance.now()
    const all = route(doc, list)
    const cold = performance.now() - t
    // drag frames: one node moves per frame (a different one each time, so no frame is a pure cache hit);
    // key construction for every edge still runs. Judged on this process's CPU time per frame, median of 9,
    // which a busy machine doesn't inflate the way it does wall time (vitest runs each file in its own process).
    const cpu = [], wall = []
    for (let i = 0; i < 9; i++) {
      const id = `n${(i * 11 + 12) % 60}`
      const moved = { ...doc, [id]: { ...doc[id], x: doc[id].x + 30 } }
      const list2 = nodes(moved)
      const c0 = process.cpuUsage()
      t = performance.now()
      route(moved, list2)
      wall.push(performance.now() - t)
      const c = process.cpuUsage(c0)
      cpu.push((c.user + c.system) / 1000)
    }
    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    console.log(`routing 80 edges: cold ${cold.toFixed(1)}ms; drag frame median ${median(wall).toFixed(1)}ms wall, ${median(cpu).toFixed(1)}ms CPU (max wall ${Math.max(...wall).toFixed(1)}ms)`)
    expect(all.size).toBeGreaterThan(70)
    // the interactive budget: well inside a 60 fps frame's worth of work on an idle core
    expect(median(cpu)).toBeLessThan(40)
  })
})
