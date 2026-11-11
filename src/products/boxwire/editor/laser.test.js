import { describe, expect, it, vi } from 'vitest'
import { createLaser } from './laser.js'
import { createEditor } from './editor.js'
import { createPointer } from './gestures.js'

function context() {
  const lines = [], dots = []
  return {
    lines, dots,
    save() {}, restore() {}, beginPath() {}, moveTo(x, y) { this.from = { x, y } },
    lineTo(x, y) { lines.push({ from: this.from, to: { x, y }, color: this.strokeStyle, width: this.lineWidth }) },
    stroke() {}, fill() {}, arc(x, y, r) { dots.push({ x, y, r, color: this.fillStyle }) },
  }
}
function fixture() {
  let time = 0
  const invalidate = vi.fn()
  const laser = createLaser({ invalidate, now: () => time })
  return { laser, invalidate, at(value) { time = value }, draw() { const ctx = context(); return { ctx, animating: laser.draw(ctx) } } }
}
const event = { button: 0, shiftKey: false, metaKey: false, ctrlKey: false }

describe('presentation laser', () => {
  it('shows a quiet red dot without pressing, then a faint trail that fades while the dot stays still', () => {
    const f = fixture()
    f.laser.move({ x: 10, y: 20 })
    expect(f.draw().animating).toBe(false)
    expect(f.draw().ctx.dots.at(-1)).toMatchObject({ x: 10, y: 20, r: 3, color: '#ef4444' })
    f.at(16); f.laser.move({ x: 30, y: 40 })
    const fresh = f.draw()
    expect(fresh.animating).toBe(true)
    expect(fresh.ctx.lines).toHaveLength(1)
    const freshAlpha = Number(fresh.ctx.lines[0].color.split(', ').at(-1).slice(0, -1))
    expect(freshAlpha).toBeGreaterThan(0.15)
    expect(freshAlpha).toBeLessThanOrEqual(0.2)
    f.at(500)
    const faded = Number(f.draw().ctx.lines[0].color.split(', ').at(-1).slice(0, -1))
    expect(faded).toBeLessThan(0.05)
    f.at(916)
    const stopped = f.draw()
    expect(stopped.animating).toBe(false)
    expect(stopped.ctx.lines).toHaveLength(0)
    expect(stopped.ctx.dots.at(-1).r).toBe(3)
  })

  it('brightens both dot and trail while pressed, and returns to quiet on release', () => {
    const f = fixture()
    f.laser.move({ x: 10, y: 10 }); f.at(16)
    f.laser.move({ x: 20, y: 20 }, true)
    expect(f.draw().ctx.dots).toContainEqual({ x: 20, y: 20, r: 4, color: '#ff3b30' })
    expect(f.draw().ctx.lines[0].width).toBe(3)
    f.at(32); f.laser.move({ x: 30, y: 30 }, false)
    expect(f.draw().ctx.dots.at(-1)).toMatchObject({ r: 3, color: '#ef4444' })
    expect(f.draw().ctx.lines.at(-1).width).toBe(2)
  })

  it('does not join across leaving and re-entering the canvas; clear removes everything', () => {
    const f = fixture()
    f.laser.move({ x: 10, y: 10 }); f.at(16); f.laser.move({ x: 20, y: 20 })
    f.laser.leave()
    expect(f.draw().ctx.dots).toHaveLength(0)
    f.at(32); f.laser.move({ x: 300, y: 300 })
    expect(f.draw().ctx.lines).toHaveLength(1)
    f.laser.clear()
    expect(f.draw()).toMatchObject({ animating: false, ctx: { lines: [], dots: [] } })
  })

  it('keeps a bounded useful trail under coalesced high-frequency input', () => {
    const f = fixture()
    for (let i = 0; i < 20000; i++) { f.at(i / 100); f.laser.move({ x: i, y: 40 }) }
    const { ctx, animating } = f.draw()
    expect(animating).toBe(true)
    expect(ctx.lines.length).toBeGreaterThan(10)
    expect(ctx.lines.length).toBeLessThanOrEqual(127)
    expect(ctx.dots.at(-1).x).toBe(19999)
    for (let i = 0; i < 300; i++) { f.at(200 + i); f.laser.move({ x: i, y: 40 }, i % 2 === 0) }
    expect(f.draw().ctx.lines.length).toBeLessThanOrEqual(127)
  })

  it('honors live reduced motion without removing the pointer or press distinction', () => {
    const f = fixture()
    f.laser.move({ x: 1, y: 1 }); f.at(16); f.laser.move({ x: 2, y: 2 })
    f.laser.setReducedMotion(true)
    f.laser.move({ x: 3, y: 3 }, true)
    expect(f.draw().animating).toBe(false)
    expect(f.draw().ctx.lines).toHaveLength(0)
    expect(f.draw().ctx.dots).toContainEqual({ x: 3, y: 3, r: 4, color: '#ff3b30' })
    f.laser.setReducedMotion(false)
    f.at(32); f.laser.move({ x: 4, y: 4 })
    expect(f.draw().ctx.lines).toHaveLength(0)
  })

  it('hover does not notify editor subscribers; hover and press never change the board or undo history', () => {
    const editor = createEditor()
    editor.set({ tool: 'laser' })
    const doc = editor.doc, history = editor.store.history
    const changed = vi.fn(), paint = vi.fn()
    editor.subscribe(changed)
    const pointer = createPointer(editor, { onLaserChange: paint })
    expect(pointer.move({ x: 20, y: 20 }, event)).toBe('none')
    expect(changed).not.toHaveBeenCalled()
    expect(pointer.down({ x: 20, y: 20 }, event)).toBe('none')
    pointer.move({ x: 30, y: 40 }, event)
    pointer.up({ x: 30, y: 40 }, event)
    pointer.doubleClick({ x: 30, y: 40 })
    expect(editor.doc).toBe(doc)
    expect(editor.store.history).toEqual(history)
    expect(editor.ui.editing).toBeNull()
    expect(paint).toHaveBeenCalled()
    editor.dispose()
  })

  it('clears on tool changes and cancel, keeps middle-button and Space panning, and handles captured moves outside', () => {
    const editor = createEditor()
    editor.set({ tool: 'laser' })
    const pointer = createPointer(editor)
    pointer.move({ x: 20, y: 20 }, event)
    pointer.down({ x: 20, y: 20 }, event)
    pointer.move({ x: -20, y: 20 }, event)
    let ctx = context(); pointer.laser.draw(ctx)
    expect(ctx.dots).toHaveLength(0)
    pointer.move({ x: 25, y: 20 }, event)
    pointer.cancel()
    ctx = context(); expect(pointer.laser.draw(ctx)).toBe(false); expect(ctx.dots).toHaveLength(0)
    expect(pointer.down({ x: 20, y: 20 }, { ...event, button: 1 })).toBe('grabbing')
    pointer.move({ x: 30, y: 20 }, event)
    expect(editor.ui.view.x).toBe(10)
    pointer.up({ x: 30, y: 20 }, event)
    pointer.setSpace(true)
    expect(pointer.cursor).toBe('grab')
    pointer.setSpace(false)
    editor.set({ tool: 'select' }); pointer.toolChanged()
    ctx = context(); expect(pointer.laser.draw(ctx)).toBe(false); expect(ctx.dots).toHaveLength(0)
    expect(pointer.cursor).toBe('default')
    editor.dispose()
  })
})
