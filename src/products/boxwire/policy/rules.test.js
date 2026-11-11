import { describe, expect, it } from 'vitest'
import baseline from '../change/fixtures/baseline.json'
import proposal from '../change/fixtures/proposal.json'
import rulesDoc from './fixtures/rules.json'
import { SCOPE_NOTE, evaluateRules, validateRules } from './rules.js'

const violations = (r) => r.results.filter((x) => x.status === 'violation')
const doc = (...rules) => ({ format: 'boxwire-rules', version: 1, rules })
const nodesOf = (path) => path.filter((id) => !id.includes('-') && !/^e\d+$/.test(id))
const small = (nodes, edges, extra = {}) => ({ format: 'boxwire-diagram', version: 1, nodes, edges, ...extra })
const svc = (id, extra = {}) => ({ id, kind: 'service', label: id.toUpperCase(), ...extra })

describe('the storefront rules', () => {
  it('the fixture rules document is valid', () => {
    expect(validateRules(rulesDoc).errors).toEqual([])
  })

  it('pass on the baseline', () => {
    const r = evaluateRules(baseline, rulesDoc)
    expect(r.errors).toEqual([])
    expect(r.diagnostics).toEqual([])
    expect(r.complete).toBe(true)
    expect(violations(r)).toEqual([])
    expect(r.results.map((x) => x.id)).toEqual([
      'dangling-reference:', 'duplicate-id:', 'no-sync-cycles:', 'public-to-pii-mediated:', 'data-does-not-call-services:', 'layer-order:', 'owned:', 'sensitive-stores-replicated:',
    ])
    expect(r.note).toBe(SCOPE_NOTE)
  })

  it('find exactly the cycle and the unmediated path on the proposal, with witnesses', () => {
    const r = evaluateRules(proposal, rulesDoc)
    const v = violations(r)
    expect(v.map((x) => x.id)).toEqual(['no-sync-cycles:inventory+orders', 'public-to-pii-mediated:mobile+users'])
    const [cycle, path] = v
    expect(cycle.witness).toEqual(['inventory', 'inventory-orders', 'orders', 'orders-inventory', 'inventory'])
    expect(cycle.message).toBe('The declared model has a synchronous dependency cycle: Inventory service → Order service → Inventory service.')
    expect(nodesOf(path.witness)).toEqual(['mobile', 'profile', 'users'])
    expect(path.witness[1]).toBe('mobile-profile')
    // the id-less profile → users edge is cited by its compiler id and mapped back to the authoring edge
    expect(r.elements[path.witness[3]]).toEqual({ id: path.witness[3], entity: 'edge', index: 20, key: 'profile->users:flow' })
    expect(path.message).toContain('without passing through kind api-gateway/auth-service')
  })

  it('attach source ranges for each witness element', () => {
    const spanOf = ({ entity, index }) => (entity === 'edge' ? { start: index * 10, end: index * 10 + 9 } : entity === 'node' ? { start: 1000 + index, end: 1001 + index } : null)
    const r = evaluateRules(proposal, rulesDoc, { spanOf })
    const path = violations(r)[1]
    expect(path.ranges.map((x) => x.id)).toEqual(path.witness)
    expect(path.ranges[0]).toEqual({ id: 'mobile', entity: 'node', range: { start: 1001, end: 1002 } })
    expect(path.ranges[3].range).toEqual({ start: 200, end: 209 })
  })

  it('exclude crossed-out nodes, as the review graph does', () => {
    const crossed = structuredClone(proposal)
    crossed.nodes.find((n) => n.id === 'inventory').crossed = true
    expect(violations(evaluateRules(crossed, rulesDoc)).map((x) => x.rule)).toEqual(['public-to-pii-mediated'])
  })

  it('are deterministic', () => {
    expect(JSON.stringify(evaluateRules(proposal, rulesDoc))).toBe(JSON.stringify(evaluateRules(structuredClone(proposal), structuredClone(rulesDoc))))
  })
})

