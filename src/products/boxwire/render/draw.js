// The one scene renderer: the editor, PNG export and every timelapse frame call
// drawScene, so exports are pixel-identical to what was on screen.

import { LINE_HEIGHT, fontOf, measureText, wrapText } from '../core/text.js'
import { center, truncatePolyline, pointAlong, polylineLength } from '../core/geometry.js'
import { labelFont, outlineOf, sectionLayout, shapeOf, strokePoints, textRect } from '../core/elements.js'
import { colorOf, mix, paintOf } from './theme.js'
import { iconPath } from './icons.js'

const dashOf = (dash, w) => (dash === 'dashed' ? [6 + w * 2, 4 + w * 2] : dash === 'dotted' ? [0.1, 3 + w * 2] : [])

function polygon(ctx, pts) {
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
  ctx.closePath()
}

const cylCap = (e) => Math.min(14, e.h * 0.16)
const queueCap = (e) => Math.min(14, e.w * 0.1)

// Outline paths (filled and stroked) and optional detail strokes, per shape.
const PATHS = {
  rect: (c, e) => c.roundRect(e.x, e.y, e.w, e.h, Math.min(10, e.w / 2, e.h / 2)),
  component: (c, e) => c.roundRect(e.x, e.y, e.w, e.h, Math.min(12, e.w / 2, e.h / 2)),
  zone: (c, e) => c.roundRect(e.x, e.y, e.w, e.h, 16),
  frame: (c, e) => c.roundRect(e.x, e.y, e.w, e.h, 6),
  class: (c, e) => c.roundRect(e.x, e.y, e.w, e.h, 4),
  table: (c, e) => c.roundRect(e.x, e.y, e.w, e.h, 8),
  ellipse: (c, e) => c.ellipse(e.x + e.w / 2, e.y + e.h / 2, e.w / 2, e.h / 2, 0, 0, Math.PI * 2),
  diamond: (c, e) => polygon(c, outlineOf(e)),
  hexagon: (c, e) => polygon(c, outlineOf(e)),
  cylinder(c, e) {
    const ry = cylCap(e), cx = e.x + e.w / 2, rx = e.w / 2
    c.moveTo(e.x, e.y + ry)
    c.lineTo(e.x, e.y + e.h - ry)
    c.ellipse(cx, e.y + e.h - ry, rx, ry, 0, Math.PI, 0, true)
    c.lineTo(e.x + e.w, e.y + ry)
    c.ellipse(cx, e.y + ry, rx, ry, 0, 0, Math.PI, true)
    c.closePath()
  },
  queue(c, e) {
    const rx = queueCap(e), cy = e.y + e.h / 2
    c.moveTo(e.x + rx, e.y)
    c.lineTo(e.x + e.w - rx, e.y)
    c.ellipse(e.x + e.w - rx, cy, rx, e.h / 2, 0, -Math.PI / 2, Math.PI / 2)
    c.lineTo(e.x + rx, e.y + e.h)
    c.ellipse(e.x + rx, cy, rx, e.h / 2, 0, Math.PI / 2, (3 * Math.PI) / 2)
    c.closePath()
  },
  cloud(c, e) {
    const X = (v) => e.x + v * e.w, Y = (v) => e.y + v * e.h
    c.moveTo(X(0.25), Y(0.9))
    c.bezierCurveTo(X(0.02), Y(0.9), X(-0.02), Y(0.52), X(0.2), Y(0.47))
    c.bezierCurveTo(X(0.16), Y(0.16), X(0.45), Y(0.04), X(0.55), Y(0.24))
    c.bezierCurveTo(X(0.64), Y(0.02), X(0.93), Y(0.1), X(0.86), Y(0.38))
    c.bezierCurveTo(X(1.04), Y(0.42), X(1.04), Y(0.9), X(0.78), Y(0.9))
    c.closePath()
  },
  note(c, e) {
    const f = Math.min(20, e.w / 4, e.h / 4)
    polygon(c, [{ x: e.x, y: e.y }, { x: e.x + e.w - f, y: e.y }, { x: e.x + e.w, y: e.y + f }, { x: e.x + e.w, y: e.y + e.h }, { x: e.x, y: e.y + e.h }])
  },
  text: null,
  actor: null,
}

