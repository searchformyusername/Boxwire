// Capacity results must not depend on how cycles happen to be cut: not on node id order, and not on
// nodes that carry no load. Cut choice is a numerical device; modelling assumptions (which caches
// front which stores) and verdicts come from the declared graph alone.

import { describe, expect, it } from 'vitest'
import { compileDiagram } from '../author/compile.js'
import { buildGraph } from './graph.js'
import { propagate } from './capacity.js'

const measure = (s, font) => s.length * Number(/(\d+)px/.exec(font)[1]) * 0.55

function run(nodes, edges) {
  const r = compileDiagram({ format: 'boxwire-diagram', version: 1, nodes, edges }, { measure })
  if (r.errors.length) throw new Error(JSON.stringify(r.errors))
  return propagate(buildGraph(r.doc))
}

describe('cut invariance', () => {
  it('acceptance: a zero-load client that moves the cut does not make an uncached store certain (P1)', () => {
    const rows = [false, true].map((idle) => {
      const nodes = [
        ...(idle ? [{ id: 'c0', kind: 'web-client', capacity: { readQps: 0, writeQps: 0, readKB: 1, writeKB: 1 } }] : []),
        { id: 'c1', kind: 'web-client', capacity: { readQps: 10, writeQps: 0, readKB: 1, writeKB: 1 } },
        { id: 'a', kind: 'service' },
        { id: 'cache', kind: 'cache', capacity: { hitRatio: 0.9 } },
        { id: 'db1', kind: 'sql-database' },
        { id: 'db2', kind: 'sql-database', capacity: { replicas: 1, shards: 1, qpsPerNode: 2 } },
      ]
      const edges = [
        { id: 'a-cache', from: 'a', to: 'cache' }, { id: 'a-db1', from: 'a', to: 'db1' }, { id: 'a-db2', from: 'a', to: 'db2' },
        { id: 'feedback', from: 'db1', to: 'a', kind: 'async', share: 0.1 }, { id: 'source', from: 'c1', to: 'a' },
        ...(idle ? [{ id: 'idle', from: 'c0', to: 'db1' }] : []),
      ]
      const r = run(nodes, edges)
      return { cut: [...r.cut], db2: r.nodes.get('db2').in.r, status: r.nodes.get('db2').rating.status }
    })
    expect(rows[0].cut).not.toEqual(rows[1].cut) // the search really cuts a different edge…
    for (const row of rows) {
      expect(row.status).toBe('unknown') // …and db2 stays uncertain: which store the cache fronts isn't declared
      expect(row.db2[0]).toBeCloseTo(10 / 0.99 * 0.1, 6) // all reads missed only on db2's own share: ≈ 1.0101
      expect(row.db2[1]).toBeCloseTo(10 / 0.9, 6) // ≈ 11.111
    }
  })

  // a small deterministic generator of valid graphs with certified loops (feedback shares ≤ 0.5)
  function rng(seed) {
    let x = seed >>> 0
    return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  }
  function graph(seed) {
    const rnd = rng(seed)
    const pick = (a) => a[Math.floor(rnd() * a.length)]
    const svc = ['s1', 's2', 's3'].slice(0, 2 + Math.floor(rnd() * 2))
    const data = ['k1', 'd1', 'd2'].slice(0, 1 + Math.floor(rnd() * 3))
    const nodes = [
      { id: 'c', kind: 'web-client', capacity: { readQps: 100 + Math.floor(rnd() * 900), writeQps: Math.floor(rnd() * 100) } },
      ...svc.map((id) => ({ id, kind: 'service', capacity: { replicas: 1 + Math.floor(rnd() * 3), qpsPerNode: 100 + Math.floor(rnd() * 900) } })),
      ...data.map((id) => (id[0] === 'k'
        ? { id, kind: 'cache', capacity: { hitRatio: Math.round(rnd() * 90) / 100, replicas: 1, shards: 1, qpsPerNode: 1000 } }
        : { id, kind: 'sql-database', capacity: { replicas: 1, shards: 1, qpsPerNode: 50 + Math.floor(rnd() * 400) } })),
    ]
    const edges = [{ from: 'c', to: svc[0] }]
    for (let i = 1; i < svc.length; i++) edges.push({ from: pick(svc.slice(0, i)), to: svc[i] })
    for (const d of data) edges.push({ from: rnd() < 0.6 ? svc[0] : pick(svc), to: d, ...(rnd() < 0.3 && { carries: 'reads' }) })
    // feedback: an async edge from a later node back to an earlier service, with a share below 1/2
    for (let n = 0; n < 1 + Math.floor(rnd() * 2); n++) edges.push({ from: pick([...svc.slice(1), ...data.filter((d) => d[0] === 'd')]), to: svc[0], kind: 'async', share: Math.round(rnd() * 50) / 100 })
    return { nodes, edges }
  }
  // the same graph with every id renamed so id order (and so the search order) is reversed
  const flip = (id) => (id === 'c' ? 'c' : `x${String.fromCharCode(219 - id.charCodeAt(0))}${id}`) // a↔z: reverses id order
  const idle = { id: 'a0', kind: 'mobile-app', capacity: { readQps: 0, writeQps: 0 } } // sorts first, so the search starts from it
  const variants = ({ nodes, edges }) => [
    { nodes, edges, name: (id) => id },
    // a zero-load client attached to each node in turn (each can move the cut)
    ...nodes.filter((n) => n.id !== 'c').map((n) => ({ nodes: [idle, ...nodes], edges: [{ from: 'a0', to: n.id }, ...edges], name: (id) => id })),
    { nodes: nodes.map((n) => ({ ...n, id: flip(n.id) })), edges: edges.map((e) => ({ ...e, from: flip(e.from), to: flip(e.to) })), name: flip },
  ]
  const close = (a, b) => (a === b) || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b)))

  // the same graphs with declared cache-aside: some reads to stores become carries "misses" (a separate
  // generator, so the accepted 60 graphs above stay exactly as they were)
  function withMisses(seed) {
    const g = graph(seed), rnd = rng(seed + 7919)
    return { nodes: g.nodes, edges: g.edges.map((e) => (e.to[0] === 'd' && e.kind !== 'async' && rnd() < 0.6 ? { ...e, carries: 'misses' } : e)) }
  }

  // and with cache edges that cover only part of the reads (share), for the coverage repair
  function withShares(seed) {
    const g = withMisses(seed), rnd = rng(seed + 104729)
    return { nodes: g.nodes, edges: g.edges.map((e) => (e.to[0] === 'k' ? { ...e, share: Math.round(rnd() * 100) / 100 } : e)) }
  }

  for (const [label, make] of [['', graph], [' with declared cache-aside', withMisses], [' with partial cache coverage', withShares]]) it(`property: loads and verdicts are invariant to the cut, id order and zero-load nodes (60 random graphs${label})`, () => {
    let cutsDiffered = 0, misses = 0
    for (let seed = 1; seed <= 60; seed++) {
      const g = make(seed)
      misses += g.edges.filter((e) => e.carries === 'misses').length
      const runs = variants(g).map((v) => ({ v, r: run(v.nodes, v.edges) }))
      const ref = runs[0]
      for (const { v, r } of runs.slice(1)) {
        if (JSON.stringify([...r.cut].sort()) !== JSON.stringify([...ref.r.cut].sort())) cutsDiffered++
        for (const n of g.nodes) {
          const a = ref.r.nodes.get(n.id), b = r.nodes.get(v.name(n.id))
          for (const k of ['r', 'w']) for (const j of [0, 1]) expect(close(a.in[k][j], b.in[k][j]), `seed ${seed} ${n.id} ${k}[${j}]: ${a.in[k][j]} vs ${b.in[k][j]}`).toBe(true)
          expect(b.rating?.status, `seed ${seed} ${n.id}`).toBe(a.rating?.status)
        }
      }
    }
    expect(cutsDiffered).toBeGreaterThan(0) // the property is exercised: some variants do cut differently
    if (make !== graph) expect(misses).toBeGreaterThan(20)
  })
})
