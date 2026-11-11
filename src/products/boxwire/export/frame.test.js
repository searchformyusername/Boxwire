import { describe, expect, it } from 'vitest'
import { createDocStore } from '../core/history.js'
import { createReplay } from '../core/replay.js'
import { makeEdge, makeNode } from '../core/elements.js'
import { replayCamera } from './frame.js'

const measure = (s) => s.length * 8
const contains = (outer, r) => r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h

describe('replayCamera', () => {
  it('includes a wide connector label hanging off a short free connector (regression)', () => {
    const s = createDocStore()
    const label = 'eventually consistent fan-out via the outbox'
    s.set('e', { ...makeEdge({ x: 0, y: 0 }, { x: 30, y: 0 }, { text: label }), id: 'e' })
    const cam = replayCamera(createReplay({}, s.history.done), { measure })
    // label is centred on x=15 and wraps at 220px
    expect(cam.x).toBeLessThanOrEqual(15 - 110)
    expect(cam.x + cam.w).toBeGreaterThanOrEqual(15 + 110)
  })

  it('includes routed detours that leave the node bounds', () => {
    const s = createDocStore()
    const a = { ...makeNode('rect', 0, 0), id: 'a' }
    const b = { ...makeNode('rect', 500, 0), id: 'b' }
    const wall = { ...makeNode('rect', 250, -300, { w: 30, h: 700 }), id: 'wall', w: 30, h: 700 }
    for (const el of [a, b, wall, { ...makeEdge({ id: 'a' }, { id: 'b' }), id: 'e' }]) s.set(el.id, el)
    const r = createReplay({}, s.history.done)
    const cam = replayCamera(r, { measure })
    expect(contains(cam, wall)).toBe(true)
    expect(cam.y).toBeLessThan(-300) // the wire detours above the wall
  })
})

describe('connector labels (regression: a wide label must not hide a short wire)', () => {
  it('sets the label beside a wire that is shorter than the label', async () => {
    const { edgeLabelBox } = await import('../render/draw.js')
    const edge = { ...makeEdge({ x: 0, y: 0 }, { x: 100, y: 0 }, { text: 'Eventually consistent fan-out via the outbox' }), id: 'e' }
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }]
    const box = edgeLabelBox(edge, pts, measure)
    expect(box.y + box.h).toBeLessThan(0) // entirely above the wire, so line and arrowhead stay visible
  })

  it('keeps the label centred on a wire long enough to carry it', async () => {
    const { edgeLabelBox } = await import('../render/draw.js')
    const edge = { ...makeEdge({ x: 0, y: 0 }, { x: 600, y: 0 }, { text: 'HTTPS' }), id: 'e' }
    const box = edgeLabelBox(edge, [{ x: 0, y: 0 }, { x: 600, y: 0 }], measure)
    expect(box.y).toBeLessThan(0)
    expect(box.y + box.h).toBeGreaterThan(0)
    expect(box.x + box.w / 2).toBeCloseTo(300)
  })

  it('moves the label sideways for a short vertical wire', async () => {
    const { edgeLabelBox } = await import('../render/draw.js')
    const edge = { ...makeEdge({ x: 0, y: 0 }, { x: 0, y: 60 }, { text: 'publish events' }), id: 'e' }
    const box = edgeLabelBox(edge, [{ x: 0, y: 0 }, { x: 0, y: 60 }], measure)
    expect(box.x).toBeGreaterThan(0)
  })
})
