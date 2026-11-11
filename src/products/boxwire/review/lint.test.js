import { describe, expect, it } from 'vitest'
import { compileDiagram } from '../author/compile.js'
import { RULES, lint } from './lint.js'
import { buildGraph, cycles } from './graph.js'

const measure = (s, font) => s.length * Number(/(\d+)px/.exec(font)[1]) * 0.55

/** Compile a tiny authored diagram: nodes as [id, kind, capacity?, extra?], edges as [from, to, extra?]. */
function board(nodes, edges = []) {
  const r = compileDiagram({
    format: 'boxwire-diagram', version: 1,
    nodes: nodes.map(([id, kind, capacity, extra]) => ({ id, kind, ...(capacity && { capacity }), ...extra })),
    edges: edges.map(([from, to, extra]) => ({ from, to, ...extra })),
  }, { measure })
  if (r.errors.length) throw new Error(JSON.stringify(r.errors))
  return r.doc
}

/** Results of one rule as "status:elementIds" strings. */
const of = (doc, rule) => lint(doc).results.filter((r) => r.rule === rule).map((r) => `${r.status}:${r.elementIds.join('+')}`)

const R2 = { replicas: 2 }

describe('single-point-of-failure', () => {
  const chain = (api, db) => board([['c', 'web-client'], ['api', 'service', api], ['db', 'sql-database', db]], [['c', 'api'], ['api', 'db']])
  it('fails: a single declared replica on the only path', () => {
    expect(of(chain({ replicas: 1 }, R2), 'single-point-of-failure')).toContain('violation:api')
  })
  it('fails: the only store declares one replica', () => {
    const res = lint(chain(R2, { replicas: 1 })).results.find((r) => r.id === 'single-point-of-failure:db')
    expect(res.status).toBe('violation')
    expect(res.witness).toEqual(['c', 'e1', 'api', 'e2', 'db'])
  })
  it('passes: replicas or managed declared', () => {
    expect(of(chain(R2, { managed: true }), 'single-point-of-failure')).toEqual(['pass:api'])
  })
  it('passes: an alternative path means the node is not a cut vertex', () => {
    const doc = board([['c', 'web-client'], ['a', 'service', { replicas: 1 }], ['b', 'service', R2], ['db', 'nosql-store', R2]], [['c', 'a'], ['c', 'b'], ['a', 'db'], ['b', 'db']])
    expect(of(doc, 'single-point-of-failure')).toEqual(['pass:db'])
  })
  it('is unknown, not a violation, when redundancy is undeclared', () => {
    expect(of(chain(undefined, R2), 'single-point-of-failure')).toEqual(['unknown:api', 'pass:db'])
  })
  it('ignores crossed-out (rejected) nodes', () => {
    const doc = board([['c', 'web-client'], ['api', 'service', R2], ['db', 'sql-database', R2], ['old', 'service', { replicas: 1 }, { crossed: true }]], [['c', 'api'], ['api', 'db'], ['c', 'old'], ['old', 'db']])
    expect(of(doc, 'single-point-of-failure')).not.toContain('violation:old')
  })
})

describe('cache-without-invalidation', () => {
  const base = (cache, extra = []) => board(
    [['c', 'web-client'], ['api', 'service'], ['w', 'worker'], ['cache', 'cache', cache], ['db', 'sql-database']],
    [['c', 'api'], ['api', 'cache', { carries: 'reads' }], ['api', 'db', { carries: 'reads' }], ['c', 'w'], ['w', 'db', { carries: 'writes' }], ...extra],
  )
  it('passes: a TTL is declared', () => expect(of(base({ ttlSec: 60 }), 'cache-without-invalidation')).toEqual(['pass:cache']))
  it('passes: the writer also writes the cache', () => {
    expect(of(base({ ttlSec: 0 }, [['w', 'cache', { carries: 'writes' }]]), 'cache-without-invalidation')).toEqual(['pass:cache+w'])
  })
  it('passes: an event consumer updates the cache', () => {
    const doc = board(
      [['c', 'web-client'], ['api', 'service'], ['q', 'event-stream'], ['inv', 'worker'], ['cache', 'cache', { ttlSec: 0 }], ['db', 'sql-database']],
      [['c', 'api'], ['api', 'db'], ['api', 'q', { kind: 'async' }], ['q', 'inv'], ['inv', 'cache']],
    )
    expect(of(doc, 'cache-without-invalidation')[0]).toMatch(/^pass:/)
  })
  it('fails: never expires and the writer bypasses it (cache-aside)', () => {
    const res = lint(base({ ttlSec: 0 })).results.find((r) => r.rule === 'cache-without-invalidation')
    expect(res.status).toBe('violation')
    expect(res.elementIds).toEqual(['cache', 'w', 'db'])
  })
  it('fails: read-through cache that never expires, written around', () => {
    const doc = board(
      [['c', 'web-client'], ['api', 'service'], ['cache', 'cache', { ttlSec: 0 }], ['db', 'nosql-store'], ['ing', 'worker']],
      [['c', 'api'], ['api', 'cache', { carries: 'reads' }], ['cache', 'db', { carries: 'reads' }], ['c', 'ing'], ['ing', 'db', { carries: 'writes' }]],
    )
    expect(of(doc, 'cache-without-invalidation')).toEqual(['violation:cache+ing+db'])
  })
  it('is unknown when nothing is declared', () => expect(of(base(undefined), 'cache-without-invalidation')).toEqual(['unknown:cache']))
})

