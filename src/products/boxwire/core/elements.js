// Element model: factories, shape metadata, and content-driven sizing.
//
// node   { id, type:'node', shape, x, y, w, h, z, text, icon?, crossed?, ...style }
// edge   { id, type:'edge', from: End, to: End, route, head, tail, text, z, ...style }
//        End = { id, side?, t? } bound to a node, or { x, y } free
// stroke { id, type:'stroke', x, y, w, h, pw, ph, pts:[dx,dy,...], z, color, stroke, marker? }

import { diamondPolygon, ellipsePolygon, hexagonPolygon, rectPolygon } from './geometry.js'
import { LINE_HEIGHT, fontOf, measureText, splitSections, wrapText } from './text.js'

/** Random element id. It always starts with a letter so it is also a valid source id (author/vocabulary.js ID_PATTERN). */
export const uid = () => {
  const b = crypto.getRandomValues(new Uint8Array(8))
  return String.fromCharCode(97 + (b[0] % 26)) + Array.from(b.subarray(1), (x) => (x % 36).toString(36)).join('')
}

export const DEFAULT_STYLE = { color: 'ink', fill: 'paper', dash: 'solid', stroke: 2, font: 'sans', size: 16 }

/**
 * Shape metadata. `pad` is the text inset; `spread` lets several edges share a face;
 * `fit` says how content drives size: 'grow' (height grows to fit text),
 * 'content' (width and height follow text), 'sections' (UML/ER compartments).
 * `style` overrides the default style for new shapes of that kind.
 */
export const SHAPES = {
  rect: { name: 'Box', size: [160, 72], pad: 12, spread: true, fit: 'grow' },
  ellipse: { name: 'Ellipse', size: [150, 84], pad: 22, outline: ellipsePolygon, fit: 'grow' },
  diamond: { name: 'Decision', size: [160, 100], pad: 34, outline: diamondPolygon, fit: 'grow' },
  hexagon: { name: 'Hexagon', size: [160, 80], pad: 28, outline: hexagonPolygon, fit: 'grow' },
  cylinder: { name: 'Database', size: [130, 100], pad: 14, padTop: 26, spread: true, fit: 'grow' },
  queue: { name: 'Queue', size: [190, 64], pad: 16, padRight: 44, spread: true, fit: 'grow' },
  cloud: { name: 'Cloud', size: [180, 104], pad: 30, outline: ellipsePolygon, fit: 'grow' },
  actor: { name: 'Actor', size: [70, 110], pad: 0, fit: 'grow', style: { fill: 'none' } },
  component: { name: 'Component', size: [180, 64], pad: 12, padLeft: 50, spread: true, fit: 'grow' },
  note: { name: 'Note', size: [200, 110], pad: 14, align: 'left', valign: 'top', spread: true, fit: 'grow', style: { color: 'amber', fill: 'tint' } },
  text: { name: 'Text', size: [60, 28], pad: 4, fit: 'content', obstacle: false, style: { fill: 'none' } },
  frame: { name: 'Frame', size: [640, 400], pad: 0, align: 'left', valign: 'top', spread: true, fit: 'none', obstacle: false, hitBorder: true, frame: true, style: { color: 'slate', fill: 'none', dash: 'solid', stroke: 1, size: 14 } },
  zone: { name: 'Zone', size: [400, 260], pad: 12, align: 'left', valign: 'top', spread: true, fit: 'none', obstacle: false, hitBorder: true, style: { color: 'slate', fill: 'tint', dash: 'dashed', size: 14 } },
  class: { name: 'Class', size: [220, 120], pad: 10, spread: true, fit: 'sections', style: { font: 'mono' } },
  table: { name: 'Table', size: [230, 120], pad: 10, spread: true, fit: 'sections', style: { font: 'mono' } },
}

export const shapeOf = (el) => SHAPES[el.shape] ?? SHAPES.rect
export const outlineOf = (el) => (shapeOf(el).outline ?? rectPolygon)(el)

export function makeNode(shape, x, y, props = {}) {
  const meta = SHAPES[shape]
  const [w, h] = meta.size
  return { id: uid(), type: 'node', shape, x, y, w, h, z: 0, text: '', ...DEFAULT_STYLE, ...meta.style, ...props }
}

export function makeEdge(from, to, props = {}) {
  return { id: uid(), type: 'edge', from, to, route: 'ortho', head: 'arrow', tail: 'none', text: '', z: 0, ...DEFAULT_STYLE, size: 14, ...props }
}

