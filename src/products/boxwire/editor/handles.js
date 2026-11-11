// Screen-space affordances shared by the overlay renderer and pointer hit-testing.

import { isContainer, isEdge, isNode, shapeOf } from '../core/elements.js'
import { NORMAL, SIDES, sidePoint, union } from '../core/geometry.js'

export const HANDLE = 8 // handle square size, px
const QUICK_OFFSET = 30 // quick-connect button distance from the node, px

const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' }
export const cursorForHandle = (id) => CURSORS[id]

/** The resizable frame for the current selection, or null. */
export function selectionFrame(editor) {
  const els = editor.selected().filter((e) => !isEdge(e))
  if (!els.length || editor.ui.editing) return null
  const widthOnly = els.length === 1 && shapeOf(els[0]).fit === 'sections'
  return { rect: els.length === 1 ? els[0] : union(els), els, widthOnly }
}

export function resizeHandles(editor, frame) {
  const a = editor.toScreen(frame.rect)
  const b = editor.toScreen({ x: frame.rect.x + frame.rect.w, y: frame.rect.y + frame.rect.h })
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
  const small = b.x - a.x < 36 || b.y - a.y < 36
  const all = [
    { id: 'nw', x: a.x, y: a.y }, { id: 'n', x: mx, y: a.y }, { id: 'ne', x: b.x, y: a.y }, { id: 'e', x: b.x, y: my },
    { id: 'se', x: b.x, y: b.y }, { id: 's', x: mx, y: b.y }, { id: 'sw', x: a.x, y: b.y }, { id: 'w', x: a.x, y: my },
  ]
  if (frame.widthOnly) return all.filter((h) => h.id === 'e' || h.id === 'w')
  return small ? all.filter((h) => h.id.length === 2) : all
}

/** Connection ports (world) at each face midpoint. */
export const portsOf = (node) => SIDES.map((side) => ({ side, ...sidePoint(node, side) }))

/** Quick-connect buttons (screen) around a single selected node. */
export function quickButtons(editor) {
  const els = editor.selected()
  const n = els.length === 1 && els[0]
  if (!isNode(n) || editor.ui.editing || isContainer(n) || n.shape === 'text' || editor.ui.tool !== 'select') return []
  return SIDES.map((side) => {
    const p = editor.toScreen(sidePoint(n, side))
    const extra = side === 's' && n.shape === 'actor' ? n.size * 2.4 * editor.ui.view.z : 0
    return { side, x: p.x + NORMAL[side].x * QUICK_OFFSET, y: p.y + NORMAL[side].y * (QUICK_OFFSET + extra) }
  })
}

/** Edge endpoints (screen) for the single selected edge. */
export function edgeEnds(editor) {
  const els = editor.selected()
  if (els.length !== 1 || !isEdge(els[0])) return []
  const pts = editor.scene().routes.get(els[0].id)
  if (!pts) return []
  return [{ end: 'from', ...editor.toScreen(pts[0]) }, { end: 'to', ...editor.toScreen(pts[pts.length - 1]) }]
}

export const near = (a, b, r) => Math.abs(a.x - b.x) <= r && Math.abs(a.y - b.y) <= r