describe('write-without-durable-store', () => {
  it('passes: writes reach a store, through a queue and consumer', () => {
    const doc = board([['c', 'mobile-app'], ['api', 'service'], ['q', 'message-queue'], ['w', 'worker'], ['db', 'nosql-store']], [['c', 'api'], ['api', 'q', { kind: 'async' }], ['q', 'w'], ['w', 'db']])
    expect(of(doc, 'write-without-durable-store')).toEqual(['pass:c+db'])
  })
  it('passes: a read-only client declares zero writes', () => {
    const doc = board([['c', 'web-client', { writeQps: 0, readQps: 10 }], ['api', 'service'], ['cache', 'cache']], [['c', 'api'], ['api', 'cache']])
    expect(of(doc, 'write-without-durable-store')).toEqual(['pass:c'])
  })
  it('fails: declared writes end at a cache', () => {
    const doc = board([['c', 'web-client', { writeQps: 100 }], ['api', 'service'], ['cache', 'cache']], [['c', 'api'], ['api', 'cache']])
    const res = lint(doc).results.find((r) => r.rule === 'write-without-durable-store')
    expect([res.status, res.witness]).toEqual(['violation', ['c', 'e1', 'api', 'e2', 'cache']])
  })
  it('fails: an edge declared to carry writes leads nowhere durable', () => {
    const doc = board([['c', 'web-client'], ['api', 'service'], ['w', 'worker']], [['c', 'api', { carries: 'writes' }], ['api', 'w']])
    expect(of(doc, 'write-without-durable-store')).toEqual(['violation:c+w'])
  })
  it('is unknown when writes are undeclared', () => {
    const doc = board([['c', 'web-client'], ['api', 'service']], [['c', 'api']])
    expect(of(doc, 'write-without-durable-store')).toEqual(['unknown:c'])
  })
})

describe('capacity-contradiction', () => {
  const chain = (api, db) => board([['c', 'web-client', { readQps: 9000, writeQps: 1000 }], ['api', 'service', api], ['db', 'sql-database', db]], [['c', 'api'], ['api', 'db']])
  it('fails: per-instance load above the rating', () => {
    expect(of(chain({ replicas: 2, qpsPerNode: 4000 }, { replicas: 2, qpsPerNode: 10000 }), 'capacity-contradiction')).toContain('violation:api')
  })
  it('fails: writes exceed a single leader even with many read replicas', () => {
    // 9000 reads ÷ 10 replicas = 900 plus 1000 writes on one leader = 1900 > 1500
    expect(of(chain({ replicas: 4, qpsPerNode: 5000 }, { replicas: 10, shards: 1, qpsPerNode: 1500 }), 'capacity-contradiction')).toContain('violation:db')
  })
  it('fails: retained data exceeds declared storage', () => {
    const doc = board([['c', 'web-client', { writeQps: 100, writeKB: 10 }], ['db', 'nosql-store', { retentionYears: 1, replicationFactor: 3, storageTB: 50 }]], [['c', 'db']])
    // 100 × 10 KB × 31,536,000 s × 3 = 94.6 TB > 50 TB
    expect(of(doc, 'capacity-contradiction')).toContain('violation:db')
  })
  it('passes: ratings cover the load', () => {
    expect(of(chain({ replicas: 4, qpsPerNode: 5000 }, { replicas: 3, shards: 2, qpsPerNode: 5000 }), 'capacity-contradiction')).toEqual(['pass:api', 'pass:db'])
  })
  it('passes: shards and replicas declared make it fit', () => {
    expect(of(chain({ replicas: 3, qpsPerNode: 4000 }, { replicas: 3, shards: 4, qpsPerNode: 1500 }), 'capacity-contradiction')).toEqual(['pass:api', 'pass:db'])
  })
  it('is unknown when the verdict depends on undeclared replicas', () => {
    expect(of(chain({ qpsPerNode: 4000 }, { replicas: 2, shards: 1, qpsPerNode: 1e5 }), 'capacity-contradiction')).toEqual(['unknown:api', 'pass:db'])
  })
  it('fails even with undeclared replicas when writes alone exceed every possible leader', () => {
    // writes go to shard leaders; undeclared replicas can't help, shards are declared
    expect(of(chain({ replicas: 2, qpsPerNode: 1e5 }, { shards: 1, qpsPerNode: 800 }), 'capacity-contradiction')).toContain('violation:db')
  })
  it('is unknown when no client declares load', () => {
    expect(of(board([['c', 'web-client'], ['api', 'service', { qpsPerNode: 1 }]], [['c', 'api']]), 'capacity-contradiction')).toEqual(['unknown:'])
  })
})

