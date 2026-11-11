import { describe, expect, it } from 'vitest'
import { compileDiagram } from '../author/compile.js'
import { buildGraph } from './graph.js'
import { propagate, sourceLoad } from './capacity.js'
import { bandwidth, compact, range, size } from './units.js'

const measure = (s, font) => s.length * Number(/(\d+)px/.exec(font)[1]) * 0.55

function cap(nodes, edges = []) {
  const r = compileDiagram({
    format: 'boxwire-diagram', version: 1,
    nodes: nodes.map(([id, kind, capacity]) => ({ id, kind, ...(capacity && { capacity }) })),
    edges: edges.map(([from, to, extra]) => ({ from, to, ...extra })),
  }, { measure })
  if (r.errors.length) throw new Error(JSON.stringify(r.errors))
  const g = buildGraph(r.doc)
  return { g, ...propagate(g) }
}
const close = (a, b) => expect(Math.abs(a - b) / b).toBeLessThan(1e-9)

describe('source load', () => {
  it('URL shortener: 100M URLs a month at 100:1 reads (hand-computed fixture)', () => {
    const { load } = sourceLoad({ writesPerMonth: 100e6, readWrite: 100 })
    const w = 100e6 / (30 * 86400) // 38.580…/s
    expect(Math.abs(load.w[0] - w) / w).toBeLessThan(0.01)
    expect(Math.abs(load.r[0] - w * 100) / (w * 100)).toBeLessThan(0.01)
    expect(load.w[0]).toBeCloseTo(38.58, 2)
    expect(load.r[0]).toBeCloseTo(3858.02, 1)
  })
  it('DAU × per-user rates, with peak applied to rates but not to the averages', () => {
    const { load } = sourceLoad({ dau: 86400, writesPerUser: 2, readsPerUser: 10, peak: 3, writeKB: 2 })
    expect([load.w, load.r, load.wA, load.rA]).toEqual([[6, 6], [30, 30], [2, 2], [10, 10]])
    expect(load.wKB).toEqual([12, 12])
    expect(load.wAKB).toEqual([4, 4])
  })
  it('an undeclared side is unknown, not zero', () => {
    const { load } = sourceLoad({ writeQps: 5 })
    expect(load.r).toEqual([0, Infinity])
    expect(sourceLoad({})).toBeNull()
  })
})

