// Per-revision review caches: a hit returns exactly what a cold computation does, and a value
// changed after it was cached is never answered from the cache.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { clearCaches, lru, memoStats } from './memo.js'
import { reviewSources } from './handoff.js'
import { checkValue } from './model.js'
import { evaluateRules } from '../policy/rules.js'
import { sourceForChanges } from '../source/accept.js'
import { applySourceOps } from '../source/edit.js'
import { allChanges } from './diff.js'
import { largeSources } from './fixtures/large.js'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const baseline = read('./fixtures/baseline.boxwire.jsonc')
const proposal = read('./fixtures/proposal.boxwire.jsonc')
const rules = read('../policy/fixtures/rules.json')

describe('review caches', () => {
  it('lru keeps the most recently used entries', () => {
    const c = lru(2)
    c.set('a', 1)
    c.set('b', 2)
    c.get('a')
    c.set('c', 3)
    expect([c.get('a'), c.get('b'), c.get('c')]).toEqual([1, undefined, 3])
  })

  it('warm reviews equal cold ones, for every single-change rejection of the sample', () => {
    clearCaches()
    const ids = allChanges(reviewSources({ baseline, proposal, rules }).review.diff).map((c) => c.id)
    for (const id of ids) {
      const accept = { all: true, except: [id] }
      const warm = reviewSources({ baseline, proposal, rules, accept })
      clearCaches()
      const cold = reviewSources({ baseline, proposal, rules, accept })
      expect(JSON.stringify(warm.results)).toBe(JSON.stringify(cold.results))
      expect(warm.accepted.source).toBe(cold.accepted.source)
    }
    expect(memoStats().hits).toBeGreaterThan(0)
  })

  it('never answers a mutated value from the cache (keys are content, not identity)', () => {
    clearCaches()
    const v = JSON.parse(JSON.stringify(reviewSources({ baseline, proposal }).values.proposal))
    const before = checkValue(v)
    expect(before.errors).toEqual([])
    v.edges.push({ from: v.nodes[0].id, to: 'nowhere' })
    expect(checkValue(v).errors.length).toBeGreaterThan(0)
    const evaluated = evaluateRules(v, null)
    expect(evaluated.results.some((r) => r.rule === 'dangling-reference' && r.status === 'violation')).toBe(true)
  })

  it('freezes cached parsed sources, so no caller can change them for the next review', () => {
    const { values } = reviewSources({ baseline, proposal })
    expect(Object.isFrozen(values.baseline.nodes[0])).toBe(true)
    expect(() => {
      values.baseline.nodes[0].label = 'x'
    }).toThrow()
  })

  it('writes a batch of disjoint field sets exactly as one-at-a-time writes do (600 nodes, 54 changes)', () => {
    const { baseline: b, proposal: p } = largeSources(600, { changes: 50 })
    const run = reviewSources({ baseline: b, proposal: p })
    const changes = allChanges(run.review.diff)
    const batched = sourceForChanges(b, changes, run.values.proposal)
    // reference: every change written by itself, in the same order, through the public op API
    let text = b
    for (const c of changes.filter((x) => x.type === 'change')) {
      const r = applySourceOps(text, [{ op: 'set', entity: c.entity, id: c.key, path: c.field.split('.'), value: c.after }])
      expect(r.error).toBeUndefined()
      text = r.text
    }
    const adds = sourceForChanges(text, changes.filter((x) => x.type === 'add'), run.values.proposal)
    expect(batched.unsupported).toEqual([])
    expect(batched.applied.length).toBe(changes.length)
    expect(batched.text).toBe(adds.text)
  })
})
