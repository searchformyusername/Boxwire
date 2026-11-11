import { beforeAll, describe, expect, it } from 'vitest'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { BUNDLE_FORMAT, PATHS, buildReviewBundle, bundleSummary, jsonMismatches, openReviewBundle } from './bundle.js'
import { readZip, writeZip } from './zip.js'
import { sha256Base64, sourceHash } from './digest.js'
import { lineCol } from './view.js'
import { compileDiagram } from '../author/compile.js'

const enc = new TextEncoder()
const dec = new TextDecoder()
const read = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')
const measure = (s) => s.length * 8
const CREATED = '2026-10-28T12:00:00.000Z'

/** Comments out of JSONC (strings respected), for compiling the fixtures in this test only. */
const stripJsonc = (s) => s.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === '"' ? m : ''))
const compile = (src) => {
  const r = compileDiagram(typeof src === 'string' ? JSON.parse(stripJsonc(src)) : src, { measure })
  expect(r.errors).toEqual([])
  return r.doc
}

let renderSvgString
beforeAll(async () => {
  // node has no canvas: draw.js wraps labels with the default measure, and icons build a Path2D
  globalThis.document ??= { createElement: () => ({ getContext: () => ({ font: '', measureText: (s) => ({ width: measure(s) }) }) }) }
  globalThis.Path2D ??= class Path2D {}
  ;({ renderSvgString } = await import('../export/svg.js'))
})

const renderSvg = (doc) => {
  const nodes = Object.values(doc).filter((el) => el.type === 'node')
  const x0 = Math.min(...nodes.map((n) => n.x)) - 40, y0 = Math.min(...nodes.map((n) => n.y)) - 40
  const x1 = Math.max(...nodes.map((n) => n.x + n.w)) + 40, y1 = Math.max(...nodes.map((n) => n.y + n.h)) + 40
  const camera = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  return renderSvgString(doc, { camera, width: Math.round(camera.w), height: Math.round(camera.h), theme: 'light', measure })
}

const baseline = read('baseline.boxwire.jsonc')
const proposal = read('proposal.boxwire.jsonc')
const rules = read('rules.json')
const results = JSON.parse(read('results.json'))
const input = (more = {}) => ({
  name: 'Checkout: payments',
  baseline: { source: baseline },
  proposal: { source: proposal },
  accepted: { source: proposal, patch: { format: 'boxwire-source-patch', version: 1, edits: [{ at: 777, delete: 46, insert: '' }] } },
  rules,
  results,
  docs: { baseline: compile(baseline), proposal: compile(proposal) },
  renderSvg,
  createdAt: CREATED,
  ...more,
})
const build = async (more) => {
  const r = await buildReviewBundle(input(more))
  expect(r.errors).toEqual([])
  return r
}
/** Re-zip a bundle after editing its file map (manifest hashes are not updated). */
const repack = (bytes, edit) => {
  const files = readZip(bytes).files
  edit(files)
  return writeZip([...files].map(([name, b]) => ({ name, bytes: b })))
}
const htmlOf = (opened) => dec.decode(opened.files.get(PATHS.html))
const dataOf = (html) => JSON.parse(/<script type="application\/json" id="data">([^<]*)<\/script>/.exec(html)[1])

