import { describe, expect, it } from 'vitest'
import { createDocStore, fold } from './history.js'
import { buildSteps, createReplay } from './replay.js'

const node = (id, x = 0, text = '') => ({ id, type: 'node', shape: 'rect', x, y: 0, w: 100, h: 50, z: 1, text, color: 'ink', stroke: 2, size: 16 })

function build() {
  const s = createDocStore()
  s.set('a', node('a'), 'add')
  s.begin('text')
  s.apply([['a', node('a', 0, 'API')]])
  s.commit()
  s.set('tmp', node('tmp', 300), 'add')
  s.set('b', node('b', 500), 'add')
  s.set('tmp', null, 'delete')
  s.set('d', node('d', 0, 'Cache'), 'add')
  s.set('b', node('b', 520, 'DB'), 'move')
  s.set('c', node('c', 900), 'add')
  s.undo()
  return s
}

describe('buildSteps', () => {
  it('merges typing into the step that created the element', () => {
    const steps = buildSteps({}, build().history.done)
    expect(steps[0].changes).toEqual([['a', null, node('a', 0, 'API')]])
  })

  it('hides elements that never reach the final board, but can show them', () => {
    const s = build()
    expect(buildSteps({}, s.history.done).some((st) => st.changes.some(([id]) => id === 'tmp'))).toBe(false)
    expect(buildSteps({}, s.history.done, { hideDeadEnds: false }).some((st) => st.changes.some(([id]) => id === 'tmp'))).toBe(true)
  })

  it('folds an immediate adjustment of a new element into its creation', () => {
    const s = createDocStore()
    s.set('a', node('a'), 'add')
    s.set('a', node('a', 40), 'move')
    expect(buildSteps({}, s.history.done)).toHaveLength(1)
  })

  it('omits undone work', () => {
    const steps = buildSteps({}, build().history.done)
    expect(steps.some((st) => st.changes.some(([id]) => id === 'c'))).toBe(false)
  })
})

describe('createReplay', () => {
  it('ends exactly on the live document, with or without dead ends', () => {
    const s = build()
    for (const hideDeadEnds of [true, false]) {
      const r = createReplay(s.history.base, s.history.done, { hideDeadEnds })
      expect(r.frame(r.total).doc).toEqual(s.doc)
      expect(r.frame(r.end).doc).toEqual(s.doc)
      expect(r.finalDoc).toEqual(fold(s.history.base, s.history.done))
    }
  })

  it('starts from the base and is monotonic in step index', () => {
    const s = build()
    const r = createReplay(s.history.base, s.history.done)
    expect(r.frame(0).doc).toEqual({})
    let last = 0
    for (let t = 0; t <= r.total; t += 37) {
      const f = r.frame(t)
      expect(f.step).toBeGreaterThanOrEqual(last)
      last = f.step
    }
  })

  it('types labels progressively and fades new nodes in', () => {
    const s = build()
    const r = createReplay(s.history.base, s.history.done)
    const start = r.startOf(0)
    const early = r.frame(start + 40)
    expect(early.fx.get('a').alpha).toBeLessThan(0.5)
    const mid = r.frame(start + r.steps[0].dur * 0.75)
    const typed = mid.fx.get('a').text
    expect('API'.startsWith(typed)).toBe(true)
    expect(typed.length).toBeGreaterThan(0)
    expect(typed.length).toBeLessThan(3)
  })

  it('interpolates moves between their endpoints', () => {
    const s = build()
    const r = createReplay(s.history.base, s.history.done)
    const i = r.steps.findIndex((st) => st.label === 'move')
    const f = r.frame(r.startOf(i) + r.steps[i].dur / 2)
    expect(f.doc.b.x).toBeGreaterThan(500)
    expect(f.doc.b.x).toBeLessThan(520)
  })

  it('exposes every intermediate document, ending on the live one', () => {
    const s = build()
    const r = createReplay(s.history.base, s.history.done, { hideDeadEnds: false })
    expect(r.docs[0]).toEqual({})
    expect(r.docs.at(-1)).toEqual(s.doc)
    expect(r.docs.some((d) => 'tmp' in d)).toBe(true)
  })
})