describe('rule kinds', () => {
  const nodes = [{ id: 'c', kind: 'web-client', label: 'Client' }, { id: 'gw', kind: 'api-gateway', label: 'GW' }, svc('a', { meta: { owner: 'x' } }), svc('b'), { id: 'db', kind: 'sql-database', label: 'DB', meta: { data: 'pii' } }]

  it('forbid-edge finds a store calling a service', () => {
    const v = small(nodes, [{ from: 'c', to: 'gw' }, { from: 'gw', to: 'a' }, { from: 'a', to: 'db' }, { from: 'db', to: 'b', kind: 'async' }])
    const r = evaluateRules(v, doc({ id: 'data-no-calls', kind: 'forbid-edge', from: { role: ['store'] }, to: { role: ['compute'] } }))
    expect(violations(r)).toEqual([expect.objectContaining({ id: 'data-no-calls:db+b', witness: ['db', 'e4', 'b'] })])
    const syncOnly = evaluateRules(v, doc({ id: 'data-no-calls', kind: 'forbid-edge', from: { role: ['store'] }, to: { role: ['compute'] }, edges: 'sync' }))
    expect(violations(syncOnly)).toEqual([])
  })

  it('layers forbid an edge from a later layer to an earlier one', () => {
    const v = small(nodes, [{ from: 'c', to: 'gw' }, { from: 'gw', to: 'a' }, { from: 'a', to: 'gw' }])
    const r = evaluateRules(v, doc({ id: 'layers', kind: 'layers', order: [{ role: ['client'] }, { role: ['edge'] }, { role: ['compute'] }] }))
    expect(violations(r).map((x) => [x.id, x.witness])).toEqual([['layers:a+gw', ['a', 'e3', 'gw']]])
    expect(violations(r)[0].message).toContain('layer 3')
  })

  it('no-path without unless reports the shortest path, one result per target', () => {
    const v = small(nodes, [{ from: 'c', to: 'gw' }, { from: 'gw', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'db' }, { from: 'a', to: 'db' }])
    const r = evaluateRules(v, doc({ id: 'p', kind: 'no-path', from: { role: ['client'] }, to: { meta: { data: 'pii' } } }))
    expect(violations(r).map((x) => [x.id, x.witness])).toEqual([['p:c+db', ['c', 'e1', 'gw', 'e2', 'a', 'e5', 'db']]])
    const mediated = evaluateRules(v, doc({ id: 'p', kind: 'no-path', from: { role: ['client'] }, to: { meta: { data: 'pii' } }, unless: { through: { id: ['gw'] } } }))
    expect(violations(mediated)).toEqual([])
  })

  it('selectors OR across a list and AND across keys', () => {
    const v = small(nodes, [{ from: 'c', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'db' }])
    const r = evaluateRules(v, doc({ id: 'p', kind: 'no-path', from: { role: ['client'] }, to: [{ meta: { data: 'pii' } }, { id: ['b'], role: ['compute'] }] }))
    expect(violations(r).map((x) => x.id)).toEqual(['p:c+b', 'p:c+db'])
    const none = evaluateRules(v, doc({ id: 'p', kind: 'no-path', from: { role: ['client'] }, to: { id: ['b'], role: ['store'] } }))
    expect(violations(none)).toEqual([])
  })

  it('no-cycle honours edges and among', () => {
    const v = small([svc('a'), svc('b'), svc('x')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a', kind: 'async' }, { from: 'a', to: 'x' }])
    expect(violations(evaluateRules(v, doc({ id: 'c', kind: 'no-cycle' })))).toEqual([])
    const all = evaluateRules(v, doc({ id: 'c', kind: 'no-cycle', edges: 'all' }))
    expect(violations(all).map((x) => [x.id, x.witness])).toEqual([['c:a+b', ['a', 'e1', 'b', 'e2', 'a']]])
    expect(violations(evaluateRules(v, doc({ id: 'c', kind: 'no-cycle', edges: 'all', among: { id: ['a', 'x'] } })))).toEqual([])
  })

  it('require reports missing fields with the node as witness', () => {
    const v = small(nodes, [{ from: 'c', to: 'gw' }, { from: 'gw', to: 'a' }, { from: 'gw', to: 'b' }])
    const r = evaluateRules(v, doc({ id: 'owned', kind: 'require', of: { role: ['compute'] }, fields: ['meta.owner', 'capacity.replicas'] }))
    expect(violations(r).map((x) => [x.id, x.witness, x.message])).toEqual([
      ['owned:a', ['a'], '“A” doesn\'t declare capacity.replicas.'],
      ['owned:b', ['b'], '“B” doesn\'t declare meta.owner, capacity.replicas.'],
    ])
  })

  it('zone and trust selectors read the authoring zones', () => {
    const v = small(nodes, [{ from: 'c', to: 'a' }], { zones: [{ id: 'edge', label: 'Edge', trust: 'public', contains: ['c', 'gw'] }] })
    const r = evaluateRules(v, doc({ id: 'r', kind: 'require', of: { zone: ['edge'] }, fields: ['meta.owner'] }), {})
    expect(violations(r).map((x) => x.id)).toEqual(['r:c', 'r:gw'])
    const t = evaluateRules(v, doc({ id: 'r', kind: 'require', of: { trust: ['public'], kind: ['web-client'] }, fields: ['meta.owner'] }))
    expect(violations(t).map((x) => x.id)).toEqual(['r:c'])
  })
})

describe('built-in rules', () => {
  it('report a dangling reference and skip graph rules when the diagram does not compile', () => {
    const v = small([svc('a'), svc('b')], [{ from: 'a', to: 'ghost' }, { from: 'a', to: 'b' }], { zones: [{ id: 'z', label: 'Z', contains: ['a', 'nobody'] }], positions: { phantom: { x: 0, y: 0 } } })
    const r = evaluateRules(v, doc({ id: 'c', kind: 'no-cycle' }))
    expect(r.complete).toBe(false)
    expect(r.diagnostics.length).toBeGreaterThan(0)
    expect(violations(r).map((x) => x.id)).toEqual(['dangling-reference:a->ghost:flow+ghost', 'dangling-reference:positions+phantom', 'dangling-reference:z+nobody'])
    expect(violations(r)[0].paths).toEqual(['edges[0].to'])
    expect(r.results.some((x) => x.rule === 'c')).toBe(false)
  })

  it('report duplicate ids across collections', () => {
    const v = small([svc('a'), svc('b')], [{ id: 'a', from: 'a', to: 'b' }])
    const r = evaluateRules(v, doc())
    expect(violations(r)).toEqual([expect.objectContaining({ id: 'duplicate-id:a', paths: ['nodes[0]', 'edges[0]'] })])
  })
})

describe('limits', () => {
  it('return a limits result instead of partial answers when the graph is too large', () => {
    const r = evaluateRules(proposal, rulesDoc, { maxNodes: 5 })
    expect(r.results).toEqual([])
    expect(r.limits).toEqual(expect.objectContaining({ exceeded: true, reason: 'nodes', nodes: 18, maxNodes: 5 }))
    expect(r.limits.message).toContain(SCOPE_NOTE)
  })

  it('stop when the edge budget runs out', () => {
    const r = evaluateRules(proposal, rulesDoc, { budget: 20 })
    expect(r.results).toEqual([])
    expect(r.limits).toEqual(expect.objectContaining({ exceeded: true, reason: 'budget', used: 20 }))
  })

  it('report the work done otherwise', () => {
    const r = evaluateRules(proposal, rulesDoc)
    expect(r.limits.exceeded).toBe(false)
    expect(r.limits.used).toBeGreaterThan(0)
  })
})

describe('validateRules', () => {
  const errs = (d) => validateRules(d).errors
  it('refuses an unsupported version or format', () => {
    expect(errs({ format: 'boxwire-rules', version: 2, rules: [] })).toEqual([{ path: 'version', message: 'unsupported version 2; this reviewer reads version 1.' }])
    expect(errs({ format: 'eslint', version: 1, rules: [] })[0].path).toBe('format')
    expect(errs(null)[0].path).toBe('')
  })

  it('gives JSON paths for rule problems', () => {
    const e = errs(doc(
      { id: 'ok', kind: 'no-cycle' },
      { id: 'ok', kind: 'no-cycle' },
      { id: 'Bad Id', kind: 'teleport' },
      { id: 'f', kind: 'forbid-edge', form: { role: ['store'] }, to: { role: ['computer'] } },
      { id: 'p', kind: 'no-path', from: { trust: ['top-secret'] }, to: { meta: { data: 3 } }, unless: { via: {} }, edges: 'some' },
      { id: 'r', kind: 'require', of: {}, fields: ['meta.owner', 'colour'] },
      { id: 'l', kind: 'layers', order: [{ role: ['client'] }] },
      { id: 'dangling-reference', kind: 'no-cycle' },
      { id: 's', kind: 'no-cycle', severity: 'fatal', among: { flavour: ['x'] } },
    ))
    expect(e.map((x) => x.path)).toEqual([
      'rules[1].id',
      'rules[2].id', 'rules[2].kind',
      'rules[3].form', 'rules[3].from', 'rules[3].to.role[0]',
      'rules[4].edges', 'rules[4].from.trust[0]', 'rules[4].to.meta.data', 'rules[4].unless',
      'rules[5].fields[1]',
      'rules[6].order',
      'rules[7].id',
      'rules[8].severity', 'rules[8].among.flavour',
    ])
    expect(e[0].message).toBe('duplicate rule id "ok".')
  })

  it('evaluateRules returns the document errors and no results', () => {
    const r = evaluateRules(baseline, { format: 'boxwire-rules', version: 9, rules: [] })
    expect(r.errors[0].path).toBe('version')
    expect(r.results).toEqual([])
  })

  it('without a rules document only the built-ins run', () => {
    const r = evaluateRules(proposal, null)
    expect(r.errors).toEqual([])
    expect(r.results.map((x) => x.id)).toEqual(['dangling-reference:', 'duplicate-id:'])
  })

  it('fills in defaults', () => {
    expect(validateRules(doc({ id: 'c', kind: 'no-cycle' }, { id: 'p', kind: 'no-path', from: {}, to: {} })).rules).toEqual([
      { id: 'c', kind: 'no-cycle', severity: 'error', edges: 'sync' },
      { id: 'p', kind: 'no-path', from: {}, to: {}, severity: 'error', edges: 'all' },
    ])
  })
})