describe('buildReviewBundle → openReviewBundle', () => {
  it('round-trips every file unchanged and verifies', async () => {
    const built = await build()
    const opened = await openReviewBundle(built.bytes)
    expect(opened.errors).toEqual([])
    expect(opened.warnings).toEqual([])
    expect(opened.ok).toBe(true)
    expect(opened.manifest).toEqual(built.manifest)
    expect([...opened.files.keys()]).toEqual([PATHS.baseline, PATHS.proposal, PATHS.accepted, PATHS.acceptedPatch, PATHS.rules, PATHS.results, PATHS.baselineView, PATHS.proposalView, PATHS.html])
    expect(opened.sources.baseline).toBe(baseline)
    expect(opened.sources.proposal).toBe(proposal)
    expect(opened.sources.rules).toBe(rules)
    expect(opened.results).toEqual(results)
    expect(JSON.parse(opened.sources.acceptedPatch)).toEqual(input().accepted.patch)
    expect(dec.decode(opened.files.get(PATHS.proposalView))).toBe(renderSvg(compile(proposal)))
  })

  it('writes the manifest the format describes', async () => {
    const { manifest } = await build()
    expect(manifest).toMatchObject({ format: BUNDLE_FORMAT, version: 1, name: 'Checkout: payments', createdAt: CREATED, tool: { name: 'Boxwire' } })
    expect(manifest.note).toMatch(/do not identify a reviewer and are not an approval/)
    expect(manifest.baselineHash).toBe(await sourceHash(baseline))
    expect(manifest.proposalHash).toBe(await sourceHash(proposal))
    for (const f of manifest.files) expect(f).toEqual({ path: expect.any(String), sha256: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: expect.any(Number) })
  })

  it('is deterministic', async () => {
    const a = await build(), b = await build()
    expect(a.bytes).toEqual(b.bytes)
    expect((await build({ createdAt: '2026-10-29T00:00:00.000Z' })).bytes).not.toEqual(a.bytes)
  })

  it('works without the optional parts', async () => {
    const r = await buildReviewBundle({ name: 'Bare', baseline: { source: baseline }, proposal: { source: proposal }, results: {}, createdAt: CREATED })
    expect(r.ok).toBe(true)
    const opened = await openReviewBundle(r.bytes)
    expect(opened.ok).toBe(true)
    expect([...opened.files.keys()]).toEqual([PATHS.baseline, PATHS.proposal, PATHS.results, PATHS.html])
    expect(htmlOf(opened)).not.toContain('<img')
  })

  it('refuses bad input with clear errors', async () => {
    const r = await buildReviewBundle({ name: '', baseline: {}, proposal: { source: 1 }, results: [] })
    expect(r.ok).toBe(false)
    expect(r.bytes).toBeNull()
    expect(r.errors.map((e) => e.message)).toEqual(['name must be a non-empty string.', 'baseline.source must be a string.', 'proposal.source must be a string.', 'results must be an object.'])
    const failing = await buildReviewBundle(input({ renderSvg: () => { throw new Error('no canvas') } }))
    expect(failing.errors).toEqual([{ code: 'render', message: 'Rendering the baseline view failed: no canvas.' }, { code: 'render', message: 'Rendering the proposal view failed: no canvas.' }])
  })

  it('reports a quota-style failure when the contents exceed the limit', async () => {
    const huge = `// ${'x'.repeat(51 * 1024 * 1024)}\n${baseline}`
    const r = await buildReviewBundle(input({ baseline: { source: huge } }))
    expect(r).toMatchObject({ ok: false, bytes: null, manifest: null })
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0].code).toBe('too-large')
    expect(r.errors[0].message).toMatch(/^The bundle would hold 51(\.\d)? MB; the limit is 50 MB\. Nothing was written\./)
    // the limit also counts rendered views and review.html
    const small = await buildReviewBundle(input({ limits: { totalBytes: 8000, entries: 500 } }))
    expect(small.errors[0].code).toBe('too-large')
  })
})