const DETAILS = {
  cylinder(c, e) {
    const ry = cylCap(e)
    c.beginPath()
    c.ellipse(e.x + e.w / 2, e.y + ry, e.w / 2, ry, 0, Math.PI, 0, true)
    c.stroke()
  },
  queue(c, e) {
    const rx = queueCap(e)
    c.beginPath()
    c.ellipse(e.x + e.w - rx, e.y + e.h / 2, rx, e.h / 2, 0, -Math.PI / 2, Math.PI / 2, true)
    c.stroke()
  },
  note(c, e) {
    const f = Math.min(20, e.w / 4, e.h / 4)
    c.beginPath()
    c.moveTo(e.x + e.w - f, e.y)
    c.lineTo(e.x + e.w - f, e.y + f)
    c.lineTo(e.x + e.w, e.y + f)
    c.stroke()
  },
  actor(c, e) {
    const r = Math.min(e.w * 0.24, e.h * 0.14), cx = e.x + e.w / 2
    const neck = e.y + 2 * r + 2, hip = e.y + e.h * 0.66
    c.beginPath()
    c.arc(cx, e.y + r + 1, r, 0, Math.PI * 2)
    c.moveTo(cx, neck); c.lineTo(cx, hip)
    c.moveTo(e.x + e.w * 0.08, neck + (hip - neck) * 0.3); c.lineTo(e.x + e.w * 0.92, neck + (hip - neck) * 0.3)
    c.moveTo(cx, hip); c.lineTo(e.x + e.w * 0.12, e.y + e.h)
    c.moveTo(cx, hip); c.lineTo(e.x + e.w * 0.88, e.y + e.h)
    c.stroke()
  },
}

function drawLines(ctx, lines, x, y, lh) {
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], x, y + lh * i + lh / 2)
}

function drawLabel(ctx, el, paint, text) {
  if (!text) return
  const m = shapeOf(el), box = textRect(el)
  const zone = el.shape === 'zone' || el.shape === 'frame'
  const font = zone ? fontOf(el.size, el.font, el.shape === 'frame' ? 600 : 650) : labelFont(el)
  const lines = wrapText(text, box.w, font)
  const lh = el.size * LINE_HEIGHT
  const align = el.align ?? m.align ?? 'center'
  const top = m.valign === 'top' || el.shape === 'actor'
  ctx.font = font
  ctx.fillStyle = zone ? paint.stroke : paint.text
  ctx.textAlign = align
  ctx.textBaseline = 'middle'
  const x = align === 'left' ? box.x : align === 'right' ? box.x + box.w : box.x + box.w / 2
  drawLines(ctx, lines, x, top ? box.y : box.y + (box.h - lines.length * lh) / 2, lh)
}

