import { describe, expect, it } from 'vitest'
import baseline from './fixtures/baseline.json'
import proposal from './fixtures/proposal.json'
import rulesDoc from '../policy/fixtures/rules.json'
import { acceptChanges, merge3, resolve } from './merge.js'
import { checkValue } from './model.js'
import { evaluateRules } from '../policy/rules.js'

const measure = (s, font) => s.length * Number(/(\d+)px/.exec(font)[1]) * 0.55
const valid = (v) => checkValue(v, { measure }).errors
const node = (v, id) => v.nodes.find((n) => n.id === id)
const hasEdge = (v, from, to) => v.edges.some((e) => e.from === from && e.to === to)
const violations = (v, rules = rulesDoc) => evaluateRules(v, rules).results.filter((r) => r.status === 'violation').map((r) => r.id)
const edit = (fn) => {
  const v = structuredClone(baseline)
  fn(v)
  return v
}

// A human edit of the baseline: renames the same label the agent renamed, plus two unrelated edits.
const human = edit((v) => {
  node(v, 'catalog').label = 'Catalog API'
  node(v, 'orders').capacity.replicas = 4
  v.edges.push({ from: 'payments', to: 'ordersdb', carries: 'writes' })
})

describe('merge3', () => {
  it('turns a human edit of the field the agent changed into an explicit conflict', () => {
    const m = merge3(baseline, human, proposal, { measure })
    expect(m.conflicts).toEqual([expect.objectContaining({
      id: 'node:catalog:label', kind: 'field', entity: 'node', key: 'catalog', field: 'label',
      base: 'Catalog service', ours: 'Catalog API', theirs: 'Product catalog',
      changes: { ours: ['node:catalog:label'], theirs: ['node:catalog:label'] },
    })])
    expect(m.conflicts[0].message).toBe('Both sides changed label of “Catalog service”: ours "Catalog API", theirs "Product catalog".')
    // everything else from both sides is applied; the conflicted field keeps its base value
    expect(m.applied.ours).toEqual(['node:orders:capacity.replicas', 'edge:payments->ordersdb:flow'])
    expect(m.applied.theirs).not.toContain('node:catalog:label')
    expect(node(m.value, 'catalog').label).toBe('Catalog service')
    expect(node(m.value, 'orders').capacity.replicas).toBe(4)
    expect(node(m.value, 'reco')).toBeTruthy()
    expect(hasEdge(m.value, 'payments', 'ordersdb')).toBe(true)
    expect(m.value.positions).toEqual(proposal.positions)
    expect(m.errors).toEqual([])
    expect(m.valid).toBe(false)
  })

  it('resolve applies the chosen side', () => {
    const m = merge3(baseline, human, proposal, { measure })
    const ours = resolve(m, { 'node:catalog:label': 'ours' }, { measure })
    expect(ours.valid).toBe(true)
    expect(node(ours.value, 'catalog').label).toBe('Catalog API')
    expect(node(resolve(m, { 'node:catalog:label': 'theirs' }).value, 'catalog').label).toBe('Product catalog')
    expect(node(resolve(m, { 'node:catalog:label': 'base' }).value, 'catalog').label).toBe('Catalog service')
    const open = resolve(m, {})
    expect(open.unresolved).toEqual(['node:catalog:label'])
    expect(open.valid).toBe(false)
  })

  it('combines different fields of one node and yields a valid diagram', () => {
    const ours = edit((v) => {
      node(v, 'catalog').capacity.replicas = 5
      v.positions.gw = { x: 420, y: 120 }
      v.zones.find((z) => z.id === 'core').contains.push('psp')
    })
    const m = merge3(baseline, ours, proposal, { measure })
    expect(m.conflicts).toEqual([])
    expect(m.valid).toBe(true)
    expect(valid(m.value)).toEqual([])
    expect(node(m.value, 'catalog')).toEqual(expect.objectContaining({ label: 'Product catalog', capacity: { replicas: 5 } }))
    expect(m.value.zones.find((z) => z.id === 'core').contains).toEqual(['gw', 'auth', 'catalog', 'cache', 'orders', 'inventory', 'payments', 'ordersdb', 'events', 'notifier', 'psp', 'reco'])
  })

  it('accepts the same change made on both sides', () => {
    const ours = edit((v) => (node(v, 'catalog').label = 'Product catalog'))
    const m = merge3(baseline, ours, proposal, { measure })
    expect(m.conflicts).toEqual([])
    expect(m.applied.ours).toEqual(['node:catalog:label'])
    expect(m.applied.theirs).toContain('node:catalog:label')
    expect(valid(m.value)).toEqual([])
  })

  it('reports delete versus modify and decides the removal with its edges', () => {
    const ours = edit((v) => (node(v, 'search').label = 'Search (OpenSearch)'))
    const m = merge3(baseline, ours, proposal, { measure })
    expect(m.conflicts).toEqual([expect.objectContaining({
      id: 'node:search', kind: 'delete-modify', field: null,
      changes: { ours: ['node:search:label'], theirs: ['zone:core:contains.search', 'node:search', 'edge:catalog->search:flow'] },
    })])
    expect(m.conflicts[0].theirs).toBeNull()
    expect(m.conflicts[0].ours.label).toBe('Search (OpenSearch)')
    expect(valid(m.value)).toEqual([])
    const keep = resolve(m, { 'node:search': 'ours' }, { measure })
    expect(keep.valid).toBe(true)
    expect(node(keep.value, 'search').label).toBe('Search (OpenSearch)')
    expect(hasEdge(keep.value, 'catalog', 'search')).toBe(true)
    const drop = resolve(m, { 'node:search': 'theirs' }, { measure })
    expect(drop.valid).toBe(true)
    expect(node(drop.value, 'search')).toBeUndefined()
    expect(hasEdge(drop.value, 'catalog', 'search')).toBe(false)
  })

  it('reports an edge added to a node the other side deletes as dangling', () => {
    const ours = edit((v) => v.edges.push({ from: 'orders', to: 'search', carries: 'writes' }))
    const m = merge3(baseline, ours, proposal, { measure })
    expect(m.conflicts).toEqual([expect.objectContaining({ id: 'node:search', kind: 'dangling', changes: expect.objectContaining({ ours: ['edge:orders->search:flow'] }) })])
    expect(valid(m.value)).toEqual([])
    expect(resolve(m, { 'node:search': 'ours' }).valid).toBe(true)
    expect(resolve(m, { 'node:search': 'theirs' }).valid).toBe(true)
  })

  it('reports both sides adding one id with different content', () => {
    const add = (label) => edit((v) => {
      v.nodes.push({ id: 'x', kind: 'worker', label, meta: { owner: 'ops' } })
      v.zones[1].contains.push('x')
    })
    const m = merge3(baseline, add('Exporter'), add('Importer'), { measure })
    expect(m.conflicts.map((c) => [c.id, c.kind])).toEqual([['node:x', 'add-add']])
    expect(merge3(baseline, add('Same'), add('Same'), { measure }).conflicts).toEqual([])
    const asZone = edit((v) => v.zones.push({ id: 'x', label: 'X', contains: ['psp'] }))
    expect(merge3(baseline, add('Exporter'), asZone, { measure }).conflicts.map((c) => c.kind)).toEqual(['add-add'])
  })

  it('reports a reconnect to a node the other side deletes', () => {
    const ours = edit((v) => (v.edges.find((e) => e.id === 'orders-inventory').to = 'search'))
    const m = merge3(baseline, ours, proposal, { measure })
    expect(m.conflicts.map((c) => [c.id, c.kind])).toEqual([['node:search', 'dangling']])
  })
})

