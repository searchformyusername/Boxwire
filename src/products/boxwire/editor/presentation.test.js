import { describe, expect, it } from 'vitest'
import { makeEdge, makeNode } from '../core/elements.js'
import { THEMES } from '../render/theme.js'
import { createEditor } from './editor.js'
import { createPointer } from './gestures.js'
import { drawChrome } from './overlay.js'

const event = { button: 0, shiftKey: false, metaKey: false, ctrlKey: false }
const measure = (s) => s.length * 8
function fixture(tool = 'select', zoom = 1) {
  const node = makeNode('rect', 100, 300, { id: 'node' })
  const first = makeEdge({ x: 100, y: 100 }, { x: 500, y: 100 }, { id: 'first', z: 1, route: 'straight' })
  const second = makeEdge({ x: 100, y: 200 }, { x: 500, y: 200 }, { id: 'second', z: 2, route: 'straight' })
  const editor = createEditor({ base: { node, first, second }, measure })
  editor.set({ presenting: true, tool, view: { x: 40, y: 20, z: zoom } })
  return { editor, pointer: createPointer(editor), at: (x, y) => editor.toScreen({ x, y }) }
}
function context() {
  const strokes = [], shapes = []
  let path = []
  return {
    strokes, shapes,
    save() {}, restore() {}, setLineDash() {}, beginPath() { path = [] },
    moveTo(x, y) { path.push([x, y]) }, lineTo(x, y) { path.push([x, y]) },
    stroke() { strokes.push({ path, color: this.strokeStyle, width: this.lineWidth, alpha: this.globalAlpha }) },
    roundRect() { shapes.push('rect') }, arc() { shapes.push('port') }, fill() {},
  }
}

describe('connector hover in presentation mode', () => {
  it.each(['select', 'rect', 'arrow', 'eraser', 'hand', 'laser'])('traces connectors with the %s tool, switching and clearing as the pointer moves', (tool) => {
    const { editor, pointer, at } = fixture(tool)
    const doc = editor.doc, history = editor.store.history
    pointer.move(at(250, 100), event)
    expect(editor.ui.hover).toBe('first')
    pointer.move(at(250, 200), event)
    expect(editor.ui.hover).toBe('second')
    pointer.move(at(180, 330), event)
    expect(editor.ui.hover).toBeNull() // nodes do not acquire presentation editing chrome
    pointer.move(at(250, 100), event)
    pointer.leave()
    expect(editor.ui.hover).toBeNull()
    expect(editor.doc).toBe(doc)
    expect(editor.store.history).toBe(history)
    editor.dispose()
  })

  it.each([0.25, 1, 2.5])('uses screen-pixel hit tolerance at %s× zoom and keeps the normal hover stroke', (zoom) => {
    const { editor, pointer, at } = fixture('rect', zoom)
    const point = at(250, 100)
    expect(pointer.move({ x: point.x, y: point.y + 5 }, event)).toBe('default')
    expect(editor.ui.hover).toBe('first')
    const ctx = context()
    drawChrome(ctx, editor, THEMES.light)
    expect(ctx.strokes).toHaveLength(1)
    expect(ctx.strokes[0]).toMatchObject({
      path: [Object.values(at(100, 100)), Object.values(at(500, 100))],
      color: THEMES.light.accentHover, width: 8, alpha: 0.35,
    })
    expect(ctx.shapes).toEqual([])
    pointer.move({ x: point.x, y: point.y + 12 }, event)
    expect(editor.ui.hover).toBeNull()
    editor.dispose()
  })

  it('draws the same hover in both themes while hiding selection, ports and snap guides', () => {
    const { editor, pointer, at } = fixture()
    pointer.move(at(250, 100), event)
    for (const theme of Object.values(THEMES)) {
      const normal = context()
      editor.set({ presenting: false })
      drawChrome(normal, editor, theme)
      editor.set({ presenting: true, selection: ['node'], bindTarget: 'node', guides: [{ x: 30 }] })
      const presenting = context()
      drawChrome(presenting, editor, theme)
      expect(presenting.strokes).toEqual(normal.strokes)
      expect(presenting.shapes).toEqual([])
      editor.set({ selection: [], bindTarget: null, guides: [] })
    }
    editor.dispose()
  })

  it.each(['select', 'rect', 'arrow', 'text', 'pen', 'eraser'])('hover, click, drag and double-click cannot edit a presentation with the %s tool', (tool) => {
    const { editor, pointer, at } = fixture(tool)
    const doc = editor.doc, history = editor.store.history
    const from = at(250, 100), to = at(300, 180)
    pointer.move(from, event)
    pointer.down(from, event)
    pointer.move(to, event)
    pointer.up(to, event)
    pointer.doubleClick(from)
    pointer.doubleClick(at(650, 400))
    expect(editor.doc).toBe(doc)
    expect(editor.store.history).toBe(history)
    expect(editor.ui.selection).toEqual([])
    expect(editor.ui.editing).toBeNull()
    editor.dispose()
  })
})
