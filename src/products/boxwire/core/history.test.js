import { describe, expect, it } from 'vitest'
import { createDocStore, fold } from './history.js'

const node = (id, x = 0, extra = {}) => ({ id, type: 'node', x, y: 0, w: 10, h: 10, ...extra })

function clock() {
  let t = 1000
  const now = () => t
  now.tick = (ms) => (t += ms)
  return now
}

describe('doc store', () => {
  it('commits, undoes and redoes', () => {
    const s = createDocStore()
    s.set('a', node('a'))
    s.set('a', node('a', 5))
    expect(s.doc.a.x).toBe(5)
    s.undo()
    expect(s.doc.a.x).toBe(0)
    s.undo()
    expect(s.doc.a).toBeUndefined()
    s.redo()
    s.redo()
    expect(s.doc.a.x).toBe(5)
    expect(s.redo()).toBeNull()
  })

  it('records one transaction per gesture, not per move', () => {
    const s = createDocStore()
    s.set('a', node('a'))
    s.begin('move')
    for (let x = 1; x <= 50; x++) s.apply([['a', node('a', x)]])
    s.commit()
    expect(s.history.done).toHaveLength(2)
    expect(s.history.done[1].changes[0][1].x).toBe(0)
    expect(s.history.done[1].changes[0][2].x).toBe(50)
  })

  it('drops no-op transactions', () => {
    const s = createDocStore()
    s.set('a', node('a'))
    s.begin('move')
    s.apply([['a', node('a', 9)]])
    s.apply([['a', node('a', 0)]])
    s.commit()
    s.set('a', { ...s.doc.a })
    expect(s.history.done).toHaveLength(1)
  })

  it('cancel restores the pre-gesture document', () => {
    const s = createDocStore()
    s.set('a', node('a'))
    const before = s.doc
    s.begin('drag')
    s.apply([['a', node('a', 40)], ['b', node('b')]])
    s.cancel()
    expect(s.doc).toEqual(before)
    expect(s.history.done).toHaveLength(1)
  })

  it('coalesces mergeable edits inside the window only', () => {
    const now = clock()
    const s = createDocStore({ now })
    s.set('a', node('a'))
    s.set('a', node('a', 1), 'nudge', 'nudge:a')
    now.tick(200)
    s.set('a', node('a', 2), 'nudge', 'nudge:a')
    expect(s.history.done).toHaveLength(2)
    expect(s.history.done[1].changes[0][1].x).toBe(0)
    now.tick(5000)
    s.set('a', node('a', 3), 'nudge', 'nudge:a')
    expect(s.history.done).toHaveLength(3)
  })

  it('never merges across an undo boundary', () => {
    const now = clock()
    const s = createDocStore({ now })
    s.set('a', node('a'))
    s.set('a', node('a', 1), 'nudge', 'nudge:a')
    now.tick(100)
    s.set('a', node('a', 2), 'nudge', 'nudge:a') // merged with previous
    s.undo() // back to x=0
    now.tick(100)
    s.set('a', node('a', 7), 'nudge', 'nudge:a')
    expect(s.history.done).toHaveLength(2)
    s.undo()
    expect(s.doc.a.x).toBe(0)
  })

  it('a merge that cancels itself out disappears', () => {
    const now = clock()
    const s = createDocStore({ now })
    s.set('a', node('a'))
    s.set('a', node('a', 1), 'nudge', 'n')
    s.set('a', node('a', 0), 'nudge', 'n')
    expect(s.history.done).toHaveLength(1)
  })

  it('branching after undo discards the redo stack', () => {
    const s = createDocStore()
    s.set('a', node('a'))
    s.set('b', node('b'))
    s.undo()
    s.set('c', node('c'))
    expect(s.redo()).toBeNull()
    expect(Object.keys(s.doc).sort()).toEqual(['a', 'c'])
  })
})

// Deterministic PRNG so failures reproduce.
function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
}

describe('replay invariant: fold(base, done) equals the live document', () => {
  it('holds across random commit/undo/redo/merge/cancel sequences and a JSON reload', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed)
      const now = clock()
      const base = { seed: node('seed', 1) }
      let s = createDocStore({ base, now })
      const ids = ['a', 'b', 'c', 'd', 'seed']
      for (let step = 0; step < 300; step++) {
        const pick = r()
        const id = ids[Math.floor(r() * ids.length)]
        now.tick(Math.floor(r() * 1500))
        if (pick < 0.35) s.set(id, node(id, Math.floor(r() * 100), { text: 't' + step }))
        else if (pick < 0.45) s.set(id, null)
        else if (pick < 0.55) s.set(id, node(id, Math.floor(r() * 5)), 'nudge', 'nudge:' + id)
        else if (pick < 0.65) {
          s.begin('drag')
          s.apply([[id, node(id, Math.floor(r() * 100))], [ids[0], node(ids[0], 3)]])
          if (r() < 0.3) s.cancel()
          else s.commit()
        } else if (pick < 0.82) s.undo()
        else s.redo()
        expect(fold(s.history.base, s.history.done)).toEqual(s.doc)
        if (step % 97 === 0) {
          const saved = JSON.parse(JSON.stringify(s.history))
          s = createDocStore({ ...saved, now })
          expect(fold(saved.base, saved.done)).toEqual(s.doc)
        }
      }
    }
  })
})