describe('unauthenticated-public-entry', () => {
  const entry = (gw, api) => board([['c', 'web-client'], ['lb', 'load-balancer'], ['gw', 'api-gateway', gw], ['api', 'service', api], ['db', 'sql-database']], [['c', 'lb'], ['lb', 'gw'], ['gw', 'api'], ['api', 'db']])
  it('passes: the gateway declares auth', () => expect(of(entry({ auth: true }), 'unauthenticated-public-entry')).toEqual(['pass:api']))
  it('passes: the entry calls an auth service', () => {
    const doc = board([['c', 'web-client'], ['api', 'service'], ['auth', 'auth-service']], [['c', 'api'], ['api', 'auth']])
    expect(of(doc, 'unauthenticated-public-entry')).toEqual(['pass:api'])
  })
  it('passes: deliberately public', () => expect(of(entry(undefined, { public: true }), 'unauthenticated-public-entry')).toEqual(['pass:api']))
  it('fails: the gateway declares no auth', () => {
    const res = lint(entry({ auth: false })).results.find((r) => r.rule === 'unauthenticated-public-entry')
    expect([res.status, res.witness]).toEqual(['violation', ['c', 'e1', 'lb', 'e2', 'gw', 'e3', 'api']])
  })
  it('fails: the service itself declares no auth', () => {
    const doc = board([['c', 'mobile-app'], ['api', 'service', { auth: false }]], [['c', 'api']])
    expect(of(doc, 'unauthenticated-public-entry')).toEqual(['violation:api'])
  })
  it('is unknown when nothing is declared', () => expect(of(entry(), 'unauthenticated-public-entry')).toEqual(['unknown:api']))
})

describe('client-to-datastore', () => {
  it('fails: client → SQL', () => expect(of(board([['c', 'web-client'], ['db', 'sql-database']], [['c', 'db']]), 'client-to-datastore')).toEqual(['violation:c+db']))
  it('fails: client → cache and → queue', () => {
    expect(of(board([['c', 'mobile-app'], ['r', 'cache'], ['q', 'message-queue']], [['c', 'r'], ['c', 'q']]), 'client-to-datastore')).toEqual(['violation:c+q', 'violation:c+r'])
  })
  it('passes: through a service', () => expect(of(board([['c', 'web-client'], ['api', 'service'], ['db', 'sql-database']], [['c', 'api'], ['api', 'db']]), 'client-to-datastore')).toEqual(['pass:c']))
  it('passes: pre-signed upload straight to object storage', () => {
    expect(of(board([['c', 'web-client'], ['s3', 'object-storage']], [['c', 's3', { label: 'PUT pre-signed URL' }]]), 'client-to-datastore')).toEqual(['pass:c'])
  })
})

