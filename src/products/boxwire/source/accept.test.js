import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseSource } from './cst.js'
import { sourceForChanges } from './accept.js'
import { churn, lineDiff, unified } from './linediff.js'
import { allChanges, diffModels } from '../change/diff.js'
import { acceptChanges } from '../change/merge.js'
import { reviewChange } from '../change/review.js'
import { indexSource } from './index.js'

const read = (f) => fs.readFileSync(new URL(`../change/fixtures/${f}`, import.meta.url), 'utf8')
const baseText = read('baseline.boxwire.jsonc')
const proposalText = read('proposal.boxwire.jsonc')
const rules = JSON.parse(fs.readFileSync(new URL('../policy/fixtures/rules.json', import.meta.url), 'utf8'))
const value = (t) => parseSource(t).value
const comments = (t) => t.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('//') || l.startsWith('/*') || l.endsWith('*/'))
const identityOnly = (d) => d.semantic.length === 0 && d.presentation.length === 0 && d.layout.length === 0

describe('commented review sample (acceptance 2)', () => {
  it('the proposal source is the baseline plus minimal edits, every comment kept', () => {
    expect(identityOnly(diffModels(value(proposalText), JSON.parse(read('proposal.json'))))).toBe(true)
    for (const c of comments(baseText).filter((l) => !l.includes('baseline architecture'))) expect(proposalText).toContain(c)
    const { removed, added } = churn(lineDiff(baseText, proposalText))
    expect(removed + added).toBeLessThan(baseText.split('\n').length * 0.6)
  })

  it('reviews the JSONC sources: rename is one change, layout apart, cycle + public→PII path found with source ranges', () => {
    const base = value(baseText), proposal = value(proposalText)
    const idx = indexSource(parseSource(proposalText).cst, proposal)
    const r = reviewChange({ base, proposal, rules, spanOf: { proposal: (q) => idx.spanOf(q) } })
    expect(r.diff.semantic.filter((c) => c.key === 'catalog').map((c) => c.id)).toEqual(['node:catalog:label'])
    expect(r.diff.layout.some((c) => c.id.startsWith('diagram:positions.'))).toBe(true)
    expect(r.introduced.map((x) => x.rule).sort()).toEqual(['no-sync-cycles', 'public-to-pii-mediated'])
    for (const v of r.introduced) {
      expect(v.ranges.length).toBeGreaterThan(0)
      for (const { range } of v.ranges) expect(proposalText.slice(range.start, range.end)).toMatch(/^\{/)
    }
  })

  it('safe partial acceptance → a minimal source patch whose model equals the accepted model', () => {
    const base = value(baseText), proposal = value(proposalText)
    const accepted = acceptChanges(base, proposal, { all: true, except: ['edge:inventory-orders'] }, { rules })
    expect(accepted.valid).toBe(true)
    expect(accepted.brokenInvariants).toEqual([])
    const changes = allChanges(diffModels(base, proposal)).filter((c) => accepted.applied.includes(c.id))
    const out = sourceForChanges(baseText, changes, proposal)
    expect(out.unsupported).toEqual([])
    expect(identityOnly(diffModels(value(out.text), accepted.value))).toBe(true)
    // the cycle is gone in what was accepted; the human never sees a whole-file rewrite
    const after = reviewChange({ base, proposal: value(out.text), rules })
    expect(after.introduced.map((x) => x.rule)).toEqual(['public-to-pii-mediated'])
    const hunks = lineDiff(baseText, out.text)
    expect(churn(hunks).removed + churn(hunks).added).toBeLessThan(40)
    expect(unified(hunks)).toMatch(/^--- a\/baseline\.boxwire\.jsonc\n\+\+\+ b\/accepted\.boxwire\.jsonc\n@@ -\d+,\d+ \+\d+,\d+ @@/)
  })
})

describe('line diff', () => {
  it('groups nearby changes and keeps counts consistent', () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n')
    const b = a.replace('l5', 'L5').replace('l8', 'L8').replace('l25', 'L25')
    const h = lineDiff(a, b)
    expect(h.length).toBe(2)
    for (const x of h) {
      expect(x.lines.filter((l) => l[0] !== '+').length).toBe(x.oldLines)
      expect(x.lines.filter((l) => l[0] !== '-').length).toBe(x.newLines)
    }
    expect(churn(h)).toEqual({ removed: 3, added: 3 })
    expect(lineDiff(a, a)).toEqual([])
  })
})
