import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseSource } from './cst.js'
import { indexSource } from './index.js'
import { applyEdits, applySourceOps } from './edit.js'
import { naturalPositions, opsForChanges } from './sync.js'
import { compileDiagram } from '../author/compile.js'
import { NODE_KINDS } from '../author/vocabulary.js'
import { itemProps } from '../catalog.js'
import { fitNode, isContainer, makeEdge, makeNode } from '../core/elements.js'
import { applyChanges, createDocStore } from '../core/history.js'

// Acceptance 1 of the review slice: canvas operations on a commented source file become minimal
// source edits that preserve comments, formatting and ids, and compile to the board the canvas shows.

const FIXTURE = readFileSync(new URL('./fixtures/review-baseline.boxwire.jsonc', import.meta.url), 'utf8')
const measure = (s, font) => s.length * (parseFloat(/(\d+)px/.exec(font)?.[1] ?? 16) * 0.55)
const fit = (el) => fitNode(el, measure)

function load(text) {
  const r = parseSource(text)
  expect(r.errors).toEqual([])
  const c = compileDiagram(r.value, { measure })
  expect(c.errors).toEqual([])
  return { text, cst: r.cst, value: r.value, index: indexSource(r.cst, r.value), doc: c.doc, natural: naturalPositions(r.value, { measure }), measure }
}

/** One committed transaction on a store holding the compiled board, as the editor would make it. */
function transact(doc, edit) {
  const store = createDocStore({ base: doc })
  store.begin('edit')
  edit(store.doc, (id, el) => store.apply([[id, el]]))
  store.commit()
  return store.history.done.at(-1).changes
}

/** The canvas change → source ops → edited source → compiled board, for one transaction. */
function roundTrip(text, edit) {
  const a = load(text)
  const changes = transact(a.doc, edit)
  const sync = opsForChanges(changes, a)
  const out = applySourceOps(text, sync.ops)
  expect(out.error).toBeUndefined()
  expect(applyEdits(text, out.edits)).toBe(out.text)
  return { a, b: load(out.text), changes, sync, out }
}

// Drawing order (z) follows source order, and zone/frame geometry is derived from members on compile.
const semantic = (el) => {
  if (!el) return el
  const { z: _z, ...rest } = el
  return isContainer(el) ? { ...rest, x: 0, y: 0, w: 0, h: 0 } : rest
}
const semanticDoc = (doc) => Object.fromEntries(Object.keys(doc).sort().map((id) => [id, semantic(doc[id])]))

const comments = (text) => parseSource(text).cst.tokens.flatMap((t) => [...t.leading, ...t.trailing]).filter((t) => t.type === 'line' || t.type === 'block').map((t) => t.text)

/** Original lines no edit touches, checked byte for byte at their shifted place in the new text. */
function untouchedLines(text, next, edits) {
  let ok = 0, bad = 0, at = 0
  const lines = text.split('\n')
  for (const line of lines) {
    const ls = at, le = at + line.length
    at = le + 1
    const touched = edits.some((e) => (e.start <= le && e.end > ls) || (e.start === e.end && e.start >= ls && e.start <= le))
    if (touched) continue
    const shift = edits.filter((e) => e.end <= ls && !(e.start === e.end && e.start === ls)).reduce((s, e) => s + e.insert.length - (e.end - e.start), 0)
    if (next.slice(ls + shift, le + shift) === line) ok++
    else bad++
  }
  return { ok, bad, total: lines.length }
}

const node = (doc, id) => doc[id]
const moved = (el, dx, dy) => ({ ...el, x: el.x + dx, y: el.y + dy })

/** The canvas operations of the acceptance slice, plus a few more representative agent edits. */
const OPERATIONS = {
  'rename a node label': (doc, put) => put('checkout', fit({ ...node(doc, 'checkout'), text: 'Checkout service' })),
  'label a node that had none': (doc, put) => put('mobile', fit({ ...node(doc, 'mobile'), text: 'iOS app' })),
  'reconnect an edge': (doc, put) => put('e1', { ...doc.e1, to: { id: 'gw', side: 'w' } }),
  'drag a group (3 nodes)': (doc, put) => ['lb', 'gw', 'auth'].forEach((id) => put(id, moved(doc[id], 40, 20))),
  'change capacity': (doc, put) => put('checkout', { ...doc.checkout, cap: { ...doc.checkout.cap, replicas: 5 } }),
  'declare capacity on a new field': (doc, put) => put('worker', { ...doc.worker, cap: { replicas: 2 } }),
  'cross out': (doc, put) => put('legacy', { ...doc.legacy, crossed: true }),
  'set an owner (meta)': (doc, put) => put('orders', { ...doc.orders, meta: { ...doc.orders.meta, owner: 'payments-team' } }),
  'tighten a zone\'s trust': (doc, put) => put('core', { ...doc.core, trust: 'restricted' }),
  'mark an edge as read-only': (doc, put) => put('e2', { ...doc.e2, carries: 'reads' }),
  'add a node + edge': (doc, put) => {
    const item = NODE_KINDS['search-index']
    put('search', fit({ ...makeNode(item.shape, 1300, 400, { ...itemProps(item), text: 'Search' }), id: 'search' }))
    put('search-feed', { ...makeEdge({ id: 'catalog' }, { id: 'search' }, { text: 'index', carries: 'writes' }), id: 'search-feed' })
  },
  'delete a node (edges, zone and frame membership)': (doc, put) => {
    put('catalog', null)
    for (const e of Object.values(doc)) if (e.type === 'edge' && (e.from.id === 'catalog' || e.to.id === 'catalog')) put(e.id, null)
    put('core', { ...doc.core, members: ['checkout'] })
    put('f-read', { ...doc['f-read'], members: ['cache', 'products'] })
  },
}

