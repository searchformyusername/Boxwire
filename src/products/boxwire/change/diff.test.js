import { describe, expect, it } from 'vitest'
import baseline from './fixtures/baseline.json'
import proposal from './fixtures/proposal.json'
import { allChanges, diffModels, summarise } from './diff.js'
import { alignEdges, applyChanges, checkValue, same } from './model.js'

const ids = (list) => list.map((c) => c.id)
const tiny = (extra = {}) => ({
  format: 'boxwire-diagram', version: 1,
  nodes: [{ id: 'a', kind: 'service', label: 'A' }, { id: 'b', kind: 'service', label: 'B' }, { id: 'db', kind: 'sql-database', label: 'DB' }],
  edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'db' }],
  ...extra,
})

describe('diffModels on the storefront fixtures', () => {
  const d = diffModels(baseline, proposal)

  it('separates the layout edit from semantic changes', () => {
    expect(ids(d.layout)).toEqual(['diagram:positions.cdn', 'diagram:positions.gw'])
    expect(ids(d.identity)).toEqual(['edge:gw->orders:flow:id'])
    expect(d.semantic.some((c) => c.field?.startsWith('positions.'))).toBe(false)
    expect(ids(d.presentation)).toEqual(['node:cache:color', 'frame:f-checkout:label'])
  })

  it('reports the rename as one label change, never remove plus add', () => {
    const catalog = allChanges(d).filter((c) => c.key === 'catalog')
    expect(catalog).toEqual([expect.objectContaining({ id: 'node:catalog:label', type: 'change', before: 'Catalog service', after: 'Product catalog', class: 'semantic' })])
  })

  it('lists additions, removals and membership by stable id', () => {
    expect(ids(d.semantic)).toEqual([
      'zone:core:contains.reco', 'zone:core:contains.search',
      'node:catalog:label', 'node:reco', 'node:search',
      'edge:catalog->search:flow', 'edge:gw-reco', 'edge:inventory-orders', 'edge:mobile-profile', 'edge:reco->catalog:flow',
    ])
    const types = Object.fromEntries(d.semantic.map((c) => [c.id, c.type]))
    expect(types['node:reco']).toBe('add')
    expect(types['node:search']).toBe('remove')
    expect(types['edge:catalog->search:flow']).toBe('remove')
    expect(d.semantic.find((c) => c.id === 'node:reco').anchor).toBe('catalog')
  })

  it('matches an id-less edge to the same edge given an id', () => {
    const gwOrders = allChanges(d).filter((c) => c.entity === 'edge' && c.key.startsWith('gw->orders'))
    expect(gwOrders).toEqual([expect.objectContaining({ type: 'change', field: 'id', before: undefined, after: 'gw-orders', class: 'identity' })])
  })

  it('summarises with labels, not ids', () => {
    expect(summarise(d.semantic)).toContain('Renamed “Catalog service” to “Product catalog”')
    expect(summarise(d.semantic)).toContain('Connected Mobile app → Profile service (flow)')
    expect(summarise(d.semantic)).toContain('Removed “Search index” from zone “Core services”')
    expect(summarise(d.layout)).toEqual(['Pinned “CDN (static assets)”', 'Moved “API gateway”'])
    expect(summarise(d.identity)).toEqual(['Gave API gateway → Order service the id “gw-orders” (was generated “e5”)'])
  })

  it('applying every change to the base reproduces the proposal', () => {
    const out = applyChanges(baseline, allChanges(d))
    expect(diffModels(out, proposal)).toEqual({ semantic: [], layout: [], presentation: [], identity: [] })
    expect(checkValue(out).errors).toEqual([])
  })

  it('is deterministic and independent of array and key order', () => {
    expect(JSON.stringify(diffModels(baseline, proposal))).toBe(JSON.stringify(d))
    const shuffled = structuredClone(proposal)
    shuffled.nodes.reverse()
    shuffled.zones.reverse()
    shuffled.nodes = shuffled.nodes.map((n) => Object.fromEntries(Object.entries(n).reverse()))
    const again = diffModels(baseline, shuffled)
    for (const k of ['semantic', 'layout', 'presentation']) expect(ids(again[k])).toEqual(ids(d[k]))
  })
})

describe('field classification and granularity', () => {
  it('splits capacity and meta per key', () => {
    const next = tiny({ nodes: [{ id: 'a', kind: 'service', label: 'A', capacity: { replicas: 3 }, meta: { owner: 'x' } }, { id: 'b', kind: 'service', label: 'B' }, { id: 'db', kind: 'sql-database', label: 'DB' }] })
    expect(ids(diffModels(tiny(), next).semantic)).toEqual(['node:a:capacity.replicas', 'node:a:meta.owner'])
  })

  it('treats edge dash as semantic only when it flips sync/async', () => {
    const dashed = tiny({ edges: [{ from: 'a', to: 'b', dash: 'dashed' }, { from: 'b', to: 'db', color: 'red', route: 'curve' }] })
    const d = diffModels(tiny(), dashed)
    expect(ids(d.semantic)).toEqual(['edge:a->b:flow:dash'])
    expect(ids(d.layout)).toEqual(['edge:b->db:flow:route'])
    expect(ids(d.presentation)).toEqual(['edge:b->db:flow:color'])
    const dotted = diffModels(tiny(), tiny({ edges: [{ from: 'a', to: 'b', dash: 'dotted' }, { from: 'b', to: 'db' }] }))
    expect(ids(dotted.presentation)).toEqual(['edge:a->b:flow:dash'])
  })

  it('reverses direction through head/tail as a semantic change', () => {
    const back = diffModels(tiny(), tiny({ edges: [{ from: 'a', to: 'b', head: 'none', tail: 'arrow' }, { from: 'b', to: 'db' }] }))
    expect(ids(back.semantic)).toEqual(['edge:a->b:flow:head', 'edge:a->b:flow:tail'])
  })

  it('treats zone trust as semantic', () => {
    const z = (trust) => tiny({ zones: [{ id: 'z', label: 'Z', contains: ['a'], ...(trust && { trust }) }] })
    expect(ids(diffModels(z(), z('public')).semantic)).toEqual(['zone:z:trust'])
  })

  it('keys duplicate id-less edges by occurrence', () => {
    const two = tiny({ edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b', label: 'second' }, { from: 'b', to: 'db' }] })
    const { baseKeys } = alignEdges(two.edges, [])
    expect(baseKeys).toEqual(['a->b:flow', 'a->b:flow#2', 'b->db:flow'])
    const d = diffModels(two, tiny())
    expect(ids(d.semantic)).toEqual(['edge:a->b:flow#2'])
  })

  it('reports an edge reconnect on an id-bearing edge as one field change', () => {
    const base = tiny({ edges: [{ id: 'x', from: 'a', to: 'b' }] })
    const next = tiny({ edges: [{ id: 'x', from: 'a', to: 'db' }] })
    expect(diffModels(base, next).semantic).toEqual([expect.objectContaining({ id: 'edge:x:to', before: 'b', after: 'db' })])
    expect(summarise(diffModels(base, next).semantic)).toEqual(['Reconnected A → B as A → DB'])
  })

  it('treats explicit ids that differ as different edges', () => {
    const d = diffModels(tiny({ edges: [{ id: 'x', from: 'a', to: 'b' }] }), tiny({ edges: [{ id: 'y', from: 'a', to: 'b' }] }))
    expect(ids(d.semantic)).toEqual(['edge:x', 'edge:y'])
  })

  it('compares values canonically', () => {
    expect(same({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toBe(true)
  })
})
