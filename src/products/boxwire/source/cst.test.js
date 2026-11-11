import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { SOURCE_LIMITS, parseSource, printCst } from './cst.js'
import { indexSource } from './index.js'
import { compileDiagram } from '../author/compile.js'

const FIXTURE = readFileSync(new URL('./fixtures/review-baseline.boxwire.jsonc', import.meta.url), 'utf8')
const dir = (rel) => new URL(rel, import.meta.url)
const filesIn = (rel) => readdirSync(dir(rel)).filter((f) => f.endsWith('.json')).map((f) => [rel + f, readFileSync(new URL(f, dir(rel)), 'utf8')])
const SOURCES = [['fixture', FIXTURE], ...filesIn('../../../../public/products/boxwire/examples/'), ...filesIn('../problems/solutions/')]
const measure = (s, font) => s.length * (parseFloat(/(\d+)px/.exec(font)?.[1] ?? 16) * 0.55)

describe('print(parse(x)) === x', () => {
  for (const [name, text] of SOURCES) {
    it(name, () => {
      const r = parseSource(text)
      expect(r.errors).toEqual([])
      expect(printCst(r.cst)).toBe(text)
      if (name !== 'fixture') expect(r.value).toEqual(JSON.parse(text))
    })
  }

  it('keeps odd but valid trivia: CRLF, tabs, BOM, comments everywhere, trailing commas', () => {
    const text = '\uFEFF/* head */{\r\n\t"a" /* k */ : [1, 2, /* in */ 3,], // tail\r\n\t"b": { "c": null, },\r\n}\r\n// end'
    const r = parseSource(text)
    expect(r.errors).toEqual([])
    expect(printCst(r.cst)).toBe(text)
    expect(r.value).toEqual({ a: [1, 2, 3], b: { c: null } })
  })

  it('attaches same-line trivia as trailing and the rest as leading', () => {
    const r = parseSource('{\n  "a": 1, // one\n  // two\n  "b": 2\n}')
    const [a, b] = r.cst.root.members
    expect(a.comma.trailing.map((t) => t.text)).toEqual([' ', '// one'])
    expect(b.key.leading.map((t) => t.type)).toEqual(['newline', 'ws', 'line', 'newline', 'ws'])
    expect(b.key).toMatchObject({ line: 4, col: 3 })
  })
})

describe('the fixture', () => {
  const r = parseSource(FIXTURE)
  it('has line and block comments, a trusted zone, meta, positions and at least 12 nodes', () => {
    const trivia = r.cst.tokens.flatMap((t) => [...t.leading, ...t.trailing])
    expect(trivia.some((t) => t.type === 'line')).toBe(true)
    expect(trivia.some((t) => t.type === 'block')).toBe(true)
    expect(r.value.nodes.length).toBeGreaterThanOrEqual(12)
    expect(r.value.zones.some((z) => z.trust)).toBe(true)
    expect(r.value.nodes.some((n) => n.meta)).toBe(true)
    expect(Object.keys(r.value.positions).length).toBeGreaterThan(0)
  })
  it('compiles cleanly', () => {
    const c = compileDiagram(r.value, { measure })
    expect(c.errors).toEqual([])
    expect(c.warnings).toEqual([])
    expect(c.doc.gw).toMatchObject({ x: 520, y: 240, w: 200 })
    expect(c.doc.data).toMatchObject({ trust: 'sensitive', members: ['cache', 'events', 'orders', 'products'] })
  })
})