describe('canvas operations become minimal source edits', () => {
  for (const [name, edit] of Object.entries(OPERATIONS)) {
    describe(name, () => {
      const { a, b, changes, sync, out } = roundTrip(FIXTURE, edit)

      it('is fully supported', () => expect(sync.unsupported).toEqual([]))

      it('compiles to the board the canvas shows (by id)', () => {
        expect(semanticDoc(b.doc)).toEqual(semanticDoc(applyChanges(a.doc, changes, 'after')))
      })

      it('keeps every surviving id and adds only the new ones', () => {
        const expected = applyChanges(a.doc, changes, 'after')
        expect(Object.keys(b.doc).sort()).toEqual(Object.keys(expected).sort())
        for (const id of Object.keys(a.doc)) if (b.doc[id] && !changes.some(([c]) => c === id) && !isContainer(a.doc[id])) expect(semantic(b.doc[id])).toEqual(semantic(a.doc[id]))
      })

      it('preserves comments and leaves untouched lines byte-identical', () => {
        const kept = comments(out.text)
        const lost = comments(FIXTURE).filter((c) => !kept.includes(c))
        // a removed item takes only the comments directly above it
        expect(lost).toEqual(name.startsWith('delete') ? ['// read path'] : [])
        expect(untouchedLines(FIXTURE, out.text, out.edits).bad).toBe(0)
      })
    })
  }
})

describe('undo restores the source', () => {
  const inverse = (changes) => [...changes].reverse().map(([id, before, after]) => [id, after, before])
  const undo = (name) => {
    const { b, changes, out } = roundTrip(FIXTURE, OPERATIONS[name])
    const sync = opsForChanges(inverse(changes), b)
    const back = applySourceOps(out.text, sync.ops)
    expect(back.error).toBeUndefined()
    return { back, sync, a: load(FIXTURE) }
  }

  // set and move operations come back byte for byte
  for (const name of ['rename a node label', 'label a node that had none', 'reconnect an edge', 'drag a group (3 nodes)', 'change capacity', 'declare capacity on a new field', 'cross out', 'set an owner (meta)', 'tighten a zone\'s trust', 'mark an edge as read-only']) {
    it(`byte for byte: ${name}`, () => expect(undo(name).back.text).toBe(FIXTURE))
  }

  // insert and remove come back semantically: a deleted item's comments, and ids pinned to keep them stable, stay as they are
  for (const name of ['add a node + edge', 'delete a node (edges, zone and frame membership)']) {
    it(`semantically: ${name}`, () => {
      const { back, sync, a } = undo(name)
      expect(sync.unsupported).toEqual([])
      expect(semanticDoc(load(back.text).doc)).toEqual(semanticDoc(a.doc))
      if (name.startsWith('add')) expect(back.text).toBe(FIXTURE)
    })
  }
})

describe('minimal-diff benchmark', () => {
  it('every representative edit touches a small fraction of the file and only its own lines', () => {
    const rows = []
    for (const [name, edit] of Object.entries(OPERATIONS)) {
      const { out } = roundTrip(FIXTURE, edit)
      const bytes = out.edits.reduce((s, e) => s + (e.end - e.start) + e.insert.length, 0)
      const lines = untouchedLines(FIXTURE, out.text, out.edits)
      const removed = lines.total - lines.ok
      const added = out.text.split('\n').length - lines.ok
      rows.push({ name, ops: out.edits.length, bytes, pct: (100 * bytes) / FIXTURE.length, removed, added, bad: lines.bad, total: lines.total })
    }
    const pad = (s, n) => String(s).padEnd(n)
    console.log([
      `minimal-diff benchmark: fixture ${FIXTURE.length} bytes, ${FIXTURE.split('\n').length} lines`,
      `${pad('edit', 50)} ${pad('edits', 6)} ${pad('bytes', 6)} ${pad('% file', 7)} lines -/+`,
      ...rows.map((r) => `${pad(r.name, 50)} ${pad(r.ops, 6)} ${pad(r.bytes, 6)} ${pad(r.pct.toFixed(2), 7)} -${r.removed}/+${r.added}`),
    ].join('\n'))
    for (const r of rows) {
      expect(r.bad, r.name).toBe(0)
      // Value and move edits stay under 2% of this 3.8 KB file. Adding or deleting an entity writes or removes that
      // entity's own text (a deletion also takes its three edges and their comment, and pins the edge ids that would shift).
      expect(r.pct, r.name).toBeLessThan(/^(add|delete)/.test(r.name) ? 10 : 2)
      // a whole-file rewrite would touch every line; these touch only the lines of what they change
      expect(r.removed, r.name).toBeLessThan(r.total / 5)
    }
  })
})