describe('openReviewBundle refuses', () => {
  it('a tampered byte, naming the file (CRC-32)', async () => {
    const { bytes } = await build()
    const at = Buffer.from(bytes).indexOf('as reviewed last quarter')
    expect(at).toBeGreaterThan(0)
    bytes[at] ^= 0x01
    const r = await openReviewBundle(bytes)
    expect(r.ok).toBe(false)
    expect(r.errors).toEqual([expect.objectContaining({ code: 'crc', file: PATHS.baseline })])
  })

  it('a file re-zipped with different content, naming the file (SHA-256)', async () => {
    const { bytes } = await build()
    const altered = repack(bytes, (f) => f.set(PATHS.results, enc.encode(JSON.stringify({ ...results, rules: [] }, null, 2) + '\n')))
    const r = await openReviewBundle(altered)
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => [e.code, e.file])).toEqual([['size', PATHS.results], ['hash', PATHS.results]])
    expect(r.errors[1].message).toMatch(/^results\.json: SHA-256 mismatch \(manifest [0-9a-f]{12}…, file [0-9a-f]{12}…\)/)
  })

  it('a truncated archive', async () => {
    const { bytes } = await build()
    for (const cut of [bytes.length - 5, Math.floor(bytes.length / 2), 100]) {
      const r = await openReviewBundle(bytes.slice(0, cut))
      expect(r.ok).toBe(false)
      expect(r.errors[0].code).toBe('no-eocd')
      expect(r.files.size).toBe(0)
    }
  })

  it('a deflated entry', async () => {
    const { bytes } = await build()
    // flip results.json to method 8 in its local header and central directory entry
    const v = new DataView(bytes.buffer)
    for (let i = 0; i < bytes.length - 4; i++) {
      const sig = v.getUint32(i, true)
      const nameAt = sig === 0x04034b50 ? i + 30 : sig === 0x02014b50 ? i + 46 : -1
      if (nameAt > 0 && dec.decode(bytes.subarray(nameAt, nameAt + PATHS.results.length)) === PATHS.results) v.setUint16(i + (sig === 0x04034b50 ? 8 : 10), 8, true)
    }
    const r = await openReviewBundle(bytes)
    expect(r.ok).toBe(false)
    expect(r.errors).toEqual([expect.objectContaining({ code: 'compressed', file: PATHS.results })])
    expect(r.errors[0].message).toBe('Entry "results.json" is compressed with deflate; only stored (uncompressed) entries are supported. Re-create the archive without compression (for example `zip -0`).')
    expect((await openReviewBundle(new Uint8Array(readFileSync(new URL('./fixtures/deflated.zip', import.meta.url))))).errors[0].code).toBe('compressed')
  })

  it('path traversal', async () => {
    const { bytes } = await build()
    const padded = repack(bytes, (f) => f.set('aa/evil.sh', enc.encode('rm -rf ~')))
    const at = Buffer.from(padded)
    let i = -1
    while ((i = at.indexOf('aa/evil.sh', i + 1)) >= 0) at.write('../evil.sh', i)
    const r = await openReviewBundle(new Uint8Array(at))
    expect(r.ok).toBe(false)
    expect(r.errors).toEqual([expect.objectContaining({ code: 'unsafe-path', file: '../evil.sh' })])
  })

  it('an unsupported version or format, with exact messages', async () => {
    const { bytes, manifest } = await build()
    const withManifest = (m) => repack(bytes, (f) => f.set(PATHS.manifest, enc.encode(JSON.stringify(m))))
    expect((await openReviewBundle(withManifest({ ...manifest, version: 2 }))).errors).toEqual([
      { code: 'version', message: 'Unsupported review bundle version 2; this Boxwire reads version 1.', file: PATHS.manifest },
    ])
    expect((await openReviewBundle(withManifest({ ...manifest, format: 'boxwire-critique' }))).errors).toEqual([
      { code: 'format', message: 'Not a Boxwire review bundle (format "boxwire-critique"); expected "boxwire-review-bundle".', file: PATHS.manifest },
    ])
    expect((await openReviewBundle(withManifest({ ...manifest, version: undefined }))).errors[0].message).toBe('Unsupported review bundle version missing; this Boxwire reads version 1.')
    const garbage = repack(bytes, (f) => f.set(PATHS.manifest, enc.encode('{ nope')))
    expect((await openReviewBundle(garbage)).errors[0].code).toBe('bad-manifest')
  })

  it('a missing results.json, manifest, or listed file', async () => {
    const { bytes } = await build()
    expect((await openReviewBundle(repack(bytes, (f) => f.delete(PATHS.results)))).errors).toEqual([
      { code: 'missing', message: 'Missing required file results.json.', file: PATHS.results },
    ])
    expect((await openReviewBundle(repack(bytes, (f) => f.delete(PATHS.manifest)))).errors[0].message).toBe('Missing required file manifest.json; this is not a Boxwire review bundle.')
    expect((await openReviewBundle(repack(bytes, (f) => f.delete(PATHS.proposalView)))).errors).toEqual([
      { code: 'missing', message: 'views/proposal.svg is listed in manifest.json but missing from the archive.', file: PATHS.proposalView },
    ])
  })

  it('a stale baseline', async () => {
    const { bytes } = await build()
    const edited = baseline.replace('Orders DB', 'Orders database')
    const stale = await openReviewBundle(bytes, { expectBaselineHash: await sourceHash(edited) })
    expect(stale.ok).toBe(false)
    expect(stale.errors).toHaveLength(1)
    expect(stale.errors[0].code).toBe('stale-baseline')
    expect(stale.errors[0].message).toMatch(/^Stale baseline: this review was made against baseline [0-9a-f]{12}…, but your current baseline is [0-9a-f]{12}…\./)
    expect((await openReviewBundle(bytes, { expectBaselineHash: await sourceHash(baseline) })).ok).toBe(true)
  })

  it('oversize archives', async () => {
    const { bytes } = await build()
    const r = await openReviewBundle(bytes, { limits: { totalBytes: 1000, entries: 500 } })
    expect(r.errors[0].code).toBe('too-large')
  })

  it('never throws on garbage', async () => {
    for (const b of [new Uint8Array(0), enc.encode('PK\x05\x06 not really'), null]) {
      const r = await openReviewBundle(b)
      expect(r.ok).toBe(false)
      expect(r.errors.length).toBeGreaterThan(0)
    }
  })

  it('warns about files the manifest does not list, and drops them', async () => {
    const { bytes } = await build()
    const r = await openReviewBundle(repack(bytes, (f) => f.set('notes.txt', enc.encode('hi'))))
    expect(r.ok).toBe(true)
    expect(r.warnings).toEqual([{ code: 'unlisted', message: 'notes.txt is not in the manifest and was ignored.', file: 'notes.txt' }])
    expect(r.files.has('notes.txt')).toBe(false)
  })
})