export function makeStroke(points, props = {}) {
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y)
  const x = Math.min(...xs), y = Math.min(...ys)
  const pw = Math.max(1, Math.max(...xs) - x), ph = Math.max(1, Math.max(...ys) - y)
  const pts = points.flatMap((p) => [Math.round((p.x - x) * 10) / 10, Math.round((p.y - y) * 10) / 10])
  return { id: uid(), type: 'stroke', x, y, w: pw, h: ph, pw, ph, pts, z: 0, color: 'red', stroke: 3, ...props }
}

/** World-space points of a stroke, honouring resize. */
export function strokePoints(el) {
  const sx = el.w / el.pw, sy = el.h / el.ph
  const out = []
  for (let i = 0; i < el.pts.length; i += 2) out.push({ x: el.x + el.pts[i] * sx, y: el.y + el.pts[i + 1] * sy })
  return out
}

/** Rect where a node's label is laid out. */
export function textRect(el) {
  const m = shapeOf(el)
  const l = m.padLeft ?? m.pad, r = m.padRight ?? m.pad, t = m.padTop ?? m.pad
  if (el.shape === 'actor') return { x: el.x - 40, y: el.y + el.h + 4, w: el.w + 80, h: el.size * LINE_HEIGHT * 2 }
  if (el.shape === 'frame') return { x: el.x + 2, y: el.y - el.size * LINE_HEIGHT - 6, w: Math.max(8, el.w - 4), h: el.size * LINE_HEIGHT }
  return { x: el.x + l, y: el.y + t, w: Math.max(8, el.w - l - r), h: Math.max(8, el.h - t - m.pad) }
}

export const labelFont = (el, weight = 500) => fontOf(el.size, el.font, weight)

/** Section layout for UML classes and ER tables: one row height for everything keeps it predictable. */
export function sectionLayout(el, measure = measureText) {
  const sections = splitSections(el.text || '')
  const row = Math.round(el.size * 0.875 * LINE_HEIGHT)
  const font = fontOf(Math.round(el.size * 0.875), el.font)
  const pad = shapeOf(el).pad
  const out = []
  let y = 0
  sections.forEach((lines, i) => {
    const rows = i === 0 ? Math.max(1, lines.length) : lines.length
    const h = rows ? rows * row + pad * (i === 0 ? 1.4 : 1) : pad
    out.push({ lines, y, h })
    y += h
  })
  if (!out.length) out.push({ lines: [''], y: 0, h: row + pad * 1.4 })
  const widest = Math.max(0, ...sections.flat().map((s) => measure(s, font)))
  return { sections: out, row, height: Math.max(y, row + pad * 1.4), width: widest + pad * 2 }
}

/**
 * Sizes a node to its content after a text, font or width change.
 * Returns the same object when nothing changes so history stays clean.
 */
export function fitNode(el, measure = measureText) {
  const m = shapeOf(el)
  let { w, h } = el
  if (m.fit === 'sections') {
    const lay = sectionLayout(el, measure)
    w = Math.max(w, Math.ceil(lay.width))
    h = Math.ceil(lay.height)
  } else if (m.fit === 'content') {
    const font = labelFont(el)
    const lines = String(el.text || ' ').split('\n')
    w = Math.ceil(Math.max(24, ...lines.map((s) => measure(s, font))) + m.pad * 2)
    h = Math.ceil(lines.length * el.size * LINE_HEIGHT + m.pad * 2)
  } else if (m.fit === 'grow' && el.text && el.shape !== 'actor') {
    const box = textRect(el)
    const lines = wrapText(el.text, box.w, labelFont(el), measure)
    const need = lines.length * el.size * LINE_HEIGHT + (el.h - box.h)
    h = Math.max(m.size[1] * 0.5, el.h, Math.ceil(need))
  }
  return w === el.w && h === el.h ? el : { ...el, w, h }
}

export const isNode = (el) => el?.type === 'node'
/** Frames are presentation slides: named, ordered rectangles that never take part in routing or the architecture graph. */
export const isFrame = (el) => el?.type === 'node' && el.shape === 'frame'
/** Zones and frames contain other shapes rather than taking part in layout among them. */
export const isContainer = (el) => el?.shape === 'zone' || el?.shape === 'frame'
export const framesOf = (elements) => elements.filter(isFrame).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : 1))
export const isEdge = (el) => el?.type === 'edge'
