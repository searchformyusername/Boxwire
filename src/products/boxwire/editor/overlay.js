// Editor-only chrome drawn over the scene: grid, selection, handles, ports,
// snap guides, marquee and previews. Never exported.

import { createRouter, routingObstacles } from '../core/edges.js'
import { framesOf, isContainer, isEdge, isNode } from '../core/elements.js'
import { drawEdge, drawNode, drawStroke } from '../render/draw.js'
import { colorOf } from '../render/theme.js'
import { compact } from '../review/units.js'
import { frameTitle, frameTitleBox } from '../render/bounds.js'
import { fontOf } from '../core/text.js'
import { HANDLE, edgeEnds, portsOf, quickButtons, resizeHandles, selectionFrame } from './handles.js'

const draftRouter = createRouter()

export function drawGrid(ctx, editor, theme, dpr) {
  const { x, y, z } = editor.ui.view
  let step = 24 * z
  while (step < 14) step *= 2
  const { w, h } = editor.ui.size
  ctx.fillStyle = theme.dot
  const r = Math.max(0.6, Math.min(1.3, z)) * dpr
  for (let gx = ((x % step) + step) % step; gx < w; gx += step) {
    for (let gy = ((y % step) + step) % step; gy < h; gy += step) {
      ctx.fillRect(gx * dpr - r / 2, gy * dpr - r / 2, r, r)
    }
  }
}

/** World-space previews (draft shape / connector / stroke). Call with the world transform set. */
export function drawDraft(ctx, editor, theme) {
  const d = editor.ui.draft
  if (!d) return
  ctx.save()
  ctx.globalAlpha = 0.75
  if (d.type === 'node') drawNode(ctx, d, theme)
  else if (d.type === 'stroke') drawStroke(ctx, d, theme)
  else if (isEdge(d)) {
    const doc = { ...editor.doc, [d.id]: d }
    const pts = draftRouter(doc, routingObstacles(editor.scene().nodes)).get(d.id)
    drawEdge(ctx, d, pts, theme)
  }
  ctx.restore()
}