describe('acceptChanges', () => {
  it('accepting everything except the cycle edge gives a valid diagram without the cycle', () => {
    const r = acceptChanges(baseline, proposal, { all: true, except: ['edge:inventory-orders'] }, { rules: rulesDoc, measure })
    expect(r.errors).toEqual([])
    expect(r.valid).toBe(true)
    expect(valid(r.value)).toEqual([])
    expect(hasEdge(r.value, 'inventory', 'orders')).toBe(false)
    expect(r.required).toEqual([])
    expect(r.rejected).toEqual([])
    expect(r.brokenInvariants).toEqual([])
    expect(violations(r.value)).toEqual(['public-to-pii-mediated:mobile+users'])
  })

  it('pulls in the endpoint node an accepted edge needs', () => {
    const r = acceptChanges(baseline, proposal, ['edge:gw-reco'], { measure })
    expect(r.required).toEqual(['node:reco'])
    expect(r.applied).toEqual(['node:reco', 'edge:gw-reco'])
    expect(r.valid).toBe(true)
    expect(node(r.value, 'reco')).toBeTruthy()
  })

  it('pulls in the removal of a removed node\'s edges and memberships', () => {
    const r = acceptChanges(baseline, proposal, ['node:search'], { measure })
    expect(r.required).toEqual(['zone:core:contains.search', 'edge:catalog->search:flow'])
    expect(r.valid).toBe(true)
    expect(node(r.value, 'search')).toBeUndefined()
  })

  it('rejecting a node addition drops the edges and memberships on it', () => {
    const pinned = structuredClone(proposal)
    pinned.positions.reco = { x: 600, y: 300 }
    const r = acceptChanges(baseline, pinned, { all: true, except: ['node:reco'] }, { measure })
    expect(r.rejected).toEqual(['zone:core:contains.reco', 'edge:gw-reco', 'edge:reco->catalog:flow', 'diagram:positions.reco'])
    expect(r.valid).toBe(true)
    expect(JSON.stringify(r.value)).not.toContain('reco')
  })

  it('an explicit rejection wins over an acceptance that needs it', () => {
    const r = acceptChanges(baseline, proposal, ['edge:gw-reco'], { rejected: ['node:reco'], measure })
    expect(r.applied).toEqual([])
    expect(r.rejected).toEqual(['edge:gw-reco'])
    expect(r.value).toEqual(baseline)
  })

  it('accepting only the layout edits changes no semantics', () => {
    const r = acceptChanges(baseline, proposal, ['diagram:positions.gw', 'diagram:positions.cdn'], { rules: rulesDoc, measure })
    expect(r.valid).toBe(true)
    expect(r.value.positions).toEqual(proposal.positions)
    expect({ ...r.value, positions: baseline.positions }).toEqual(baseline)
  })

  it('reports rules that hold on base and proposal but break on the partial result', () => {
    const svc = (id) => ({ id, kind: 'service', label: id.toUpperCase() })
    const base = { format: 'boxwire-diagram', version: 1, nodes: [svc('a'), svc('b')], edges: [{ from: 'a', to: 'b' }] }
    const reversed = { ...base, edges: [{ from: 'b', to: 'a' }] }
    const rules = { format: 'boxwire-rules', version: 1, rules: [{ id: 'acyclic', kind: 'no-cycle' }] }
    const r = acceptChanges(base, reversed, ['edge:b->a:flow'], { rules, measure })
    expect(r.valid).toBe(true)
    expect(r.brokenInvariants).toEqual([{ rule: 'acyclic', results: [expect.objectContaining({ id: 'acyclic:a+b' })] }])
    expect(acceptChanges(base, reversed, ['edge:b->a:flow', 'edge:a->b:flow'], { rules, measure }).brokenInvariants).toEqual([])
  })

  it('reports unknown change ids', () => {
    expect(acceptChanges(baseline, proposal, ['node:nope']).errors).toEqual([{ path: 'accepted', message: 'unknown change "node:nope".' }])
  })
})
