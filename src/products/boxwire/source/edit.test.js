import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { applyEdits, applySourceOps } from './edit.js'
import { parseSource } from './cst.js'
import { assignIds, compileDiagram } from '../author/compile.js'
import { diffModels, isPin, summarise } from '../change/diff.js'

const FIXTURE = readFileSync(new URL('./fixtures/review-baseline.boxwire.jsonc', import.meta.url), 'utf8')
const measure = (s, font) => s.length * (parseFloat(/(\d+)px/.exec(font)?.[1] ?? 16) * 0.55)
const run = (text, ...ops) => {
  const r = applySourceOps(text, ops)
  if (r.error) throw new Error(r.error)
  expect(applyEdits(text, r.edits)).toBe(r.text)
  return r.text
}

describe('set', () => {
  it('replaces a value in place, and nothing else', () => {
    const r = applySourceOps(FIXTURE, [{ op: 'set', entity: 'zone', id: 'data', path: ['trust'], value: 'restricted' }])
    expect(r.edits).toEqual([{ start: FIXTURE.indexOf('"sensitive"'), end: FIXTURE.indexOf('"sensitive"') + 11, insert: '"restricted"' }])
  })

  it('is a no-op when the value is already there', () => {
    expect(applySourceOps(FIXTURE, [{ op: 'set', entity: 'node', id: 'gw', path: ['label'], value: 'API gateway' }])).toEqual({ text: FIXTURE, edits: [], pinned: [] })
  })

  it('creates intermediate objects and removes what it is told to', () => {
    const text = '{ "nodes": [{ "id": "a", "kind": "box" }] }'
    const added = run(text, { op: 'set', entity: 'node', id: 'a', path: ['meta', 'owner'], value: 'core' })
    expect(added).toBe('{ "nodes": [{ "id": "a", "kind": "box", "meta": { "owner": "core" } }] }')
    expect(run(added, { op: 'set', entity: 'node', id: 'a', path: ['meta'], value: undefined })).toBe(text)
  })

  it('adds a member on its own line in a multi-line object, keeping the trailing comma style', () => {
    const out = run(FIXTURE, { op: 'set', entity: 'node', id: 'checkout', path: ['crossed'], value: true })
    expect(out).toContain('      "meta": { "owner": "payments-team", "tier": "1" },\n      "crossed": true,\n    },')
  })

  it('edits array elements by index inside an entity', () => {
    const out = run(FIXTURE, { op: 'set', entity: 'frame', id: 'f-read', path: ['contains', 1], value: 'orders' })
    expect(out).toContain('"contains": ["catalog", "orders", "products"]')
  })

  it('refuses ids, unknown entities and non-JSON values', () => {
    expect(applySourceOps(FIXTURE, [{ op: 'set', entity: 'node', id: 'gw', path: ['id'], value: 'x' }]).error).toMatch(/identity/)
    expect(applySourceOps(FIXTURE, [{ op: 'set', entity: 'node', id: 'nope', path: ['label'], value: 'x' }]).error).toMatch(/unknown node "nope"/)
    expect(applySourceOps(FIXTURE, [{ op: 'set', entity: 'node', id: 'gw', path: ['w'], value: NaN }]).error).toMatch(/JSON/)
    expect(applySourceOps(FIXTURE, [{ op: 'set', entity: 'node', id: 'gw', path: ['label', 'x'], value: 1 }]).error).toMatch(/not an object/)
    expect(applySourceOps('{ "a": ', []).error).toMatch(/^1:8: /)
  })
})