/** Screen-space chrome. Call with a dpr-only transform. */
export function drawChrome(ctx, editor, theme) {
  const { ui } = editor
  const S = (p) => editor.toScreen(p)
  const accent = theme.accent
  ctx.save()
  ctx.lineWidth = 1.5
  ctx.setLineDash([])

  const outline = (el, color, width = 1.5, pad = 3) => {
    const b = editor.boundsOf(el)
    if (!b) return
    if (isEdge(el)) {
      const pts = editor.scene().routes.get(el.id)
      if (!pts) return
      ctx.strokeStyle = color
      ctx.globalAlpha = 0.35
      ctx.lineWidth = el.stroke + 6
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      pts.forEach((p, i) => (i ? ctx.lineTo(S(p).x, S(p).y) : ctx.moveTo(S(p).x, S(p).y)))
      ctx.stroke()
      ctx.globalAlpha = 1
      return
    }
    const a = S(b)
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.beginPath()
    ctx.roundRect(a.x - pad, a.y - pad, b.w * ui.view.z + pad * 2, b.h * ui.view.z + pad * 2, 4)
    ctx.stroke()
  }

  // hover + bind target
  const hover = editor.get(ui.hover)
  if (hover && !ui.selection.includes(hover.id) && !ui.draft) outline(hover, theme.accentHover, 1.5)
  const bind = editor.get(ui.bindTarget)
  if (bind) outline(bind, accent, 2.5, 4)

  // selection
  const sel = editor.selected()
  for (const el of sel) outline(el, accent)
  const frame = selectionFrame(editor)
  if (frame && sel.length > 1) {
    const a = S(frame.rect)
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = accent
    ctx.strokeRect(a.x - 6, a.y - 6, frame.rect.w * ui.view.z + 12, frame.rect.h * ui.view.z + 12)
    ctx.setLineDash([])
  }
  if (frame && !ui.draft) {
    for (const h of resizeHandles(editor, frame)) {
      ctx.fillStyle = theme.paper
      ctx.strokeStyle = accent
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.roundRect(h.x - HANDLE / 2, h.y - HANDLE / 2, HANDLE, HANDLE, 2)
      ctx.fill()
      ctx.stroke()
    }
  }
  for (const h of edgeEnds(editor)) {
    ctx.fillStyle = theme.paper
    ctx.strokeStyle = accent
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(h.x, h.y, 5, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }

  // ports on the hovered or binding node
  const portNode = bind ?? (ui.tool === 'select' || ui.tool === 'arrow' ? hover : null)
  if (isNode(portNode) && !isContainer(portNode) && !ui.editing) {
    for (const p of portsOf(portNode)) {
      const s = S(p)
      ctx.fillStyle = theme.paper
      ctx.strokeStyle = accent
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(s.x, s.y, 4, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  }

  // quick-connect chevrons
  for (const b of quickButtons(editor)) {
    const ang = { n: -Math.PI / 2, e: 0, s: Math.PI / 2, w: Math.PI }[b.side]
    ctx.save()
    ctx.translate(b.x, b.y)
    ctx.fillStyle = theme.paper
    ctx.strokeStyle = theme.accentHover
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(0, 0, 10, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.rotate(ang)
    ctx.fillStyle = accent
    ctx.beginPath()
    ctx.moveTo(4.5, 0)
    ctx.lineTo(-2.5, -4.5)
    ctx.lineTo(-2.5, 4.5)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  // snap guides
  ctx.strokeStyle = colorOf('pink', theme)
  ctx.lineWidth = 1
  for (const g of ui.guides) {
    const a = S({ x: g.x1, y: g.y1 }), b = S({ x: g.x2, y: g.y2 })
    ctx.beginPath()
    ctx.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5)
    ctx.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5)
    ctx.stroke()
  }

  // marquee
  if (ui.marquee) {
    const a = S(ui.marquee)
    ctx.fillStyle = theme.accentSoft
    ctx.strokeStyle = accent
    ctx.fillRect(a.x, a.y, ui.marquee.w * ui.view.z, ui.marquee.h * ui.view.z)
    ctx.strokeRect(a.x, a.y, ui.marquee.w * ui.view.z, ui.marquee.h * ui.view.z)
  }
  ctx.restore()
}

/** Frames (presentation slides) in screen space: a quiet outline with the slide number and title. */
export function drawFrames(ctx, editor, theme) {
  const frames = framesOf(editor.scene().nodes)
  if (!frames.length) return
  const S = (p) => editor.toScreen(p)
  const z = editor.ui.view.z
  ctx.save()
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  frames.forEach((f, i) => {
    const a = S(f)
    const selected = editor.ui.selection.includes(f.id) || editor.ui.hover === f.id
    ctx.strokeStyle = selected ? theme.accent : theme.muted
    ctx.globalAlpha = selected ? 0.9 : 0.3
    ctx.lineWidth = 1
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    ctx.roundRect(a.x, a.y, f.w * z, f.h * z, 6)
    ctx.stroke()
    // the title sits just above the frame's top-left corner in board space (render/bounds.js frameTitleBox),
    // so it scales with the board and layout can keep it clear of everything else
    const box = frameTitleBox(f, i, editor.measure)
    const t = S(box)
    ctx.globalAlpha = selected ? 1 : 0.75
    ctx.setLineDash([])
    ctx.font = fontOf(f.size * z, 'sans', 600)
    ctx.fillStyle = selected ? theme.accent : theme.muted
    ctx.fillText(frameTitle(f, i), t.x, t.y + (box.h * z) / 2)
  })
  ctx.restore()
}

const TONE = { violation: 'red', unknown: 'amber', pass: 'green' }

/**
 * Review chrome (screen space): the elements and witness path of the finding
 * being inspected, and, when the load view is on, each node's propagated load
 * with its utilisation. Reads the same memoised review as the panel.
 */
export function drawReview(ctx, editor, theme, review) {
  const { ui } = editor
  const hl = ui.highlight
  if (!review || (!hl && !ui.showLoad)) return
  const S = (p) => editor.toScreen(p)
  const z = ui.view.z
  ctx.save()
  ctx.setLineDash([])
  if (hl) {
    const color = colorOf(TONE[hl.tone] ?? 'blue', theme)
    const ids = new Set([...(hl.ids ?? []), ...(hl.witness ?? [])])
    for (const id of ids) {
      const el = editor.get(id)
      if (!el) continue
      ctx.strokeStyle = color
      if (isEdge(el)) {
        const pts = editor.scene().routes.get(el.id)
        if (!pts) continue
        ctx.globalAlpha = 0.45
        ctx.lineWidth = el.stroke * z + 8
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.beginPath()
        pts.forEach((p, i) => (i ? ctx.lineTo(S(p).x, S(p).y) : ctx.moveTo(S(p).x, S(p).y)))
        ctx.stroke()
        ctx.globalAlpha = 1
        continue
      }
      const b = editor.boundsOf(el)
      const a = S(b)
      ctx.lineWidth = hl.ids?.includes(id) ? 3 : 2
      ctx.beginPath()
      ctx.roundRect(a.x - 6, a.y - 6, b.w * z + 12, b.h * z + 12, 8)
      ctx.stroke()
    }
  }
  if (ui.showLoad && review.capacity) {
    const fmt = (v) => (v[1] === Infinity ? '?' : v[0] === v[1] ? compact(v[0]) : `≤${compact(v[1])}`)
    ctx.font = '600 11px Inter, "Helvetica Neue", Arial, sans-serif'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    for (const [id, info] of review.capacity.nodes) {
      const el = editor.get(id)
      const load = info.in
      if (!el || !(load.r[1] > 0 || load.w[1] > 0)) continue
      const r = info.rating
      const util = r?.limit ? ` · ${r.utilisation[1] === Infinity ? '?' : Math.round(r.utilisation[1] * 100)}%` : ''
      const text = `${fmt(load.r)} r/s · ${fmt(load.w)} w/s${util}`
      const tone = r?.status === 'violation' || info.storage?.status === 'violation' ? 'red' : r?.status === 'pass' ? 'green' : r ? 'amber' : 'slate'
      const p = S({ x: el.x + el.w / 2, y: el.y + el.h })
      const w = ctx.measureText(text).width + 12
      const y = p.y + (el.shape === 'actor' ? el.size * 2.8 * z : 0) + 13
      ctx.fillStyle = theme.paper
      ctx.strokeStyle = colorOf(tone, theme)
      ctx.lineWidth = 1.25
      ctx.beginPath()
      ctx.roundRect(p.x - w / 2, y - 9, w, 18, 9)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = colorOf(tone, theme)
      ctx.fillText(text, p.x, y)
    }
  }
  ctx.restore()
}
