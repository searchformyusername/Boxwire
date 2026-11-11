import { describe, expect, it } from 'vitest'
import { diagramPaste, parseImport } from './import.js'
import { createEditor } from '../editor/editor.js'
import { validateBoard } from '../core/validate.js'
import { makeNode } from '../core/elements.js'

const measure = (s) => s.length * 8
const diagram = { format: 'boxwire-diagram', version: 1, nodes: [{ id: 'a', kind: 'service' }, { id: 'b', kind: 'cache' }], edges: [{ from: 'a', to: 'b' }] }

describe('diagramPaste', () => {
  it('compiles an authored diagram into a clipboard payload', () => {
    const r = diagramPaste(JSON.stringify(diagram), { measure })
    expect(r.errors).toEqual([])
    expect(JSON.parse(r.clipboard).elements).toHaveLength(3)
  })

  it('reports malformed JSON that is recognisably an authored diagram (regression)', () => {
    const r = diagramPaste('{"format":"boxwire-diagram","version":1,"nodes":[{"id":"a","kind":"box"}]', { measure })
    expect(r.kind).toBe('diagram')
    expect(r.errors[0].message).toMatch(/isn't valid JSON/)
  })

  it('recognises the marker even far into the text', () => {
    const r = diagramPaste(`{"name":"${'x'.repeat(10000)}","format":"boxwire-diagram"`, { measure })
    expect(r?.errors.length).toBe(1)
  })

  it('leaves ordinary text and other JSON to the normal paste path', () => {
    expect(diagramPaste('hello world', { measure })).toBeNull()
    expect(diagramPaste('{"a":1}', { measure })).toBeNull()
    expect(diagramPaste('{"boxwire":1,"elements":[]}', { measure })).toBeNull()
    expect(diagramPaste('the format "boxwire-diagram" is documented', { measure })).toBeNull()
  })

  it('rejects oversized authored input before parsing it', () => {
    const big = `{"format":"boxwire-diagram","pad":"${'x'.repeat(5 * 1024 * 1024)}"}`
    const t = performance.now()
    const r = diagramPaste(big, { measure })
    expect(r.errors[0].message).toMatch(/limited to/)
    expect(performance.now() - t).toBeLessThan(100)
  })
})

describe('parseImport', () => {
  it('routes runtime board files and authored diagrams to the right parser', () => {
    expect(parseImport(JSON.stringify(diagram), { measure }).kind).toBe('diagram')
    expect(parseImport('{"format":"boxwire","version":1,"board":{"doc":{}}}').kind).toBe('board')
    expect(parseImport('not json').errors[0].message).toMatch(/valid JSON/)
  })
})

describe('paste never makes a board unreopenable (regression)', () => {
  const nodes = (n, x = 0) => Array.from({ length: n }, (_, i) => ({ ...makeNode('rect', x + (i % 70) * 200, Math.floor(i / 70) * 100), id: `n${i}` }))
  const payload = (els) => JSON.stringify({ boxwire: 1, elements: els })

  it('rejects a paste that would take the board past the element limit, changing nothing', () => {
    const ed = createEditor({ measure })
    ed.store.set('keep', { ...makeNode('rect', 0, 0), id: 'keep' })
    ed.select(['keep'])
    const before = { doc: ed.doc, done: ed.store.history.done.length }
    expect(ed.pasteJSON(payload(nodes(5000)), { x: 0, y: 0 })).toBe(true)
    expect(ed.doc).toBe(before.doc)
    expect(ed.store.history.done.length).toBe(before.done)
    expect(ed.ui.selection).toEqual(['keep'])
    expect(ed.ui.toast.message).toMatch(/5000/)
  })

  it('accepts a paste that exactly fills the board, and the result reopens', () => {
    const ed = createEditor({ measure })
    ed.store.set('keep', { ...makeNode('rect', 0, 0), id: 'keep' })
    ed.pasteJSON(payload(nodes(4999)), { x: 0, y: 0 })
    expect(Object.keys(ed.doc)).toHaveLength(5000)
    expect(validateBoard({ ...ed.store.history, doc: ed.doc }).error).toBeUndefined()
    expect(ed.addNode('rect', { x: 0, y: 0 })).toBeNull() // the ceiling also holds for single additions
  })

  it('rejects a paste whose placement would push coordinates out of bounds', () => {
    const ed = createEditor({ measure })
    const before = ed.doc
    ed.pasteJSON(payload(nodes(2)), { x: 1e6 + 500, y: 0 })
    expect(ed.doc).toBe(before)
    expect(ed.ui.toast.kind).toBe('error')
  })
})
