// Off-screen rendering of a document into a fixed camera — shared by PNG export and timelapse frames.

import { createRouter, routingObstacles } from '../core/edges.js'
import { isNode } from '../core/elements.js'
import { drawScene } from '../render/draw.js'
import { fontOf } from '../core/text.js'
import { docBounds } from '../render/bounds.js'

export function createFrameRenderer() {
  const router = createRouter()
  let last = { doc: null }

  function scene(doc, given) {
    if (last.doc !== doc || (given && last.routes !== given)) {
      const elements = Object.values(doc).sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1))
      // routes computed elsewhere for this same document (the routing worker) are used as they are
      last = { doc, elements, routes: given ?? router(doc, routingObstacles(elements.filter(isNode))) }
    }
    return last
  }

  /**
   * Draw `doc` so that world rect `camera` fills (letterboxed) a width×height canvas.
   * `only` limits what is drawn while routes still see the whole document, so a
   * selected connector keeps its real path even when its endpoints aren't drawn.
   */
  return function render(ctx, doc, { camera, width, height, theme, fx = null, background = true, watermark = false, only = null, routes = null }) {
    const s = Math.min(width / camera.w, height / camera.h)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    if (background) {
      ctx.fillStyle = theme.paper
      ctx.fillRect(0, 0, width, height)
    } else ctx.clearRect(0, 0, width, height)
    ctx.setTransform(s, 0, 0, s, (width - camera.w * s) / 2 - camera.x * s, (height - camera.h * s) / 2 - camera.y * s)
    const { elements, routes: paths } = scene(doc, routes)
    drawScene(ctx, { elements: only ? elements.filter((el) => only.has(el.id)) : elements, routes: paths, theme, fx })
    if (watermark) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      const size = Math.max(11, Math.round(height / 52))
      ctx.font = fontOf(size, 'sans', 600)
      ctx.textAlign = 'right'
      ctx.textBaseline = 'bottom'
      ctx.fillStyle = theme.muted
      ctx.globalAlpha = 0.75
      ctx.fillText('Boxwire · gitreset.dev', width - size, height - size * 0.8)
      ctx.globalAlpha = 1
    }
  }
}

/**
 * Fixed camera for a timelapse: the union of every step's visual bounds (routed
 * paths and labels included), so nothing ever leaves frame mid-replay.
 */
export function replayCamera(replay, { measure, pad = 40 } = {}) {
  const router = createRouter()
  const rects = []
  for (const doc of replay.docs) {
    const elements = Object.values(doc)
    const b = docBounds(elements, router(doc, routingObstacles(elements.filter(isNode))), measure)
    if (b) rects.push(b)
  }
  if (!rects.length) return null
  const x0 = Math.min(...rects.map((r) => r.x)), y0 = Math.min(...rects.map((r) => r.y))
  const x1 = Math.max(...rects.map((r) => r.x + r.w)), y1 = Math.max(...rects.map((r) => r.y + r.h))
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

export const safeName = (name) => (name || 'board').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'board'