describe('insert and remove are inverse, inline and multi-line', () => {
  it.each([
    ['inline siblings', '{ "nodes": [{ "id": "a", "kind": "box" }, { "id": "b", "kind": "box" }] }'],
    ['inline siblings, trailing comma', '{ "nodes": [{ "id": "a", "kind": "box" }, { "id": "b", "kind": "box" },] }'],
    ['one per line', '{\n  "nodes": [\n    { "id": "a", "kind": "box" },\n    { "id": "b", "kind": "box" }\n  ]\n}\n'],
    ['one per line, trailing comma', '{\n  "nodes": [\n    { "id": "a", "kind": "box" },\n    { "id": "b", "kind": "box" },\n  ],\n}\n'],
    ['block objects', '{\n  "nodes": [\n    {\n      "id": "a",\n      "kind": "box"\n    }\n  ]\n}\n'],
    ['tabs and CRLF', '{\r\n\t"nodes": [\r\n\t\t{ "id": "a", "kind": "box" } // first\r\n\t]\r\n}\r\n'],
  ])('%s', (_, text) => {
    const added = run(text, { op: 'insert', entity: 'node', value: { id: 'c', kind: 'service', label: 'C' } })
    expect(parseSource(added).value.nodes.map((n) => n.id)).toEqual([...parseSource(text).value.nodes.map((n) => n.id), 'c'])
    expect(run(added, { op: 'remove', entity: 'node', id: 'c' })).toBe(text)
  })

  it('writes new items in their siblings\' style', () => {
    expect(run('{\n  "nodes": [\n    { "id": "a", "kind": "box" }\n  ]\n}', { op: 'insert', entity: 'node', value: { id: 'b', kind: 'box' } }))
      .toBe('{\n  "nodes": [\n    { "id": "a", "kind": "box" },\n    { "id": "b", "kind": "box" }\n  ]\n}')
    expect(run('{\n  "nodes": [\n    {\n      "id": "a"\n    }\n  ]\n}', { op: 'insert', entity: 'node', value: { id: 'b', kind: 'box' } }))
      .toBe('{\n  "nodes": [\n    {\n      "id": "a"\n    },\n    {\n      "id": "b",\n      "kind": "box"\n    }\n  ]\n}')
    expect(run('{\r\n\t"nodes": [\r\n\t\t{ "id": "a" }\r\n\t]\r\n}', { op: 'insert', entity: 'zone', value: { id: 'z', contains: ['a'] } }))
      .toBe('{\r\n\t"nodes": [\r\n\t\t{ "id": "a" }\r\n\t],\r\n\t"zones": [\r\n\t\t{ "id": "z", "contains": ["a"] }\r\n\t]\r\n}')
  })

  it('inserts after a named sibling', () => {
    const out = run(FIXTURE, { op: 'insert', entity: 'node', after: 'mobile', value: { id: 'tv', kind: 'web-client', x: 0, y: 480 } })
    expect(out).toContain('"y": 320 },\n    { "id": "tv", "kind": "web-client", "x": 0, "y": 480 },\n\n    // Edge tier')
  })

  it('refuses a duplicate id', () => {
    expect(applySourceOps(FIXTURE, [{ op: 'insert', entity: 'zone', value: { id: 'gw', contains: ['lb'] } }]).error).toMatch(/already used/)
  })
})

describe('remove', () => {
  it('takes the comments directly above an item with it, and keeps the rest', () => {
    const text = '{\n  "nodes": [\n    // section\n\n    // about a\n    { "id": "a" }, // trailing a\n    { "id": "b" }\n  ]\n}'
    expect(run(text, { op: 'remove', entity: 'node', id: 'a' })).toBe('{\n  "nodes": [\n    // section\n\n    { "id": "b" }\n  ]\n}')
  })

  it('cascades: edges, contains entries, emptied zones and frames, the positions entry', () => {
    const out = run(FIXTURE, { op: 'remove', entity: 'node', id: 'cdn' })
    const v = parseSource(out).value
    expect(v.nodes.some((n) => n.id === 'cdn')).toBe(false)
    expect(v.edges.some((e) => e.from === 'cdn' || e.to === 'cdn')).toBe(false)
    expect(v.zones.find((z) => z.id === 'edge').contains).toEqual(['lb'])
    expect(Object.keys(v.positions)).toEqual(['lb', 'gw'])
    const both = run(out, { op: 'remove', entity: 'node', id: 'lb' })
    expect(parseSource(both).value.zones.map((z) => z.id)).toEqual(['core', 'data'])
    expect(compileDiagram(parseSource(both).value, { measure }).errors).toEqual([])
  })

  it('removes the positions block with its last entry', () => {
    let text = FIXTURE
    for (const id of ['cdn', 'lb', 'gw']) text = run(text, { op: 'remove', entity: 'position', id })
    expect(parseSource(text).value.positions).toBeUndefined()
    // the block goes with the comment directly above it; the frames lose nothing but their comma
    expect(text).not.toContain('// Layout pins')
    expect(text.endsWith('"contains": ["catalog", "cache", "products"] }\n  ]\n}\n')).toBe(true)
  })

  it('writes the id of every later id-less edge whose generated id would shift', () => {
    const before = assignIds(parseSource(FIXTURE).value).edges
    const out = run(FIXTURE, { op: 'remove', entity: 'edge', id: 'e2' })
    const after = assignIds(parseSource(out).value).edges
    expect(after).toEqual(before.filter((id) => id !== 'e2'))
    expect(out).toContain('{ "id": "e3", "from": "mobile", "to": "lb" }')
    // ids that do not move are left alone
    expect(out).toContain('{ "from": "web", "to": "cdn", "label": "static" },')
    expect(out).toContain('{ "id": "e13", "from": "catalog"')
  })

  it('never pins when removing the last id-less edge', () => {
    const r = applySourceOps(FIXTURE, [{ op: 'remove', entity: 'edge', id: 'e13' }])
    expect(r.edits).toHaveLength(1)
    expect(r.pinned).toEqual([])
  })

  it('reports every id it wrote down, and the diff classes them as identity, never layout', () => {
    const r = applySourceOps(FIXTURE, [{ op: 'remove', entity: 'edge', id: 'e2' }])
    expect(r.pinned.length).toBeGreaterThan(0)
    expect(r.pinned).toContain('e3')
    const d = diffModels(parseSource(FIXTURE).value, parseSource(r.text).value)
    expect(d.layout).toEqual([])
    expect(d.presentation).toEqual([])
    expect(d.semantic.map((c) => c.type)).toEqual(['remove'])
    expect(d.identity.map((c) => c.after).sort()).toEqual([...r.pinned].sort())
    expect(d.identity.every(isPin)).toBe(true)
    expect(summarise(d.identity)[0]).toMatch(/^Wrote down .* generated id “e\d+” \(same id\)$/)
  })

  it('pins on request with an explicit op, and leaves an edge that has an id alone', () => {
    const r = applySourceOps(FIXTURE, [{ op: 'pin', entity: 'edge', id: 'e3' }])
    expect(r.pinned).toEqual(['e3'])
    expect(r.text).toContain('{ "id": "e3", "from": "mobile", "to": "lb" }')
    expect(assignIds(parseSource(r.text).value).edges).toEqual(assignIds(parseSource(FIXTURE).value).edges)
    const again = applySourceOps(r.text, [{ op: 'pin', entity: 'edge', id: 'e3' }])
    expect(again).toEqual({ text: r.text, edits: [], pinned: [] })
    expect(applySourceOps(FIXTURE, [{ op: 'pin', entity: 'node', id: 'gw' }]).error).toMatch(/only edges/)
  })
})