describe('positions in auto layout', () => {
  const text = '{\n  "format": "boxwire-diagram",\n  "version": 1,\n  // auto layout; drags pin nodes\n  "nodes": [\n    { "id": "a", "kind": "service" },\n    { "id": "b", "kind": "sql-database" },\n    { "id": "c", "kind": "cache" }\n  ],\n  "edges": [{ "from": "a", "to": "b" }, { "from": "a", "to": "c" }]\n}\n'

  it('a drag pins only the dragged node, and dragging it back home unpins it', () => {
    const { a, b, changes, out } = roundTrip(text, (doc, put) => put('b', moved(doc.b, 0, 200)))
    expect(out.text).toContain('  "positions": {\n')
    expect(b.doc.b).toMatchObject({ x: a.doc.b.x, y: a.doc.b.y + 200 })
    expect(b.doc.a).toEqual(a.doc.a)
    expect(b.doc.c).toEqual(a.doc.c)
    const back = applySourceOps(out.text, opsForChanges(changes.map(([id, x, y]) => [id, y, x]), b).ops)
    expect(back.text).toBe(text)
  })
})

describe('what cannot be written back is reported, never rewritten', () => {
  const a = load(FIXTURE)
  const report = (edit) => opsForChanges(transact(a.doc, edit), a)

  it('drawing order, outline width, anchor offsets', () => {
    const r = report((doc, put) => {
      put('gw', { ...doc.gw, z: 999, stroke: 4 })
      put('e1', { ...doc.e1, to: { ...doc.e1.to, t: 0.3 } })
    })
    expect(r.ops).toEqual([])
    expect(r.unsupported.map((u) => u.id).sort()).toEqual(['e1', 'gw', 'gw'])
  })

  it('UML text that no longer fits its compartments', () => {
    const uml = load('{ "format": "boxwire-diagram", "version": 1, "nodes": [{ "id": "c", "kind": "class", "name": "Order", "attributes": ["- id: UUID"] }] }')
    const ok = opsForChanges(transact(uml.doc, (doc, put) => put('c', fit({ ...doc.c, text: 'Order\n---\n- id: UUID\n- total: Money\n---\n+ pay(): void' }))), uml)
    expect(ok.unsupported).toEqual([])
    const next = applySourceOps(uml.text, ok.ops).text
    expect(parseSource(next).value.nodes[0]).toEqual({ id: 'c', kind: 'class', name: 'Order', attributes: ['- id: UUID', '- total: Money'], methods: ['+ pay(): void'] })
    const bad = opsForChanges(transact(uml.doc, (doc, put) => put('c', { ...doc.c, text: 'Order' })), uml)
    expect(bad.ops).toEqual([])
    expect(bad.unsupported).toEqual([{ id: 'c', reason: expect.stringMatching(/compartments/) }])
  })

  it('table columns keep their written style', () => {
    const t = load('{ "format": "boxwire-diagram", "version": 1, "nodes": [{ "id": "t", "kind": "table", "name": "users", "columns": ["id uuid PK", { "name": "email", "type": "text" }] }] }')
    const r = opsForChanges(transact(t.doc, (doc, put) => put('t', fit({ ...doc.t, text: 'users\n---\nid uuid PK\nemail text UQ' }))), t)
    const next = applySourceOps(t.text, r.ops).text
    expect(parseSource(next).value.nodes[0].columns).toEqual(['id uuid PK', { name: 'email', type: 'text', key: 'UQ' }])
  })

  it('canvas ids the format rejects, and elements the source does not have', () => {
    const r = report((doc, put) => {
      put('3abc', { ...makeNode('rect', 0, 0, { kind: 'box' }), id: '3abc' })
      put('s9', { id: 's9', type: 'stroke', x: 0, y: 0, w: 10, h: 10, pw: 10, ph: 10, pts: [0, 0, 10, 10], z: 0, color: 'red', stroke: 3 })
    })
    expect(r.ops).toEqual([])
    expect(r.unsupported.map((u) => u.id)).toEqual(['3abc', 's9'])
  })

  it('zone and frame geometry is derived, so moving one needs no edit', () => {
    const r = report((doc, put) => put('data', moved(doc.data, 10, 10)))
    expect(r).toEqual({ ops: [], unsupported: [], derived: ['data'] })
  })

  it('reordering frames moves them in the array', () => {
    const { b, out } = roundTrip(FIXTURE, (doc, put) => {
      put('f-read', { ...doc['f-read'], order: 1 })
      put('f-write', { ...doc['f-write'], order: 2 })
    })
    expect(b.doc['f-read'].order).toBe(1)
    // the slide's line moves up; the old last line drops its comma
    expect(out.edits.length).toBe(3)
  })
})
