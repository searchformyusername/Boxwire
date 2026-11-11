import { describe, expect, it } from 'vitest'
import { elementProblem, parseBoardFile, validateBoard } from './validate.js'
import { createDocStore, fold } from './history.js'
import { makeEdge, makeNode, makeStroke } from './elements.js'
import { createEditor } from '../editor/editor.js'

const nodeA = { ...makeNode('rect', 0, 0), id: 'a' }

describe('elementProblem', () => {
  it('accepts what the editor makes', () => {
    expect(elementProblem(nodeA)).toBeNull()
    expect(elementProblem({ ...makeEdge({ id: 'a' }, { x: 1, y: 2 }), id: 'e' })).toBeNull()
    expect(elementProblem(makeStroke([{ x: 0, y: 0 }, { x: 5, y: 9 }]))).toBeNull()
  })

  it('rejects inherited shape names and missing render fields (regression)', () => {
    expect(elementProblem({ ...nodeA, shape: 'toString' })).not.toBeNull()
    expect(elementProblem({ ...nodeA, shape: '__proto__' })).not.toBeNull()
    const { size, ...noSize } = nodeA
    expect(size).toBe(16)
    expect(elementProblem(noSize)).not.toBeNull()
    expect(elementProblem({ ...nodeA, font: 'comic' })).not.toBeNull()
    expect(elementProblem({ ...nodeA, w: Infinity })).not.toBeNull()
    expect(elementProblem({ ...nodeA, x: NaN })).not.toBeNull()
  })

  it('rejects Object.prototype names as ids, colours and icons (regression: render/store crashes)', () => {
    for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(elementProblem({ ...nodeA, id: bad })).not.toBeNull()
      expect(elementProblem({ ...nodeA, color: bad })).not.toBeNull()
      expect(elementProblem({ ...makeNode('component', 0, 0, { icon: bad }), id: 'c' })).not.toBeNull()
      expect(elementProblem({ ...makeEdge({ id: bad }, { x: 0, y: 0 }), id: 'e' })).not.toBeNull()
    }
    expect(elementProblem({ ...nodeA, color: 'chartreuse' })).not.toBeNull()
    expect(elementProblem({ ...makeNode('component', 0, 0, { icon: 'server' }), id: 'c' })).toBeNull()
  })

  it('a JSON board keyed by __proto__ is refused, not silently dropped', () => {
    const doc = JSON.parse('{"__proto__": {"id": "__proto__", "type": "node"}}')
    expect(validateBoard({ doc }).error).toBeTruthy()
  })

  it('rejects malformed connectors and strokes', () => {
    expect(elementProblem({ id: 'e', type: 'edge' })).not.toBeNull()
    expect(elementProblem({ ...makeEdge({ id: 'a', side: 'up' }, { id: 'b' }), id: 'e' })).not.toBeNull()
    expect(elementProblem({ ...makeStroke([{ x: 0, y: 0 }, { x: 5, y: 5 }]), pts: [1, 2, 3] })).not.toBeNull()
    expect(elementProblem({ ...makeStroke([{ x: 0, y: 0 }, { x: 5, y: 5 }]), pw: 0 })).not.toBeNull()
  })
})

describe('validateBoard', () => {
  const live = () => {
    const s = createDocStore()
    s.set('a', nodeA)
    s.set('a', { ...nodeA, x: 40 })
    s.set('b', { ...nodeA, id: 'b', x: 300 })
    s.undo()
    return s
  }

  it('round-trips a real history, including the redo chain', () => {
    const s = live()
    const saved = JSON.parse(JSON.stringify({ ...s.history, doc: s.doc }))
    const res = validateBoard(saved)
    expect(res.warning).toBeNull()
    const restored = createDocStore(res.board)
    expect(restored.doc).toEqual(s.doc)
    restored.redo()
    expect(restored.doc.b.x).toBe(300)
  })

  it('rejects a history whose before-images do not match (regression)', () => {
    const base = { a: nodeA }
    const done = [{ label: 'move', t: 1, changes: [['a', { ...nodeA, x: 999 }, { ...nodeA, x: 5 }]] }]
    const res = validateBoard({ base, done, undone: [], doc: { a: { ...nodeA, x: 5 } } })
    expect(res.warning).toMatch(/history/)
    // recovered board: undo can never resurrect the bogus x=999
    const s = createDocStore(res.board)
    expect(s.undo()).toBeNull()
    expect(s.doc.a.x).toBe(5)
    expect(fold(res.board.base, res.board.done)).toEqual(s.doc)
  })

  it('rejects a broken redo chain', () => {
    const s = live()
    const saved = JSON.parse(JSON.stringify({ ...s.history, doc: s.doc }))
    saved.undone[0].changes[0][1] = { ...nodeA, id: 'b', x: 1 } // b did not exist before its creation
    expect(validateBoard(saved).warning).toMatch(/history/)
  })

  it('preserves the checkpoint flag', () => {
    const s = live()
    expect(validateBoard({ ...s.history, checkpoint: true, doc: s.doc }).board.checkpoint).toBe(true)
  })

  it('refuses boards whose document itself is broken', () => {
    expect(validateBoard({ doc: { e: { ...makeEdge({ id: 'gone' }, { id: 'a' }), id: 'e' } } }).error).toMatch(/dangling/)
  })
})

describe('parseBoardFile', () => {
  it('rejects non-Boxwire files', () => {
    expect(parseBoardFile('not json').error).toBeTruthy()
    expect(parseBoardFile('{"format":"other"}').error).toBeTruthy()
  })
})

describe('pasteJSON (regression: malformed clipboard data)', () => {
  const measure = (s) => s.length * 8
  const payload = (elements) => JSON.stringify({ boxwire: 1, elements })

  it('rejects malformed payloads without touching the board', () => {
    const ed = createEditor({ measure })
    ed.store.set('a', nodeA)
    const before = { doc: ed.doc, done: ed.store.history.done.length }
    for (const bad of [
      [{ id: 'bad', type: 'edge' }],
      [{ ...makeEdge({ id: 'nope' }, { id: 'missing' }), id: 'e1' }],
      [{ ...makeStroke([{ x: 0, y: 0 }, { x: 3, y: 3 }]), pts: ['x'] }],
      [{ ...nodeA, id: 'n', w: -5 }],
      'not-an-array',
    ]) {
      expect(ed.pasteJSON(payload(bad), { x: 0, y: 0 })).toBe(true)
      expect(ed.doc).toBe(before.doc)
      expect(ed.store.history.done.length).toBe(before.done)
    }
    expect(ed.ui.toast.kind).toBe('error')
  })

  it('pastes the valid part and remaps connectors between pasted nodes', () => {
    const ed = createEditor({ measure })
    const b = { ...nodeA, id: 'b', x: 400 }
    const e = { ...makeEdge({ id: 'a' }, { id: 'b' }), id: 'e' }
    expect(ed.pasteJSON(payload([nodeA, b, e, { id: 'junk', type: 'edge' }]), { x: 1000, y: 1000 })).toBe(true)
    const els = Object.values(ed.doc)
    expect(els).toHaveLength(3)
    const edge = els.find((x) => x.type === 'edge')
    expect(ed.doc[edge.from.id].type).toBe('node')
    expect(ed.doc[edge.to.id].type).toBe('node')
    expect(edge.from.id).not.toBe('a')
  })

  it('ignores clipboard text that is not Boxwire data', () => {
    const ed = createEditor({ measure })
    expect(ed.pasteJSON('hello world')).toBe(false)
    expect(ed.pasteJSON('{"x":1}')).toBe(false)
  })
})
