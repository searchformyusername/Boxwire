// The router rewrite (spatial index, sparse search state, bitset blocking, incremental invalidation,
// bend-aware search for large grids) against the frozen router it replaced. The full-scale gate with
// timings is scripts/boxwire-route-gate.mjs; these are its fast, always-on parts.

import { describe, expect, it } from 'vitest'
import { createRouter, obstacleIndex, routingObstacles } from './edges.js'
import * as v1 from './fixtures/router-v1/edges.js'
import { pickSides, routeOrtho } from './route.js'
import { compareQuality, routeQuality } from './routeQuality.js'
import { denseRandom, referenceDocs, tiledReferences } from './fixtures/boards.js'
import { intersects } from './geometry.js'

const obstaclesOf = (doc) => routingObstacles(Object.values(doc).filter((e) => e.type === 'node'))
const sorted = (m) => JSON.stringify([...m].sort(([a], [b]) => (a < b ? -1 : 1)))
const nodeIds = (doc) => Object.values(doc).filter((e) => e.type === 'node' && e.shape !== 'zone' && e.shape !== 'frame').map((e) => e.id)

describe('router v2 against router v1', () => {
  it('routes every reference design byte for byte as before, and after dragging each node', () => {
    for (const { name, doc: d0 } of referenceDocs()) {
      const router = createRouter()
      let doc = d0
      expect(sorted(router(doc, obstaclesOf(doc))), name).toBe(sorted(v1.createRouter()(doc, obstaclesOf(doc))))
      for (const id of nodeIds(d0)) {
        doc = { ...doc, [id]: { ...doc[id], x: doc[id].x + 30, y: doc[id].y - 12 } }
        expect(sorted(router(doc, obstaclesOf(doc))), `${name}: ${id}`).toBe(sorted(v1.createRouter()(doc, obstaclesOf(doc))))
      }
    }
  })

  it('the incremental router equals a fresh one after every drag frame (tiled references)', () => {
    let doc = tiledReferences(400)
    const router = createRouter()
    router(doc, obstaclesOf(doc))
    const ids = nodeIds(doc)
    for (let i = 0; i < 30; i++) {
      const id = ids[(i * 37) % ids.length]
      doc = { ...doc, [id]: { ...doc[id], x: doc[id].x + (i % 2 ? -40 : 25) } }
      if (i % 7 === 3) delete doc[ids[(i * 11) % ids.length]] // removals too (their edges route to nothing)
      expect(sorted(router(doc, obstaclesOf(doc)))).toBe(sorted(createRouter()(doc, obstaclesOf(doc))))
    }
  })

  it('on a dense board no connector is worse than before by the stated metric', () => {
    const doc = denseRandom(400)
    const obs = obstaclesOf(doc)
    const a = createRouter()(doc, obs), b = v1.createRouter()(doc, obs)
    let changed = 0
    for (const [id, old] of b) {
      const now = a.get(id)
      if (JSON.stringify(now) === JSON.stringify(old)) continue
      changed++
      const e = doc[id], [sa, sb] = pickSides(doc[e.from.id], doc[e.to.id])
      const others = obs.filter((o) => o.id !== e.from.id && o.id !== e.to.id)
      expect(compareQuality(routeQuality(now, others, [sa, sb]), routeQuality(old, others, [sa, sb])), id).toBeLessThanOrEqual(0)
    }
    expect(changed).toBeLessThan(b.size / 10)
  })

  it('the obstacle index returns exactly what a scan returns, in the same order', () => {
    const obs = obstaclesOf(tiledReferences(300))
    const index = obstacleIndex(obs)
    for (let i = 0; i < 200; i++) {
      const r = { x: (i * 397) % 20000 - 500, y: (i * 613) % 15000 - 500, w: 50 + (i * 71) % 3000, h: 50 + (i * 53) % 2000 }
      expect(index.query(r)).toEqual(obs.filter((o) => intersects(o, r)))
    }
  })

  it('a long route through a dense field: the bend-aware search finds a clean route at full clearance, never worse than the classic one', () => {
    // a wall of boxes with one wide gap at the bottom, and clutter on the near side
    const wall = Array.from({ length: 150 }, (_, i) => ({ x: 400, y: i * 50, w: 30, h: 44 }))
    const scatter = Array.from({ length: 200 }, (_, i) => ({ x: 40 + (i % 10) * 34, y: (i * 37) % 7400, w: 20, h: 20 }))
    const obs = [...wall, ...scatter]
    const src = { x: 0, y: 3000, side: 'e' }, dst = { x: 900, y: 3000, side: 'w' }
    const classic = routeOrtho(src, dst, obs, { fast: false })
    const now = routeOrtho(src, dst, obs)
    expect(now).not.toBe(null)
    const q = routeQuality(now, obs, ['e', 'w'])
    expect(q.crossings).toBe(0)
    expect(q.clearance).toBe(14)
    if (classic) expect(compareQuality(q, routeQuality(classic, obs, ['e', 'w']))).toBeLessThanOrEqual(0)
  })
})