describe('setPosition', () => {
  it('updates an existing entry in place', () => {
    const r = applySourceOps(FIXTURE, [{ op: 'setPosition', id: 'lb', x: 300, y: 240 }])
    expect(r.edits).toEqual([{ start: FIXTURE.indexOf('260, "y": 240 }'), end: FIXTURE.indexOf('260, "y": 240 }') + 3, insert: '300' }])
  })

  it('creates the block as a trailing top-level member, and removing the entry removes it again', () => {
    const text = '{\n  "format": "boxwire-diagram",\n  "nodes": [{ "id": "a", "kind": "box" }]\n}\n'
    const out = run(text, { op: 'setPosition', id: 'a', x: 10, y: 20, w: 200 })
    expect(out).toBe('{\n  "format": "boxwire-diagram",\n  "nodes": [{ "id": "a", "kind": "box" }],\n  "positions": {\n    "a": { "x": 10, "y": 20, "w": 200 }\n  }\n}\n')
    expect(run(out, { op: 'remove', entity: 'position', id: 'a' })).toBe(text)
  })

  it('refuses unknown nodes and missing coordinates', () => {
    expect(applySourceOps(FIXTURE, [{ op: 'setPosition', id: 'data', x: 1, y: 1 }]).error).toMatch(/unknown node "data"/)
    expect(applySourceOps(FIXTURE, [{ op: 'setPosition', id: 'gw', x: 1 }]).error).toMatch(/x and y/)
  })
})

describe('move', () => {
  it('reorders frames with their comments, and back', () => {
    const text = '{\n  "frames": [\n    { "id": "a", "contains": ["n"] },\n    // the read path\n    { "id": "b", "contains": ["n"] }\n  ]\n}'
    const moved = run(text, { op: 'move', entity: 'frame', id: 'b', after: null })
    expect(moved).toBe('{\n  "frames": [\n    // the read path\n    { "id": "b", "contains": ["n"] },\n    { "id": "a", "contains": ["n"] }\n  ]\n}')
    expect(run(moved, { op: 'move', entity: 'frame', id: 'b', after: 'a' })).toBe(text)
  })
})

describe('the edit log', () => {
  it('is relative to the original text even when later ops edit earlier insertions', () => {
    const r = applySourceOps(FIXTURE, [
      { op: 'insert', entity: 'node', value: { id: 'search', kind: 'search-index' } },
      { op: 'set', entity: 'node', id: 'search', path: ['label'], value: 'Search' },
      { op: 'setPosition', id: 'search', x: 1300, y: 400 },
      { op: 'set', entity: 'node', id: 'web', path: ['label'], value: 'Shop' },
    ])
    expect(applyEdits(FIXTURE, r.edits)).toBe(r.text)
    expect(r.edits.map((e) => e.insert)).toEqual(['"Shop"', ',\n    { "id": "search", "kind": "search-index", "label": "Search" }', ',\n    "search": { "x": 1300, "y": 400 }'])
    for (let i = 1; i < r.edits.length; i++) expect(r.edits[i].start).toBeGreaterThanOrEqual(r.edits[i - 1].end)
  })

  it('drops edits that cancel out', () => {
    const r = applySourceOps(FIXTURE, [
      { op: 'set', entity: 'node', id: 'web', path: ['label'], value: 'Shop' },
      { op: 'set', entity: 'node', id: 'web', path: ['label'], value: 'Storefront' },
    ])
    expect(r).toEqual({ text: FIXTURE, edits: [], pinned: [] })
  })
})