describe('recompute', () => {
  it('passes the bundled text and reproduces the same results', async () => {
    const { bytes } = await build()
    let seen
    const r = await openReviewBundle(bytes, { recompute: (files) => ((seen = files), structuredClone(results)) })
    expect(r.ok).toBe(true)
    expect(r.mismatches).toEqual([])
    expect(seen).toMatchObject({ baseline, proposal, rules, accepted: proposal })
  })

  it('lists every path where the recomputed results differ', async () => {
    const { bytes } = await build()
    const fresh = structuredClone(results)
    fresh.rules[0].witness = ['orders', 'pay', 'audit', 'orders']
    fresh.rules[2].status = 'pass'
    fresh.layout = []
    delete fresh.conflicts
    const r = await openReviewBundle(bytes, { recompute: async () => fresh })
    expect(r.ok).toBe(false)
    expect(r.errors).toEqual([])
    expect(r.mismatches.map((m) => m.path)).toEqual(['$.conflicts', '$.layout[0]', '$.rules[0].witness[2]', '$.rules[0].witness[3]', '$.rules[2].status'])
    expect(r.mismatches[4]).toEqual({ path: '$.rules[2].status', bundled: '"unknown"', recomputed: '"pass"' })
    expect(bundleSummary(r)).toMatch(/Recomputed checks differ from results\.json at 5 path\(s\):\n {2}\$\.conflicts:/)
  })

  it('reports a recompute that throws', async () => {
    const { bytes } = await build()
    const r = await openReviewBundle(bytes, { recompute: () => { throw new Error('parse error at 3:1') } })
    expect(r.errors).toEqual([{ code: 'recompute', message: 'Re-running the checks failed: parse error at 3:1.' }])
  })

  it('jsonMismatches quotes keys that are not identifiers', () => {
    expect(jsonMismatches({ 'a-b': 1 }, { 'a-b': 2 }).map((m) => m.path)).toEqual(['$["a-b"]'])
  })
})