/** UML classes and ER tables: compartments separated by `---` lines in the text. */
function drawSections(ctx, el, paint, theme, text) {
  const lay = sectionLayout({ ...el, text })
  const pad = shapeOf(el).pad
  const small = Math.round(el.size * 0.875)
  const table = el.shape === 'table'
  ctx.textBaseline = 'middle'
  lay.sections.forEach((sec, i) => {
    const y = el.y + sec.y
    if (i > 0 && !table) {
      ctx.beginPath()
      ctx.moveTo(el.x, y); ctx.lineTo(el.x + el.w, y)
      ctx.stroke()
    }
    if (i === 0) {
      if (table) {
        ctx.save()
        ctx.beginPath()
        ctx.roundRect(el.x, el.y, el.w, sec.h, [8, 8, 0, 0])
        ctx.fillStyle = el.fill === 'solid' ? mix(theme.paper, paint.stroke, 0.18) : mix(paint.stroke, theme.paper, theme.tint * 2)
        ctx.fill()
        ctx.beginPath()
        ctx.moveTo(el.x, y + sec.h); ctx.lineTo(el.x + el.w, y + sec.h)
        ctx.stroke()
        ctx.restore()
      }
      const lines = sec.lines.length ? sec.lines : ['']
      const top = y + (sec.h - lines.length * lay.row) / 2
      lines.forEach((ln, k) => {
        const stereo = /^(«.*»|<<.*>>)$/.test(ln.trim())
        const abstract = /^\*.*\*$/.test(ln.trim())
        const label = abstract ? ln.trim().slice(1, -1) : ln
        ctx.font = fontOf(stereo ? small : el.size, 'sans', stereo ? 400 : 700, stereo || abstract)
        ctx.fillStyle = paint.text
        ctx.textAlign = 'center'
        ctx.fillText(label, el.x + el.w / 2, top + lay.row * k + lay.row / 2)
      })
      return
    }
    const top = y + pad / 2
    sec.lines.forEach((ln, k) => {
      const cy = top + lay.row * k + lay.row / 2
      ctx.fillStyle = paint.text
      if (!table) {
        ctx.font = fontOf(small, el.font, 450, /\{abstract\}/.test(ln))
        ctx.textAlign = 'left'
        ctx.fillText(ln.replace(/\s*\{abstract\}/, ''), el.x + pad, cy)
        if (/\{static\}|^\s*_.*_\s*$/.test(ln)) {
          const w = ctx.measureText(ln).width
          ctx.fillRect(el.x + pad, cy + small * 0.6, Math.min(w, el.w - 2 * pad), 1)
        }
        return
      }
      // ER row: "name type FLAGS" — name left, key flags right, type muted beside them
      const [name = '', type = '', ...flags] = ln.trim().split(/\s+/)
      const key = flags.join(' ').toUpperCase()
      const right = el.x + el.w - pad
      ctx.font = fontOf(small, el.font, key.includes('PK') ? 700 : 450)
      ctx.textAlign = 'left'
      ctx.fillText(name, el.x + pad, cy)
      ctx.textAlign = 'right'
      let typeRight = right
      if (key) {
        ctx.font = fontOf(Math.round(small * 0.78), 'sans', 700)
        ctx.fillStyle = key.includes('PK') ? colorOf('amber', theme) : key.includes('FK') ? colorOf('blue', theme) : theme.muted
        ctx.fillText(key, right, cy)
        typeRight -= ctx.measureText(key).width + 8
      }
      ctx.save()
      ctx.font = fontOf(small, el.font, 400)
      ctx.fillStyle = paint.text
      ctx.globalAlpha *= 0.7
      ctx.fillText(type, typeRight, cy)
      ctx.restore()
    })
  })
}

function drawIcon(ctx, el, paint, theme) {
  const path = iconPath(el.icon)
  if (!path) return
  const s = Math.min(34, el.h - 16)
  const x = el.x + 10, y = el.y + (el.h - s) / 2
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(x, y, s, s, 8)
  ctx.fillStyle = el.fill === 'solid' ? mix(theme.paper, paint.stroke, 0.2) : mix(paint.stroke, theme.paper, theme.tint * 1.6)
  ctx.fill()
  ctx.translate(x + s * 0.18, y + s * 0.18)
  ctx.scale((s * 0.64) / 24, (s * 0.64) / 24)
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash([])
  ctx.strokeStyle = el.fill === 'solid' ? theme.paper : paint.stroke
  ctx.stroke(path)
  ctx.restore()
}

export function drawNode(ctx, el, theme, { text = el.text, hideText = false } = {}) {
  const paint = paintOf(el, theme)
  ctx.lineWidth = el.stroke
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.strokeStyle = paint.stroke
  const pathFn = PATHS[el.shape] === undefined ? PATHS.rect : PATHS[el.shape]
  if (el.crossed) ctx.globalAlpha *= 0.45
  if (pathFn) {
    ctx.beginPath()
    pathFn(ctx, el)
    if (paint.fill) {
      ctx.fillStyle = paint.fill
      ctx.fill()
    }
    if (el.stroke > 0) {
      ctx.setLineDash(dashOf(el.dash, el.stroke))
      ctx.stroke()
    }
  }
  ctx.setLineDash(el.shape === 'actor' ? dashOf(el.dash, el.stroke) : [])
  DETAILS[el.shape]?.(ctx, el)
  if (el.shape === 'component') drawIcon(ctx, el, paint, theme)
  if (!hideText) {
    if (shapeOf(el).fit === 'sections') drawSections(ctx, el, paint, theme, text)
    else drawLabel(ctx, el, paint, text)
  }
  if (el.crossed) {
    ctx.globalAlpha /= 0.45
    const k = Math.min(10, el.w * 0.08)
    ctx.strokeStyle = colorOf('red', theme)
    ctx.lineWidth = 3
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.moveTo(el.x + k, el.y + k); ctx.lineTo(el.x + el.w - k, el.y + el.h - k)
    ctx.moveTo(el.x + el.w - k, el.y + k); ctx.lineTo(el.x + k, el.y + el.h - k)
    ctx.stroke()
  }
}

// ---- edges ----