describe('propagation', () => {
  it('a cache passes only misses (and every write) to what is behind it', () => {
    const { nodes } = cap([['c', 'web-client', { readQps: 1000, writeQps: 10 }], ['r', 'cache', { hitRatio: 0.9 }], ['db', 'sql-database']], [['c', 'r'], ['r', 'db']])
    close(nodes.get('db').in.r[0], 100)
    expect(nodes.get('db').in.w).toEqual([10, 10])
  })
  it('declared cache-aside (carries "misses"): the store sees exactly the misses; writes are untouched', () => {
    const { nodes } = cap(
      [['c', 'web-client', { readQps: 1000, writeQps: 10 }], ['api', 'service'], ['r', 'cache', { hitRatio: 0.8 }], ['db', 'sql-database']],
      [['c', 'api'], ['api', 'r', { carries: 'reads' }], ['api', 'db', { carries: 'misses' }]],
    )
    close(nodes.get('db').in.r[0], 200)
    close(nodes.get('db').in.r[1], 200)
    expect(nodes.get('db').in.w).toEqual([10, 10])
    expect(nodes.get('db').steps.find((s) => s.label === 'Cache-aside').formula).toMatch(/declared: carries "misses"/)
  })
  it('regression: one cache and one store, nothing declared, is not assumed to be cache-aside', () => {
    // the cache holds sessions; the store holds group members. The only store is not therefore behind the cache.
    const at = (carries) => cap(
      [['c', 'web-client', { readQps: 1000, writeQps: 0 }], ['api', 'service'], ['sessions', 'cache', { hitRatio: 0.99 }], ['members', 'sql-database', { replicas: 1, shards: 1, qpsPerNode: 500 }]],
      [['c', 'api'], ['api', 'sessions', { carries: 'reads' }], ['api', 'members', carries && { carries }]],
    ).nodes.get('members')
    for (const carries of [undefined, 'reads', 'lookups']) {
      const m = at(carries)
      close(m.in.r[0], 10) // if the cache did front it: misses only
      close(m.in.r[1], 1000) // if it doesn't: every read
      expect(m.rating.status, String(carries)).toBe('unknown') // 10–1000/s against 500/s: neither a pass nor proven
      expect(m.steps.find((s) => s.label === 'Cache-aside').formula).toMatch(/doesn't declare carries "misses"/)
    }
    // declared, it is exact
    expect(at('misses').rating.status).toBe('pass')
    close(at('misses').in.r[1], 10)
  })
  describe('cache coverage: a cache only serves the reads that reach it (reviewer P2, 0151cb6)', () => {
    // client 100 reads/s + 7 writes/s → api; api → cache (hit 0.9, share s); api → db carries "misses", rated 20/s
    const at = (share) => cap(
      [['client', 'web-client', { readQps: 100, writeQps: 7 }], ['api', 'service'], ['cache', 'cache', { hitRatio: 0.9 }], ['db', 'sql-database', { replicas: 1, shards: 1, qpsPerNode: 20 }]],
      [['client', 'api'], ...(share === null ? [] : [['api', 'cache', { carries: 'reads', share }]]), ['api', 'db', { carries: 'misses' }]],
    ).nodes
    it('share 0: the cache gets nothing and serves nothing, so the db takes every read and is overloaded', () => {
      const n = at(0)
      expect(n.get('cache').in.r).toEqual([0, 0])
      close(n.get('db').in.r[0], 100)
      close(n.get('db').in.r[1], 100)
      expect(n.get('db').in.w).toEqual([7, 7])
      expect(n.get('db').rating.status).toBe('violation')
      // the same as no cache edge at all
      expect(at(null).get('db').in.r).toEqual([100, 100])
    })
    it('share 0.5: half the reads skip the cache; the db takes 50 + 50 × 0.1 = 55', () => {
      const n = at(0.5)
      close(n.get('db').in.r[0], 55)
      close(n.get('db').in.r[1], 55)
      expect(n.get('db').rating.status).toBe('violation')
      expect(n.get('db').steps.find((x) => x.label === 'Cache-aside').formula).toMatch(/1 − share 0\.5 × 0\.9/)
    })
    it('share 1: every read goes through the cache; the db takes the 10 misses and passes', () => {
      const n = at(1)
      close(n.get('db').in.r[0], 10)
      close(n.get('db').in.r[1], 10)
      expect(n.get('db').rating.status).toBe('pass')
    })
    it('property: demand is conserved across the cache partitions (300 random cases, one and two caches)', () => {
      let x = 12345
      const rnd = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32)
      for (let i = 0; i < 300; i++) {
        const r = 1 + Math.floor(rnd() * 5000)
        const two = i % 2 === 1
        const c = [0, 1].slice(0, two ? 2 : 1).map((k) => ({ id: `k${k}`, h: Math.round(rnd() * 100) / 100, s: Math.round(rnd() * 100) / 100 }))
        const n = cap(
          [['client', 'web-client', { readQps: r, writeQps: 0 }], ['api', 'service'], ...c.map((k) => [k.id, 'cache', { hitRatio: k.h }]), ['db', 'sql-database']],
          [['client', 'api'], ...c.map((k) => ['api', k.id, { carries: 'reads', share: k.s }]), ['api', 'db', { carries: 'misses' }]],
        ).nodes
        const db = n.get('db').in.r
        // what each cache receives is exactly its share of the reads
        for (const k of c) close(n.get(k.id).in.r[0] + 1e-300, r * k.s + 1e-300)
        const served = c.map((k) => n.get(k.id).in.r[0] * k.h) // reads each cache answers
        if (!two) {
          // one cache: unserved + served = every read, exactly
          expect(Math.abs(db[0] + served[0] - r)).toBeLessThan(1e-9 * r)
          expect(db[1]).toBe(db[0])
        } else {
          // two caches: every split of the hits is inside the interval, and both ends are reachable splits
          expect(Math.abs(db[0] - Math.max(0, r - served[0] - served[1]))).toBeLessThan(1e-9 * r)
          expect(Math.abs(db[1] - (r - Math.max(...served)))).toBeLessThan(1e-9 * r)
          expect(db[1]).toBeLessThanOrEqual(r + 1e-9 * r)
          expect(db[0]).toBeGreaterThanOrEqual(0)
        }
      }
    })
  })
  it('a "misses" edge from a node that reads no cache carries every read, and says so', () => {
    const { nodes } = cap([['c', 'web-client', { readQps: 100, writeQps: 0 }], ['api', 'service'], ['db', 'sql-database']], [['c', 'api'], ['api', 'db', { carries: 'misses' }]])
    expect(nodes.get('db').in.r).toEqual([100, 100])
    expect(nodes.get('db').steps.find((s) => s.label === 'Cache-aside').formula).toMatch(/reads no cache/)
  })
  it('a "misses" edge to a second cache is a serial level, not a parallel one', () => {
    const { nodes } = cap(
      [['c', 'web-client', { readQps: 1000, writeQps: 0 }], ['api', 'service'], ['l1', 'cache', { hitRatio: 0.9 }], ['l2', 'cache', { hitRatio: 0.5 }], ['db', 'sql-database']],
      [['c', 'api'], ['api', 'l1', { carries: 'reads' }], ['api', 'l2', { carries: 'misses' }], ['l2', 'db']],
    )
    close(nodes.get('l2').in.r[0], 100)
    close(nodes.get('db').in.r[1], 50)
  })
  it('cache-aside with two stores: which one is fronted is undeclared, so the discount is an interval', () => {
    const { nodes } = cap(
      [['c', 'web-client', { readQps: 1000, writeQps: 0 }], ['api', 'service'], ['r', 'cache', { hitRatio: 0.8 }], ['a', 'sql-database'], ['b', 'search-index']],
      [['c', 'api'], ['api', 'r'], ['api', 'a'], ['api', 'b']],
    )
    expect(nodes.get('a').in.r[0]).toBeCloseTo(200)
    expect(nodes.get('a').in.r[1]).toBe(1000)
  })
  it('an undeclared hit ratio spans [0, 1] of the reads', () => {
    const { nodes } = cap([['c', 'web-client', { readQps: 1000, writeQps: 0 }], ['cdn', 'cdn'], ['o', 'service']], [['c', 'cdn'], ['cdn', 'o']])
    expect(nodes.get('o').in.r).toEqual([0, 1000])
  })
  it('fan-out multiplies what a node sends on', () => {
    const { nodes } = cap([['c', 'web-client', { writeQps: 100, readQps: 0 }], ['f', 'worker', { fanout: 200 }], ['db', 'nosql-store']], [['c', 'f'], ['f', 'db']])
    expect(nodes.get('db').in.w).toEqual([20000, 20000])
  })
  it('a queue delivers one message (write) per request; lookups read once per message', () => {
    const { nodes } = cap(
      [['c', 'web-client', { readQps: 50, writeQps: 100 }], ['q', 'message-queue'], ['w', 'worker'], ['g', 'sql-database'], ['db', 'nosql-store']],
      [['c', 'q'], ['q', 'w'], ['w', 'g', { carries: 'lookups' }], ['w', 'db', { carries: 'writes' }]],
    )
    expect(nodes.get('w').in).toMatchObject({ r: [0, 0], w: [150, 150] })
    expect(nodes.get('g').in).toMatchObject({ r: [150, 150], w: [0, 0] })
    expect(nodes.get('db').in).toMatchObject({ r: [0, 0], w: [150, 150] })
  })
  it('news-feed fan-out: the consumer reads followers once per post and writes once per follower', () => {
    // 3,472 posts/s at peak (200M DAU × 0.5 posts ÷ 86,400 × 3) through a stream to fan-out workers (× 200 followers)
    const { nodes } = cap(
      [['c', 'mobile-app', { dau: 200e6, writesPerUser: 0.5, readsPerUser: 0, peak: 3 }], ['post', 'service'], ['q', 'event-stream'], ['fan', 'worker', { fanout: 200 }], ['graph', 'nosql-store'], ['tl', 'cache']],
      [['c', 'post'], ['post', 'q', { kind: 'async' }], ['q', 'fan'], ['fan', 'graph', { carries: 'lookups' }], ['fan', 'tl', { carries: 'writes' }]],
    )
    const posts = (200e6 * 0.5 / 86400) * 3
    close(nodes.get('fan').in.w[0], posts)
    close(nodes.get('graph').in.r[0], posts) // one follower-list read per post, not × fan-out
    expect(nodes.get('graph').in.w).toEqual([0, 0])
    close(nodes.get('tl').in.w[0], posts * 200) // ≈ 694k timeline writes/s
    expect(nodes.get('tl').in.r).toEqual([0, 0])
  })
  it('share splits a node\'s output across edges', () => {
    const { nodes } = cap([['c', 'web-client', { readQps: 1000, writeQps: 0 }], ['a', 'service'], ['b', 'service']], [['c', 'a', { share: 0.25 }], ['c', 'b', { share: 0.75 }]])
    expect([nodes.get('a').in.r, nodes.get('b').in.r]).toEqual([[250, 250], [750, 750]])
  })
  it('sums incoming edges', () => {
    const { nodes } = cap([['c', 'web-client', { readQps: 10, writeQps: 1 }], ['m', 'mobile-app', { readQps: 30, writeQps: 2 }], ['api', 'service']], [['c', 'api'], ['m', 'api']])
    expect(nodes.get('api').in).toMatchObject({ r: [40, 40], w: [3, 3] })
  })
  it('a feedback loop with gain below 1 is solved to its steady state (audit #5: 10 + 0.9x = 100/s)', () => {
    const { nodes, cut, feedback } = cap(
      [['c', 'web-client', { writeQps: 10, readQps: 0 }], ['a', 'service', { replicas: 1, qpsPerNode: 50 }], ['b', 'worker', { replicas: 1, qpsPerNode: 50 }]],
      [['c', 'a'], ['a', 'b'], ['b', 'a', { kind: 'async', share: 0.9 }]],
    )
    expect([...cut]).toEqual(['e3'])
    expect(feedback.certified).toBe(true)
    expect(nodes.get('a').in.w[0]).toBeCloseTo(100, 6)
    expect(nodes.get('a').rating.status).toBe('violation') // 100/s against a 50/s rating, never a pass at 10/s
    expect(nodes.get('b').rating.status).toBe('violation')
  })
  it('a loop that never settles has no upper bound, so nothing in it can pass', () => {
    const { nodes, feedback } = cap(
      [['c', 'web-client', { readQps: 10, writeQps: 0 }], ['a', 'service', { replicas: 1, qpsPerNode: 1e9 }], ['b', 'service']],
      [['c', 'a'], ['a', 'b'], ['b', 'a']],
    )
    expect(feedback.certified).toBe(false)
    expect(nodes.get('a').in.r[1]).toBe(Infinity)
    expect(nodes.get('a').in.r[0]).toBeGreaterThanOrEqual(10)
    expect(nodes.get('a').rating.status).not.toBe('pass')
  })
  it('a zero-gain loop settles at once and changes nothing', () => {
    const { nodes, feedback } = cap([['c', 'web-client', { readQps: 10, writeQps: 0 }], ['a', 'service'], ['b', 'service']], [['c', 'a'], ['a', 'b'], ['b', 'a', { share: 0 }]])
    expect(feedback.certified).toBe(true)
    expect(nodes.get('b').in.r).toEqual([10, 10])
  })
  it('acceptance: a near-unit gain with a tiny source is not certified, so it never passes', () => {
    // steady state 1e-12 / 1e-11 ≈ 0.1/s against a 0.001/s rating: an absolute residual must not prove a bound
    const { nodes, feedback } = cap(
      [['c', 'web-client', { writeQps: 1e-12, readQps: 0, writeKB: 1 }], ['a', 'service', { replicas: 1, qpsPerNode: 0.001 }], ['b', 'worker']],
      [['c', 'a'], ['a', 'b'], ['b', 'a', { kind: 'async', share: 1 - 1e-11 }]],
    )
    expect(feedback.certified).toBe(false)
    expect(nodes.get('a').in.w[1]).toBe(Infinity)
    expect(nodes.get('a').rating.status).not.toBe('pass')
  })
  it('acceptance: a unit-gain loop through huge fan-outs stays unbounded, whatever the cut (an idle client must not change it)', () => {
    const chain = [['a', 'worker', { fanout: 1e6 }], ['x', 'worker', { fanout: 1e6 }], ['z', 'worker', { fanout: 1e6 }], ['b', 'worker', { fanout: 1e6, replicas: 1, qpsPerNode: 50 }]]
    const loop = [['a', 'x'], ['x', 'z'], ['z', 'b'], ['b', 'a', { kind: 'async', share: 1e-24 }], ['c1', 'b']]
    const verdicts = [false, true].map((idle) => {
      const { nodes, feedback, cut } = cap(
        [...(idle ? [['c0', 'web-client', { writeQps: 0, readQps: 0, writeKB: 1 }]] : []), ['c1', 'web-client', { writeQps: 10, readQps: 0, writeKB: 1 }], ...chain],
        [...loop, ...(idle ? [['c0', 'a']] : [])],
      )
      return { cut: [...cut], certified: feedback.certified, status: nodes.get('b').rating.status, hi: nodes.get('b').in.w[1] }
    })
    expect(verdicts[0].cut).not.toEqual(verdicts[1].cut) // the depth-first search does cut a different edge…
    for (const v of verdicts) {
      expect(v.certified).toBe(false) // …but neither cut certifies a loop of gain 1
      expect(v.hi).toBe(Infinity)
      expect(v.status).not.toBe('pass')
    }
  })
  it('acceptance: the certified bound is shown, and a slow but certified loop gives a sound range', () => {
    const { nodes, feedback } = cap(
      [['c', 'web-client', { writeQps: 10, readQps: 0 }], ['a', 'service', { replicas: 1, qpsPerNode: 1e9 }], ['b', 'worker']],
      [['c', 'a'], ['a', 'b'], ['b', 'a', { kind: 'async', share: 0.99 }]],
    )
    expect(feedback.certified).toBe(true)
    const [lo, hi] = nodes.get('a').in.w
    expect(lo).toBeLessThanOrEqual(1000 + 1e-6) // steady state 10 / (1 − 0.99) = 1000/s
    expect(hi).toBeGreaterThanOrEqual(1000 - 1e-6)
    expect(nodes.get('a').steps.find((st) => st.label === 'Feedback').formula).toMatch(/certifies it.*remaining tail ≤/)
  })
  it('parallel caches give the joint-miss range, not a product of marginals (audit #4)', () => {
    const { nodes } = cap(
      [['c', 'web-client', { readQps: 1000, writeQps: 0 }], ['api', 'service'], ['c1', 'cache', { hitRatio: 0.9 }], ['c2', 'cache', { hitRatio: 0.9 }], ['db', 'sql-database', { replicas: 1, shards: 1, qpsPerNode: 20 }]],
      [['c', 'api'], ['api', 'c1', { carries: 'reads' }], ['api', 'c2', { carries: 'reads' }], ['api', 'db', { carries: 'misses' }]],
    )
    const r = nodes.get('db').in.r
    expect(r[0]).toBe(0)
    expect(r[1]).toBeCloseTo(100, 9)
    expect(nodes.get('db').rating.status).toBe('unknown') // 0–100/s against 20/s: not a pass
  })
  it('an exact zero read rate has zero read payload, even with readKB undeclared (audit #7)', () => {
    const { nodes } = cap(
      [['c', 'web-client', { writeQps: 1, readQps: 0, writeKB: 1 }], ['q', 'message-queue'], ['db', 'nosql-store', { retentionYears: 1, replicationFactor: 1, storageTB: 1 }]],
      [['c', 'q'], ['q', 'db']],
    )
    expect(nodes.get('db').storage.need).toEqual([31536000, 31536000]) // 31.536 GB, known
    expect(nodes.get('db').storage.status).toBe('pass')
  })
  it('compares ratings without floating-point artefacts: just below, at, just above (audit #8)', () => {
    const at = (rps) => cap(
      [['c', 'web-client', { readQps: rps, writeQps: 0 }], ['r', 'cache', { hitRatio: 0.7 }], ['db', 'sql-database', { replicas: 1, shards: 1, qpsPerNode: 300 }]],
      [['c', 'r'], ['r', 'db']],
    ).nodes.get('db').rating.status
    expect(at(999.99)).toBe('pass')
    expect(at(1000)).toBe('pass') // 1000 × (1 − 0.7) = 300.00000000000006 in binary
    expect(at(1000.01)).toBe('violation')
  })
})