describe('orphan-component', () => {
  it('fails: an unconnected service and store', () => {
    expect(of(board([['c', 'web-client'], ['api', 'service'], ['lost', 'service'], ['db', 'sql-database']], [['c', 'api']]), 'orphan-component')).toEqual(['violation:db', 'violation:lost'])
  })
  it('fails: a node connected only to a note is still unconnected', () => {
    expect(of(board([['api', 'service'], ['n', 'note']], [['n', 'api']]), 'orphan-component')).toEqual(['violation:api'])
  })
  it('passes: everything connected; ops kinds are exempt', () => {
    expect(of(board([['c', 'web-client'], ['api', 'service'], ['mon', 'monitoring']], [['c', 'api']]), 'orphan-component')).toEqual([])
  })
  it('passes: crossed-out options are not components', () => {
    expect(of(board([['c', 'web-client'], ['api', 'service'], ['old', 'sql-database', null, { crossed: true }]], [['c', 'api']]), 'orphan-component')).toEqual([])
  })
})

describe('queue-without-consumer', () => {
  it('fails: nothing reads the queue', () => {
    const res = lint(board([['api', 'service'], ['q', 'message-queue']], [['api', 'q', { kind: 'async' }]])).results.find((r) => r.rule === 'queue-without-consumer')
    expect([res.status, res.witness]).toEqual(['violation', ['api', 'e1', 'q']])
  })
  it('fails: a topic with only producers', () => {
    expect(of(board([['a', 'service'], ['b', 'service'], ['t', 'event-stream']], [['a', 't'], ['b', 't']]), 'queue-without-consumer')).toEqual(['violation:t'])
  })
  it('passes: a worker consumes it', () => expect(of(board([['api', 'service'], ['q', 'message-queue'], ['w', 'worker']], [['api', 'q'], ['q', 'w']]), 'queue-without-consumer')).toEqual(['pass:q']))
  it('passes: pub/sub fans out to two consumers', () => {
    expect(of(board([['p', 'pub-sub'], ['a', 'worker'], ['b', 'worker']], [['p', 'a'], ['p', 'b']]), 'queue-without-consumer')).toEqual(['pass:p'])
  })
})

describe('deep-sync-chain', () => {
  const chain = (n, asyncAt = -1) => board(
    Array.from({ length: n }, (_, i) => [`s${i}`, 'service']),
    Array.from({ length: n - 1 }, (_, i) => [`s${i}`, `s${i + 1}`, i === asyncAt ? { kind: 'async' } : {}]),
  )
  it('fails: five services in a synchronous row', () => expect(of(chain(5), 'deep-sync-chain')).toEqual(['violation:s0+s1+s2+s3+s4']))
  it('fails: six in a row reports the whole chain as witness', () => {
    expect(lint(chain(6)).results.find((r) => r.rule === 'deep-sync-chain').witness).toHaveLength(11)
  })
  it('passes: four services', () => expect(of(chain(4), 'deep-sync-chain')).toEqual(['pass:']))
  it('passes: an async hop breaks the chain', () => expect(of(chain(6, 2), 'deep-sync-chain')).toEqual(['pass:']))
})

describe('sync-cycle', () => {
  it('fails: two services calling each other', () => {
    const res = lint(board([['a', 'service'], ['b', 'service']], [['a', 'b'], ['b', 'a']])).results.find((r) => r.rule === 'sync-cycle')
    expect([res.status, res.elementIds, res.witness]).toEqual(['violation', ['a', 'b'], ['a', 'e1', 'b', 'e2', 'a']])
  })
  it('fails: a three-service ring', () => {
    expect(of(board([['a', 'service'], ['b', 'service'], ['c', 'worker']], [['a', 'b'], ['b', 'c'], ['c', 'a']]), 'sync-cycle')).toEqual(['violation:a+b+c'])
  })
  it('passes: the back edge is asynchronous', () => {
    expect(of(board([['a', 'service'], ['b', 'service']], [['a', 'b'], ['b', 'a', { kind: 'async' }]]), 'sync-cycle')).toEqual(['pass:'])
  })
  it('passes: a DAG', () => expect(of(board([['a', 'service'], ['b', 'service'], ['c', 'service']], [['a', 'b'], ['a', 'c'], ['b', 'c']]), 'sync-cycle')).toEqual(['pass:']))
})