const headSize = (w) => 9 + w * 2.2
const TRIM = { arrow: 0.85, triangle: 1, diamond: 1.8, diamondFilled: 1.8, circle: 0.7 }

function trimEnd(pts, len) {
  if (!len || pts.length < 2) return pts
  const a = pts[pts.length - 2], b = pts[pts.length - 1]
  const seg = Math.hypot(b.x - a.x, b.y - a.y)
  if (seg < 1) return pts
  const k = Math.min(len, seg - 0.5) / seg
  return [...pts.slice(0, -1), { x: b.x - (b.x - a.x) * k, y: b.y - (b.y - a.y) * k }]
}

function drawHead(ctx, kind, tip, angle, size, color, paper) {
  if (!kind || kind === 'none') return
  ctx.save()
  ctx.translate(tip.x, tip.y)
  ctx.rotate(angle)
  ctx.setLineDash([])
  ctx.fillStyle = color
  ctx.strokeStyle = color
  const L = size, W = size * 0.5
  ctx.beginPath()
  switch (kind) {
    case 'arrow':
      ctx.moveTo(0, 0); ctx.lineTo(-L, -W * 0.85); ctx.lineTo(-L * 0.78, 0); ctx.lineTo(-L, W * 0.85); ctx.closePath()
      ctx.fill()
      break
    case 'open':
      ctx.moveTo(-L, -W); ctx.lineTo(0, 0); ctx.lineTo(-L, W)
      ctx.stroke()
      break
    case 'triangle':
      ctx.moveTo(0, 0); ctx.lineTo(-L, -W * 1.1); ctx.lineTo(-L, W * 1.1); ctx.closePath()
      ctx.fillStyle = paper; ctx.fill(); ctx.stroke()
      break
    case 'diamond':
    case 'diamondFilled':
      ctx.moveTo(0, 0); ctx.lineTo(-L * 0.9, -W * 0.9); ctx.lineTo(-L * 1.8, 0); ctx.lineTo(-L * 0.9, W * 0.9); ctx.closePath()
      ctx.fillStyle = kind === 'diamond' ? paper : color
      ctx.fill(); ctx.stroke()
      break
    case 'circle':
      ctx.arc(-L * 0.35, 0, L * 0.35, 0, Math.PI * 2)
      ctx.fillStyle = paper; ctx.fill(); ctx.stroke()
      break
    default: {
      // ER crow's-foot family: one (||), many (<), oneMany (|<), zeroMany (o<)
      const crow = kind !== 'one'
      if (crow) {
        ctx.moveTo(-L, 0); ctx.lineTo(0, -W * 1.2)
        ctx.moveTo(-L, 0); ctx.lineTo(0, 0)
        ctx.moveTo(-L, 0); ctx.lineTo(0, W * 1.2)
      }
      if (kind === 'one' || kind === 'oneMany') {
        const x = kind === 'one' ? -L * 0.45 : -L * 1.25
        ctx.moveTo(x, -W); ctx.lineTo(x, W)
        if (kind === 'one') { ctx.moveTo(x - 5, -W); ctx.lineTo(x - 5, W) }
      }
      ctx.stroke()
      if (kind === 'zeroMany') {
        ctx.beginPath()
        ctx.arc(-L * 1.55, 0, W * 0.55, 0, Math.PI * 2)
        ctx.fillStyle = paper; ctx.fill(); ctx.stroke()
      }
    }
  }
  ctx.restore()
}

function roundedPolyline(ctx, pts, radius) {
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1]
    const r = Math.min(radius, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2)
    ctx.arcTo(b.x, b.y, c.x, c.y, r)
  }
  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y)
}

const angleAt = (pts, end) => {
  const [a, b] = end ? [pts[pts.length - 2], pts[pts.length - 1]] : [pts[1], pts[0]]
  return Math.atan2(b.y - a.y, b.x - a.x)
}

/**
 * Where a connector's label sits: centred on the wire's midpoint, or set beside
 * the wire when the wire is too short to carry it (so the label never hides it).
 */
export function edgeLabelBox(el, pts, measure = measureText) {
  if (!el.text) return null
  const p = pointAlong(pts, 0.5)
  const font = fontOf(el.size, el.font)
  const lines = wrapText(el.text, 220, font, measure)
  const lh = el.size * LINE_HEIGHT
  const w = Math.max(...lines.map((l) => measure(l, font))) + 12
  const h = lines.length * lh + 6
  let { x, y } = p
  if (polylineLength(pts) < Math.max(w, h) + 24) {
    const horizontal = Math.abs(Math.cos(p.angle)) > 0.5
    if (horizontal) y -= h / 2 + 6 + el.stroke
    else x += w / 2 + 6 + el.stroke
  }
  return { x: x - w / 2, y: y - h / 2, w, h, lines, font, lh }
}