describe('ratings and storage', () => {
  it('stores: reads spread over replicas × shards, writes over shard leaders', () => {
    const { nodes } = cap([['c', 'web-client', { readQps: 12000, writeQps: 400 }], ['db', 'sql-database', { replicas: 3, shards: 4, qpsPerNode: 2000 }]], [['c', 'db']])
    const r = nodes.get('db').rating
    expect(r.per).toEqual([1100, 1100]) // 12000/12 + 400/4
    expect(r.status).toBe('pass')
  })
  it('storage accumulates at the average write rate, times the replication factor', () => {
    const { nodes } = cap([['c', 'web-client', { writeQps: 30, peak: 3, writeKB: 1 }], ['db', 'nosql-store', { retentionYears: 1, replicationFactor: 3, storageTB: 1 }]], [['c', 'db']])
    // writeQps is a peak rate: 30 / 3 = 10 writes/s average × 1 KB × 31,536,000 s × 3 = 946 GB
    close(nodes.get('db').storage.need[0], 10 * 31536000 * 3)
    expect(nodes.get('db').storage.status).toBe('pass')
  })
  it('a node can re-declare the record size from there on', () => {
    const { nodes } = cap(
      [['c', 'web-client', { writeQps: 10, writeKB: 50000 }], ['api', 'service'], ['meta', 'sql-database', { writeKB: 1, retentionYears: 1, replicationFactor: 1 }]],
      [['c', 'api'], ['api', 'meta']],
    )
    close(nodes.get('meta').storage.need[0], 10 * 31536000)
  })
  it('every derived number carries its formula', () => {
    const { nodes } = cap([['c', 'web-client', { writesPerMonth: 100e6, readWrite: 100 }], ['api', 'service', { replicas: 2, qpsPerNode: 5000 }]], [['c', 'api']])
    expect(nodes.get('c').steps[0]).toEqual({ label: 'Writes', formula: '100,000,000/month ÷ 30 days ÷ 86,400 s', value: '38.6/s' })
    expect(nodes.get('api').steps.at(-1).formula).toBe('3.9k/s requests ÷ 2 replicas')
  })
})

describe('units', () => {
  it('formats with visible units', () => {
    expect([compact(38.58), compact(3858), compact(2.5e6), size(1.83e10), bandwidth(3858), range([0, 10]), range([5, Infinity])]).toEqual(['38.6', '3.86k', '2.5M', '18.3 TB', '3.86 MB/s', '≤ 10', '≥ 5'])
  })
})