describe('lint engine', () => {
  it('documents every rule completely', () => {
    for (const r of RULES) for (const k of ['id', 'severity', 'title', 'checks', 'violation', 'unknown', 'pass', 'fix']) expect(r[k], `${r.id}.${k}`).toBeTruthy()
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length)
  })
  it('is deterministic and gives stable result ids', () => {
    const doc = board([['c', 'web-client'], ['db', 'sql-database']], [['c', 'db']])
    expect(lint(doc).results).toEqual(lint(doc).results)
    expect(lint(doc).results.map((r) => r.id)).toContain('client-to-datastore:c+db')
  })
  it('reads arrowheads for direction and ignores UML relations', () => {
    const doc = board([['a', 'service'], ['b', 'service'], ['k', 'class', null, { name: 'K' }]], [['a', 'b', { head: 'none', tail: 'arrow' }]])
    const g = buildGraph(doc)
    expect(g.edges.map((e) => [e.from, e.to])).toEqual([['b', 'a']])
    expect(g.nodes.has('k')).toBe(false)
  })
  it('finds strongly connected components', () => {
    const g = buildGraph(board([['a', 'service'], ['b', 'service'], ['c', 'service'], ['d', 'service']], [['a', 'b'], ['b', 'a'], ['c', 'd']]))
    expect(cycles(g)).toEqual([['a', 'b']])
  })
  it('infers kinds for boards drawn before kinds were stored', () => {
    const doc = board([['c', 'web-client'], ['db', 'sql-database']], [['c', 'db']])
    for (const el of Object.values(doc)) delete el.kind
    expect(of(doc, 'client-to-datastore')).toEqual(['violation:c+db'])
  })
})

describe('audit regressions', () => {
  it('#1 a lookup edge is never a write path: no persistence pass through it', () => {
    const doc = board([['c', 'web-client', { writeQps: 100, readQps: 0 }], ['svc', 'service'], ['pg', 'sql-database']], [['c', 'svc', { carries: 'writes' }], ['svc', 'pg', { carries: 'lookups' }]])
    expect(of(doc, 'write-without-durable-store')).toEqual(['violation:c+svc'])
  })
  it('#1 a lookup of a cache is not an invalidation path', () => {
    const doc = board(
      [['c', 'web-client'], ['api', 'service'], ['w', 'worker'], ['cache', 'cache', { ttlSec: 0 }], ['pg', 'sql-database']],
      [['c', 'api'], ['api', 'cache', { carries: 'reads' }], ['api', 'pg', { carries: 'reads' }], ['c', 'w'], ['w', 'pg', { carries: 'writes' }], ['w', 'cache', { carries: 'lookups' }]],
    )
    expect(of(doc, 'cache-without-invalidation')[0]).toMatch(/^violation:cache/)
  })
  it('#2 an explicitly unauthenticated client route is found whatever the id order', () => {
    for (const [safe, bad] of [['a', 'z'], ['z', 'a']]) {
      const doc = board([[safe, 'web-client', { auth: true }], [bad, 'mobile-app', { auth: false }], ['svc', 'service']], [[safe, 'svc'], [bad, 'svc']])
      const res = lint(doc).results.find((r) => r.rule === 'unauthenticated-public-entry')
      expect(res.status).toBe('violation')
      expect(res.witness[0]).toBe(bad)
    }
  })
  it('#2 one client, two gateways: the unauthenticated gateway is a violation', () => {
    const doc = board(
      [['c', 'web-client'], ['g1', 'api-gateway', { auth: true }], ['g2', 'api-gateway', { auth: false }], ['svc', 'service']],
      [['c', 'g1'], ['c', 'g2'], ['g1', 'svc'], ['g2', 'svc']],
    )
    const res = lint(doc).results.find((r) => r.rule === 'unauthenticated-public-entry')
    expect([res.status, res.witness]).toEqual(['violation', ['c', 'e2', 'g2', 'e4', 'svc']])
  })
  it('#2 passes only when every entry path is authenticated or declared public', () => {
    const open = board(
      [['c', 'web-client'], ['g1', 'api-gateway', { auth: true }], ['g2', 'api-gateway'], ['svc', 'service']],
      [['c', 'g1'], ['c', 'g2'], ['g1', 'svc'], ['g2', 'svc']],
    )
    expect(of(open, 'unauthenticated-public-entry')).toEqual(['unknown:svc'])
    const ok = board(
      [['c', 'web-client'], ['g1', 'api-gateway', { auth: true }], ['g2', 'api-gateway', { public: true }], ['svc', 'service']],
      [['c', 'g1'], ['c', 'g2'], ['g1', 'svc'], ['g2', 'svc']],
    )
    expect(of(ok, 'unauthenticated-public-entry')).toEqual(['pass:svc'])
  })
})
