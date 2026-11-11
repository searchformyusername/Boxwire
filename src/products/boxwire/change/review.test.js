import { describe, expect, it } from 'vitest'
import baseline from './fixtures/baseline.json'
import proposal from './fixtures/proposal.json'
import rulesDoc from '../policy/fixtures/rules.json'
import { reviewChange } from './review.js'
import { resolve } from './merge.js'

describe('reviewChange (acceptance slice 2)', () => {
  const r = reviewChange({ base: baseline, proposal, rules: rulesDoc })

  it('shows semantic changes apart from layout and presentation', () => {
    expect(r.summary.semantic).toHaveLength(10)
    expect(r.summary.layout).toEqual(['Pinned “CDN (static assets)”', 'Moved “API gateway”'])
    expect(r.summary.identity).toEqual(['Gave API gateway → Order service the id “gw-orders” (was generated “e5”)'])
    expect(r.changeCount).toBe(15)
  })

  it('names exactly the violations the proposal introduces', () => {
    expect(r.introduced.map((x) => x.id)).toEqual(['no-sync-cycles:inventory+orders', 'public-to-pii-mediated:mobile+users'])
    expect(r.resolved).toEqual([])
    expect(r.rules.base.results.every((x) => x.status === 'pass')).toBe(true)
    expect(r.merge).toBeUndefined()
  })

  it('lists violations the proposal resolves', () => {
    const back = reviewChange({ base: proposal, proposal: baseline, rules: rulesDoc })
    expect(back.introduced).toEqual([])
    expect(back.resolved.map((x) => x.id)).toEqual(['no-sync-cycles:inventory+orders', 'public-to-pii-mediated:mobile+users'])
  })

  it('merges a human edit of the same baseline and keeps it when chosen', () => {
    const ours = structuredClone(baseline)
    ours.nodes.find((n) => n.id === 'catalog').label = 'Catalog API'
    ours.positions.gw = { x: 300, y: 100 }
    const withMerge = reviewChange({ base: baseline, proposal, ours, rules: rulesDoc })
    expect(withMerge.merge.conflicts.map((c) => c.id)).toEqual(['diagram:positions.gw', 'node:catalog:label'])
    const done = resolve(withMerge.merge, { 'node:catalog:label': 'ours', 'diagram:positions.gw': 'ours' })
    expect(done.valid).toBe(true)
    expect(done.value.positions.gw).toEqual({ x: 300, y: 100 })
    expect(done.value.nodes.find((n) => n.id === 'catalog').label).toBe('Catalog API')
  })

  it('passes source spans per side', () => {
    const spanOf = { proposal: ({ entity, index }) => ({ entity, index }) }
    const s = reviewChange({ base: baseline, proposal, rules: rulesDoc, spanOf })
    expect(s.introduced[0].ranges[0]).toEqual({ id: 'inventory', entity: 'node', range: { entity: 'node', index: 9 } })
    expect(s.rules.base.results[0].ranges).toBeUndefined()
  })

  it('is deterministic and survives a JSON round trip of its inputs and output', () => {
    const again = reviewChange(JSON.parse(JSON.stringify({ base: baseline, proposal, rules: rulesDoc })))
    expect(JSON.stringify(again)).toBe(JSON.stringify(r))
    expect(JSON.parse(JSON.stringify(r))).toEqual(r)
  })
})

describe('audit #3: an aborted evaluation is never evidence of resolution', () => {
  it('reports "not evaluated" when the proposal exhausts the default budget (2 nodes, 1000 → 2000 edges, 200 rules)', () => {
    const nodes = [{ id: 'a', kind: 'service' }, { id: 'b', kind: 'service' }]
    const edges = (n) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, from: 'a', to: 'b' }))
    const base = { format: 'boxwire-diagram', version: 1, nodes, edges: edges(1000) }
    const prop = { ...base, edges: edges(2000) }
    const rules = { format: 'boxwire-rules', version: 1, rules: Array.from({ length: 200 }, (_, i) => ({ id: `deny-${i}`, kind: 'forbid-edge', from: { id: ['a'] }, to: { id: ['b'] } })) }
    const review = reviewChange({ base, proposal: prop, rules })
    expect(review.rules.base.limits.exceeded).toBe(false)
    expect(review.rules.proposal.limits.exceeded).toBe(true)
    expect(review.comparison.status).toBe('not-evaluated')
    expect(review.comparison.reasons[0]).toMatch(/proposal evaluation stopped/)
    expect(review.resolved).toEqual([])
    expect(review.introduced).toEqual([])
  })
  it('is complete when both sides evaluate', () => {
    expect(reviewChange({ base: baseline, proposal, rules: rulesDoc }).comparison).toEqual({ status: 'complete' })
  })
})
