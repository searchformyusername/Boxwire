import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { acceptedPatchFile, bundledSelection, recomputeFromBundle, rejectedFromSelection, reviewSources } from './handoff.js'
import { allChanges } from './diff.js'
import { buildReviewBundle, openReviewBundle } from '../bundle/bundle.js'
import { sourceHash } from '../bundle/digest.js'
import { readZip, writeZip } from '../bundle/zip.js'

const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8')
const baseline = read('./fixtures/baseline.boxwire.jsonc')
const proposal = read('./fixtures/proposal.boxwire.jsonc')
const rules = read('../policy/fixtures/rules.json')
const except = { all: true, except: ['edge:inventory-orders'] }

async function bundle() {
  const r = reviewSources({ baseline, proposal, rules, accept: except })
  const built = await buildReviewBundle({ name: 'Storefront change', baseline: { source: baseline }, proposal: { source: proposal }, accepted: { source: r.accepted.source, patch: acceptedPatchFile(except, r.accepted.patch) }, rules, results: r.results, createdAt: '2026-10-28T00:00:00.000Z' })
  return { r, built }
}
const recompute = recomputeFromBundle

describe('offline handoff (acceptance 3)', () => {
  it('a bundle reopened with only its own files reproduces every check and diff', async () => {
    const { r, built } = await bundle()
    expect(built.ok).toBe(true)
    expect(r.results.comparison).toEqual({ status: 'complete' })
    expect(r.results.introduced.sort()).toEqual(['no-sync-cycles:inventory+orders', 'public-to-pii-mediated:mobile+users'])
    const opened = await openReviewBundle(built.bytes, { recompute, expectBaselineHash: await sourceHash(baseline) })
    expect(opened.errors).toEqual([])
    expect(opened.mismatches).toEqual([])
    expect(opened.ok).toBe(true)
    expect(opened.sources.baseline).toBe(baseline) // comments and all
  })

  it('refuses a stale baseline: the reviewer has since changed their file', async () => {
    const { built } = await bundle()
    const opened = await openReviewBundle(built.bytes, { recompute, expectBaselineHash: await sourceHash(baseline + '\n// edited') })
    expect(opened.ok).toBe(false)
    expect(opened.errors[0].message).toMatch(/^Stale baseline/)
  })

  it('detects a tampered proposal: hashes and recomputed checks both disagree', async () => {
    const { built } = await bundle()
    const { files } = readZip(built.bytes)
    const text = new TextDecoder().decode(files.get('proposal.boxwire.jsonc')).replace('"Product catalog"', '"Catalog v2"')
    files.set('proposal.boxwire.jsonc', new TextEncoder().encode(text))
    const forged = writeZip([...files].map(([name, bytes]) => ({ name, bytes })))
    const opened = await openReviewBundle(forged, { recompute })
    expect(opened.ok).toBe(false)
    expect(opened.errors.some((e) => /proposal\.boxwire\.jsonc/.test(e.message))).toBe(true)
  })

  it('detects a hand-edited accepted source even when its hash is recomputed', async () => {
    const { r, built } = await bundle()
    const { files } = readZip(built.bytes)
    const forged = recomputeFromBundle({ baseline, proposal, rules, accepted: r.accepted.source + '\n', acceptedPatch: new TextDecoder().decode(files.get('accepted.patch.json')) })
    expect(forged.accepted.sourceChecksum).toMatch(/differs/)
  })

  it('the accepted source is the baseline plus a small unified patch, with no unsupported edits', async () => {
    const { r } = await bundle()
    expect(r.accepted.valid).toBe(true)
    expect(r.accepted.unsupported).toEqual([])
    expect(r.accepted.patch.split('\n').filter((l) => /^[-+][^-+]/.test(l)).length).toBeLessThan(40)
    for (const c of baseline.split('\n').filter((l) => l.trim().startsWith('//'))) expect(r.accepted.source).toContain(c)
  })

  it('reports parse errors with line and column, never a partial review', () => {
    const out = reviewSources({ baseline, proposal: proposal.replace('"nodes": [', '"nodes": [,'), rules })
    expect(out.error.message).toMatch(/^proposal: .*\(line \d+, column \d+\)/)
  })

  it('reopening a bundle restores the reviewer\'s checkboxes, and they reproduce the bundled acceptance', async () => {
    const { r, built } = await bundle()
    const opened = await openReviewBundle(built.bytes, { recompute })
    expect(opened.ok).toBe(true)
    const selection = bundledSelection(opened.sources.acceptedPatch)
    expect(selection).toEqual(except)
    const ids = allChanges(reviewSources({ baseline: opened.sources.baseline, proposal: opened.sources.proposal, rules: opened.sources.rules }).review.diff).map((c) => c.id)
    const { rejected, unknown } = rejectedFromSelection(selection, ids)
    expect([...rejected]).toEqual(['edge:inventory-orders'])
    expect(unknown).toEqual([])
    // what the dialog computes from the restored boxes (ChangeReview: { all: true, except: [...rejected] })
    const again = reviewSources({ ...opened.sources, accept: { all: true, except: [...rejected] } })
    expect(again.results.accepted).toEqual(opened.results.accepted)
    expect(again.accepted.source).toBe(r.accepted.source)
  })

  it('restores an explicit list selection and reports ids the diff does not have', () => {
    const ids = ['a', 'b', 'c']
    expect([...rejectedFromSelection(['a', 'c', 'zz'], ids).rejected]).toEqual(['b'])
    expect(rejectedFromSelection(['a', 'c', 'zz'], ids).unknown).toEqual(['zz'])
    expect([...rejectedFromSelection({ all: true, except: ['b', 'q'] }, ids).rejected]).toEqual(['b'])
    expect(bundledSelection('not json')).toBe(null)
    expect(bundledSelection(JSON.stringify({ format: 'other', selection: ['a'] }))).toBe(null)
  })
})