describe('review.html', () => {
  it('is static, offline and embeds the data', async () => {
    const opened = await openReviewBundle((await build()).bytes)
    const html = htmlOf(opened)
    expect(html).not.toMatch(/https?:/i)
    expect(html).not.toMatch(/\/\/[a-z0-9.-]+\.[a-z]{2,}\//i) // no protocol-relative URLs either
    expect(html).not.toContain('fetch(')
    expect(html).not.toContain('innerHTML')
    expect(html).not.toMatch(/<link|<iframe|<object|<embed|@import|url\(/i)
    const data = dataOf(html)
    expect(data.baselineHash).toBe(opened.manifest.baselineHash)
    expect(data.proposalHash).toBe(opened.manifest.proposalHash)
    expect(data.note).toBe(opened.manifest.note)
    expect(data.semantic.items).toHaveLength(5)
    expect(data.layout.items).toHaveLength(1)
    expect(data.conflicts.items[0]).toMatchObject({ text: 'Both sides renamed orders.', detail: 'base Orders; ours Order API; proposal Order service' })
    expect(html).toContain('do not identify a reviewer and are not an approval')
    expect((html.match(/<img alt="[^"]+" src="data:image\/svg\+xml;base64,/g) ?? [])).toHaveLength(2)
  })

  it('shows witness paths and source ranges as line:col', async () => {
    const data = dataOf(htmlOf(await openReviewBundle((await build()).bytes)))
    const at = (o) => `${lineCol(proposal, o).line}:${lineCol(proposal, o).col}`
    expect(data.semantic.items[0]).toMatchObject({ text: 'add node pay', ranges: [`proposal ${at(395)}–${at(451)}`] })
    expect(data.semantic.items[0].ranges[0]).toBe('proposal 11:5–11:61')
    expect(data.semantic.items[1]).toMatchObject({ text: 'rename node orders', detail: 'Orders → Order service', ranges: ['proposal 10:51–10:66'] })
    expect(data.rules.items[0]).toMatchObject({ status: 'violation', rule: 'no-cycles v1', witness: 'orders → pay → orders', ranges: ['proposal 19:5–19:54'] })
    expect(data.rules.items[1]).toMatchObject({ witness: 'web → db', ranges: ['proposal 20:5–20:51'] })
  })

  it('pins its only script with a CSP hash and keeps data out of markup', async () => {
    const built = await buildReviewBundle(input({ name: 'x</script><script>alert(1)</script>', results: { semantic: [{ summary: '<img src=x onerror=alert(1)>' }] } }))
    const html = htmlOf(await openReviewBundle(built.bytes))
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
    expect(scripts).toHaveLength(1)
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1]
    expect(csp).toContain(`script-src 'sha256-${await sha256Base64(scripts[0])}'`)
    expect(csp).toMatch(/^default-src 'none'; img-src data:;/)
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('</script><script>alert')
    expect(dataOf(html).semantic.items[0].text).toBe('<img src=x onerror=alert(1)>')
    expect(scripts[0].split('\n').length).toBeLessThanOrEqual(150)
  })

  it('has a readable noscript summary, headings, tables and dark mode', async () => {
    const html = htmlOf(await openReviewBundle((await build()).bytes))
    const noscript = /<noscript><pre>([\s\S]*?)<\/pre><\/noscript>/.exec(html)[1]
    expect(noscript).toContain('Semantic changes (5)')
    expect(noscript).toContain('  - [violation] no-cycles v1 orders and pay call each other synchronously.')
    expect(noscript).toContain('    witness: orders → pay → orders')
    expect(noscript).toContain('Conflicts (1)')
    expect(html).toMatch(/<html lang="en">/)
    expect(html).toMatch(/<h1>Checkout: payments<\/h1>/)
    expect(html).toContain('@media (prefers-color-scheme: dark)')
    expect(html).toContain("h('caption'")
  })

  it('stays under 500 KB for a 20-node board', async () => {
    const kinds = ['web-client', 'api-gateway', 'service', 'cache', 'sql-database', 'message-queue', 'worker', 'object-storage', 'search-index', 'payments']
    const nodes = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, kind: kinds[i % kinds.length], label: `Node ${i} ${kinds[i % kinds.length]}` }))
    const edges = nodes.slice(1).map((n, i) => ({ from: `n${Math.floor(i / 2)}`, to: n.id, label: i % 3 ? undefined : 'reads' })).map((e) => JSON.parse(JSON.stringify(e)))
    const diagram = (extra) => ({ format: 'boxwire-diagram', version: 1, name: 'Twenty', nodes, edges: [...edges, ...extra] })
    const base = JSON.stringify(diagram([]), null, 2), prop = JSON.stringify(diagram([{ from: 'n19', to: 'n0' }]), null, 2)
    const big = { ...results, semantic: Array.from({ length: 40 }, (_, i) => ({ ...results.semantic[i % 5], id: `x${i}` })) }
    const r = await buildReviewBundle({ name: 'Twenty nodes', baseline: { source: base }, proposal: { source: prop }, rules, results: big, docs: { baseline: compile(base), proposal: compile(prop) }, renderSvg, createdAt: CREATED })
    expect(r.ok).toBe(true)
    const html = r.manifest.files.find((f) => f.path === PATHS.html)
    console.info(`20-node bundle: ${r.bytes.length} bytes zipped, review.html ${html.bytes} bytes`)
    expect(html.bytes).toBeLessThan(500 * 1024)
  })
})

describe('bundleSummary', () => {
  it('is plain text with untrusted control and bidi characters removed', async () => {
    const built = await build({ name: 'Check\u202eout\u0007 review' })
    const s = bundleSummary(await openReviewBundle(built.bytes))
    expect(s.split('\n')[0]).toBe('Bundle verified: structure and every SHA-256 match the manifest.')
    expect(s).toContain('Review: Checkout review')
    expect(s).toContain('Rule results (4)')
    expect(s).not.toMatch(/[\u202e<>]/)
    expect(s.includes('\u0007')).toBe(false)
  })

  it('lists errors for a refused bundle', async () => {
    const s = bundleSummary(await openReviewBundle(new Uint8Array(10)))
    expect(s).toBe('Bundle NOT verified.\nError: The archive is 10 bytes, too short to be a ZIP (an empty ZIP is 22 bytes).')
  })
})