describe('parse errors carry a position and never throw', () => {
  const err = (text) => {
    const r = parseSource(text)
    expect(r.value).toBeNull()
    expect(r.cst).toBeNull()
    expect(r.errors).toHaveLength(1)
    return r.errors[0]
  }
  it('unterminated string', () => {
    expect(err('{\n  "a": "open\n}')).toMatchObject({ line: 2, col: 8, start: 9, message: expect.stringMatching(/Unterminated string/) })
    expect(err('{ "a": "open')).toMatchObject({ line: 1, col: 8 })
  })
  it('bad commas', () => {
    expect(err('[1,,2]')).toMatchObject({ col: 4, message: expect.stringMatching(/Unexpected ","/) })
    expect(err('[,1]')).toMatchObject({ col: 2 })
    expect(err('{ "a": 1 "b": 2 }')).toMatchObject({ col: 10, message: expect.stringMatching(/Expected "," or "}"/) })
    expect(err('{ , }')).toMatchObject({ col: 3 })
    expect(err('[1 2]')).toMatchObject({ col: 4 })
  })
  it('duplicate key, reported at the second key', () => {
    expect(err('{\n  "id": "a",\n  "id": "b"\n}')).toMatchObject({ line: 3, col: 3, start: 17, end: 21, message: 'Duplicate key "id".' })
  })
  it('depth beyond the limit', () => {
    const deep = '['.repeat(SOURCE_LIMITS.depth + 1) + ']'.repeat(SOURCE_LIMITS.depth + 1)
    expect(err(deep)).toMatchObject({ col: SOURCE_LIMITS.depth + 1, message: expect.stringMatching(/deeper than 64/) })
    const ok = '['.repeat(SOURCE_LIMITS.depth) + ']'.repeat(SOURCE_LIMITS.depth)
    expect(parseSource(ok).errors).toEqual([])
  })
  it('size and token limits', () => {
    expect(err(' '.repeat(SOURCE_LIMITS.bytes + 1)).message).toMatch(/5 MB/)
    expect(err('[' + '0,'.repeat(SOURCE_LIMITS.tokens) + '0]').message).toMatch(/200000 tokens/)
  })
  it('everything else JSON forbids', () => {
    expect(err("{ 'a': 1 }").message).toMatch(/double quotes/)
    expect(err('{ a: 1 }').message).toMatch(/Keys must be double-quoted/)
    expect(err('[NaN]').message).toMatch(/Unexpected "NaN"/)
    expect(err('[01]').message).toMatch(/Invalid number/)
    expect(err('["\\x"]').message).toMatch(/Bad escape/)
    expect(err('[1] /* open').message).toMatch(/Unterminated block comment/)
    expect(err('{} {}').message).toMatch(/after the end/)
    expect(err('  // only a comment').message).toMatch(/empty/)
    expect(err('["a\u0001"]').message).toMatch(/Control characters/)
    expect(parseSource(42).errors[0].message).toMatch(/text/)
  })
  it('keeps "__proto__" as an own key, like JSON.parse', () => {
    const r = parseSource('{ "__proto__": { "x": 1 } }')
    expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype)
    expect(Object.hasOwn(r.value, '__proto__')).toBe(true)
    expect(r.value).toEqual(JSON.parse('{ "__proto__": { "x": 1 } }'))
  })
})

describe('index: stable ids → spans', () => {
  const r = parseSource(FIXTURE)
  const index = indexSource(r.cst, r.value)
  const slice = (s) => FIXTURE.slice(s.start, s.end)

  it('finds nodes, zones, frames and their (nested) fields by id', () => {
    expect(slice(index.spanOf({ entity: 'node', id: 'checkout', field: 'label' }))).toBe('"Checkout API"')
    expect(slice(index.spanOf({ entity: 'node', id: 'checkout', field: 'capacity.replicas' }))).toBe('3')
    expect(slice(index.spanOf({ entity: 'node', id: 'checkout', field: ['meta', 'owner'] }))).toBe('"payments-team"')
    expect(slice(index.spanOf({ entity: 'zone', id: 'data', field: 'trust' }))).toBe('"sensitive"')
    expect(slice(index.spanOf({ entity: 'frame', id: 'f-read', field: ['contains', 1] }))).toBe('"cache"')
    expect(slice(index.spanOf({ entity: 'node', id: 'mobile' }))).toBe('{ "id": "mobile", "kind": "mobile-app", "x": 0, "y": 320 }')
    expect(index.spanOf({ entity: 'node', id: 'mobile', field: 'label' })).toBeNull()
    expect(index.spanOf({ entity: 'node', id: 'nope' })).toBeNull()
  })

  it('gives line/column ranges', () => {
    const s = index.spanOf({ entity: 'node', id: 'checkout' })
    expect(s.endLine - s.line).toBe(8)
    expect(FIXTURE.split('\n')[s.line - 1].slice(s.col - 1)).toBe('{')
  })

  it('knows edges by the compiler\'s ids, explicit or generated', () => {
    const doc = compileDiagram(r.value, { measure }).doc
    const edgeIds = Object.values(doc).filter((e) => e.type === 'edge').map((e) => e.id).sort()
    expect(index.ids('edge').sort()).toEqual(edgeIds)
    expect(index.edgeIdAt(0)).toBe('e1')
    expect(index.edgeIdAt(9)).toBe('placed')
    expect(index.edgeIdAt(10)).toBe('e10')
    expect(slice(index.spanOf({ entity: 'edge', id: 'e10', field: 'from' }))).toBe('"events"')
    expect(doc.e10.from.id).toBe('events')
  })

  it('maps position entries and compiler diagnostic paths', () => {
    expect(slice(index.spanOf({ entity: 'position', id: 'gw' }))).toBe('"gw": { "x": 520, "y": 240, "w": 200 }')
    expect(slice(index.spanOf({ entity: 'position', id: 'gw', field: 'w' }))).toBe('200')
    expect(slice(index.spanAtPath('nodes[7].label'))).toBe('"Catalog API"')
    // a missing field maps to its nearest ancestor
    const near = index.spanAtPath('nodes[1].label')
    expect(near.exact).toBe(false)
    expect(slice(near)).toBe('{ "id": "mobile", "kind": "mobile-app", "x": 0, "y": 320 }')
  })
})
