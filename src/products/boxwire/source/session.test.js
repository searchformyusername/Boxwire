import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compileDiagram } from '../author/compile.js'
import { createDocStore, fold } from '../core/history.js'
import { parseSource } from './cst.js'
import { createSourceSession } from './session.js'
import { lineDiff, churn } from './linediff.js'

const measure = (s, font) => s.length * Number(/(\d+)px/.exec(font)[1]) * 0.55
const text = fs.readFileSync(new URL('./fixtures/review-baseline.boxwire.jsonc', import.meta.url), 'utf8')

function open() {
  const r = compileDiagram(parseSource(text).value, { measure })
  const store = createDocStore({ base: r.board.base, done: r.board.done })
  const session = createSourceSession({ store, text, measure })
  return { store, session }
}

describe('source session: the board and its source file move together', () => {
  it('a canvas label edit is one minimal source edit; undo and redo restore the exact text', () => {
    const { store, session } = open()
    const gw = store.doc.gw
    store.set('gw', { ...gw, text: 'Edge gateway' }, 'text')
    expect(session.text).not.toBe(text)
    expect(session.text).toContain('"label": "Edge gateway"')
    expect(churn(lineDiff(text, session.text))).toEqual({ removed: 1, added: 1 })
    store.undo()
    expect(session.text).toBe(text)
    store.redo()
    expect(session.text).toContain('"label": "Edge gateway"')
    expect(fold(store.history.base, store.history.done)).toEqual(store.doc) // the replay invariant holds
  })

  it('a drag writes a position, comments everywhere else are untouched', () => {
    const { store, session } = open()
    const checkout = store.doc.checkout
    store.set('checkout', { ...checkout, x: checkout.x + 40, y: checkout.y + 20 }, 'move')
    const comments = (t) => t.split('\n').filter((l) => /\/\/|\/\*|\*\//.test(l))
    expect(comments(session.text)).toEqual(comments(text).map((l) => l)) // every comment line survives byte for byte
    expect(compileDiagram(parseSource(session.text).value, { measure }).doc.checkout).toMatchObject({ x: checkout.x + 40, y: checkout.y + 20 })
    store.undo()
    expect(session.text).toBe(text)
  })

  it('hand-edited text that compiles is applied as one undoable board transaction', () => {
    const { store, session } = open()
    const steps = store.history.done.length
    const next = session.text.replace('"label": "API gateway"', '"label": "Gateway (OAuth)"')
    expect(session.applyText(next)).toMatchObject({ ok: true, changed: 1 })
    expect(store.doc.gw.text).toBe('Gateway (OAuth)')
    expect(store.history.done.length).toBe(steps + 1)
    store.undo()
    expect(session.text).toBe(text)
    expect(store.doc.gw.text).toBe('API gateway')
  })

  it('text that does not parse or compile leaves the board as it was and marks the source stale', () => {
    const { store, session } = open()
    const doc = store.doc
    expect(session.applyText(text.replace('"nodes": [', '"nodes": [[')).ok).toBe(false)
    expect(session.stale).toMatchObject({ line: expect.any(Number) })
    expect(session.applyText(text.replace('"kind": "api-gateway"', '"kind": "gatewayy"')).ok).toBe(false)
    expect(session.stale.message).toMatch(/unknown kind/)
    expect(store.doc).toBe(doc)
  })

  it('re-applying the last good text clears a stale source without a board step (the panel\'s Revert)', () => {
    const { store, session } = open()
    const steps = store.history.done.length
    session.applyText(text.replace('"nodes": [', '"nodes": [['))
    expect(session.stale).not.toBe(null)
    expect(session.applyText(session.text)).toMatchObject({ ok: true, changed: 0 })
    expect(session.stale).toBe(null)
    expect(store.history.done.length).toBe(steps)
  })
})
