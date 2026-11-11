// Visual bounds: the area an element actually paints, including routed
// detours, connector labels, stroke width and actor captions. One definition
// shared by zoom-to-fit, PNG export and the timelapse camera.

import { boundsOfPoints, inflate, union } from '../core/geometry.js'
import { LINE_HEIGHT, fontOf, measureText } from '../core/text.js'
import { edgeLabelBox } from './draw.js'

export function elementBounds(el, routes, measure = measureText) {
  if (el.type === 'edge') {
    const pts = routes.get(el.id)
    if (!pts) return null
    const head = 12 + el.stroke * 2.5 // arrowheads and crow's feet spill sideways off the line
    return union([inflate(boundsOfPoints(pts), head), edgeLabelBox(el, pts, measure)].filter(Boolean))
  }
  if (el.type === 'stroke') return inflate(el, el.stroke * (el.marker ? 2 : 0.5) + 1)
  if (el.shape === 'frame') return { x: el.x, y: el.y - el.size * LINE_HEIGHT - 8, w: el.w, h: el.h + el.size * LINE_HEIGHT + 8 }
  if (el.shape === 'actor') return { x: el.x - 40, y: el.y, w: el.w + 80, h: el.h + 4 + el.size * LINE_HEIGHT * 2 }
  return el
}

/** A frame's title as shown: its label, numbered by slide position unless the label starts with a number. */
export const frameTitle = (f, i) => {
  const t = f.text || 'Frame'
  return /^\d/.test(t) ? t : `${i + 1} · ${t}`
}
export const frameTitleFont = (f) => fontOf(f.size, 'sans', 600)

/** World rect of a frame's title, which sits just above its top-left corner (scales with the board). */
export function frameTitleBox(f, i, measure = measureText) {
  const h = f.size * LINE_HEIGHT
  return { x: f.x, y: f.y - h - 6, w: measure(frameTitle(f, i), frameTitleFont(f)) + 4, h }
}

export const docBounds = (elements, routes, measure) => union(elements.map((el) => elementBounds(el, routes, measure)).filter(Boolean))