export function drawEdge(ctx, el, pts, theme, { progress = 1, hideText = false } = {}) {
  if (!pts || pts.length < 2) return
  const color = colorOf(el.color, theme)
  const path = progress < 1 ? truncatePolyline(pts, progress) : pts
  if (path.length < 2 || polylineLength(path) < 0.5) return
  const size = headSize(el.stroke)
  let line = trimEnd(path, (TRIM[el.head] ?? 0) * size)
  if (progress >= 1) line = trimEnd([...line].reverse(), (TRIM[el.tail] ?? 0) * size).reverse()
  ctx.strokeStyle = color
  ctx.lineWidth = el.stroke
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash(dashOf(el.dash, el.stroke))
  ctx.beginPath()
  roundedPolyline(ctx, line, el.route === 'ortho' ? 10 : 0)
  ctx.stroke()
  ctx.lineWidth = Math.max(1.5, el.stroke * 0.9)
  drawHead(ctx, el.head, path[path.length - 1], angleAt(path, true), size, color, theme.paper)
  if (progress >= 1) drawHead(ctx, el.tail, path[0], angleAt(path, false), size, color, theme.paper)
  const box = !hideText && progress >= 1 && edgeLabelBox(el, pts)
  if (box) {
    ctx.fillStyle = theme.paper
    ctx.beginPath()
    ctx.roundRect(box.x, box.y, box.w, box.h, 5)
    ctx.fill()
    ctx.font = box.font
    ctx.fillStyle = color
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    drawLines(ctx, box.lines, box.x + box.w / 2, box.y + 3, box.lh)
  }
}

// ---- freehand ----

export function drawStroke(ctx, el, theme, { progress = 1 } = {}) {
  let pts = strokePoints(el)
  if (progress < 1) pts = truncatePolyline(pts, progress)
  if (!pts.length) return
  ctx.strokeStyle = colorOf(el.color, theme)
  ctx.lineWidth = el.marker ? el.stroke * 4 : el.stroke
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.setLineDash([])
  if (el.marker) ctx.globalAlpha *= 0.35
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  if (pts.length === 1) ctx.lineTo(pts[0].x + 0.1, pts[0].y)
  for (let i = 1; i < pts.length - 1; i++) {
    const m = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 }
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, m.x, m.y)
  }
  if (pts.length > 1) ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y)
  ctx.stroke()
}

/**
 * Draws elements in z order. `fx` (replay effects) maps id → { alpha, scale, progress, text };
 * `editing` hides the label being edited in the DOM textarea.
 */
export function drawScene(ctx, { elements, routes, theme, fx = null, editing = null, view = null }) {
  for (const el of elements) {
    // frames are slide boundaries (a camera, not content): the editor outlines them, exports and replays don't paint them
    if (el.shape === 'frame') continue
    const f = fx?.get(el.id)
    if (f && f.alpha <= 0) continue
    if (view && el.type !== 'edge' && !overlaps(el, view)) continue
    ctx.save()
    if (f) {
      ctx.globalAlpha = f.alpha ?? 1
      if (f.scale != null && f.scale !== 1 && el.type === 'node') {
        const c = center(el)
        ctx.translate(c.x, c.y)
        ctx.scale(f.scale, f.scale)
        ctx.translate(-c.x, -c.y)
      }
    }
    if (el.type === 'node') drawNode(ctx, el, theme, { text: f?.text ?? el.text, hideText: el.id === editing })
    else if (el.type === 'edge') drawEdge(ctx, el, routes.get(el.id), theme, { progress: f?.progress ?? 1, hideText: el.id === editing })
    else if (el.type === 'stroke') drawStroke(ctx, el, theme, { progress: f?.progress ?? 1 })
    ctx.restore()
  }
}

const overlaps = (el, v) => {
  const pad = el.shape === 'actor' ? 60 : 4
  return el.x - pad < v.x + v.w && el.x + el.w + pad > v.x && el.y - pad < v.y + v.h && el.y + el.h + pad * 2 > v.y
}
