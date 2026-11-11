// Dev-only fidelity check (browser): renders a board through the PNG path and
// through the SVG export rasterised back by the browser, and counts pixels
// that differ. Load lazily: `await import('/src/products/boxwire/export/svgCheck.js')`.

import { createRouter, routingObstacles } from '../core/edges.js'
import { isNode } from '../core/elements.js'
import { measureText } from '../core/text.js'
import { docBounds } from '../render/bounds.js'
import { THEMES } from '../render/theme.js'
import { createFrameRenderer } from './frame.js'
import { canvasBaseline, docFamilies, docText, embedFontCss, renderSvgString, svgBlob } from './svg.js'

// A pixel differs when any RGBA channel is off by more than this (of 255): it
// ignores antialiasing noise between the two rasterisers but catches anything misplaced.
const THRESHOLD = 40

function canvasOf(width, height) {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  return c
}

async function rasterise(svg, width, height) {
  const url = URL.createObjectURL(svgBlob(svg))
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const c = canvasOf(width, height)
    c.getContext('2d').drawImage(img, 0, 0, width, height)
    return c
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Compares the SVG export with the PNG export of an editor or a bare doc map.
 * Returns { width, height, differingPixels, ratio, svgBytes }, plus data URLs of
 * both renders and a diff mask when `debug` is set. `baseline: null` places text
 * with SVG dominant-baseline instead of canvas metrics.
 */
export async function compareSvgToPng(source, { theme = 'light', scale = 2, padding = 32, background = true, embedFonts = true, baseline = canvasBaseline, threshold = THRESHOLD, debug = false } = {}) {
  await document.fonts?.ready
  const doc = source.doc && source.store ? source.doc : source
  const measure = source.measure ?? measureText
  const elements = Object.values(doc)
  const b = source.contentBounds ? source.contentBounds() : docBounds(elements, createRouter()(doc, routingObstacles(elements.filter(isNode))), measure)
  if (!b) throw new Error('Nothing to compare.')
  const camera = { x: b.x - padding, y: b.y - padding, w: b.w + padding * 2, h: b.h + padding * 2 }
  const width = Math.max(1, Math.round(camera.w * scale)), height = Math.max(1, Math.round(camera.h * scale))
  const opts = { camera, width, height, theme: THEMES[theme], background }

  const png = canvasOf(width, height)
  createFrameRenderer()(png.getContext('2d'), doc, opts)
  const fontCss = embedFonts ? await embedFontCss(docText(doc), docFamilies(doc)) : ''
  const svg = renderSvgString(doc, { ...opts, measure, baseline, fontCss })
  const raster = await rasterise(svg, width, height)

  const a = png.getContext('2d').getImageData(0, 0, width, height).data
  const r = raster.getContext('2d').getImageData(0, 0, width, height).data
  const mask = debug ? new ImageData(width, height) : null
  let differing = 0
  for (let i = 0; i < a.length; i += 4) {
    const off = Math.abs(a[i] - r[i]) > threshold || Math.abs(a[i + 1] - r[i + 1]) > threshold || Math.abs(a[i + 2] - r[i + 2]) > threshold || Math.abs(a[i + 3] - r[i + 3]) > threshold
    if (off) differing++
    if (mask) mask.data.set(off ? [255, 0, 0, 255] : [a[i], a[i + 1], a[i + 2], 40], i)
  }
  const out = { width, height, differingPixels: differing, ratio: differing / (width * height), svgBytes: new Blob([svg]).size, embeddedFonts: !!fontCss }
  if (debug) {
    const m = canvasOf(width, height)
    m.getContext('2d').putImageData(mask, 0, 0)
    Object.assign(out, { svg, png: png.toDataURL(), raster: raster.toDataURL(), diff: m.toDataURL() })
  }
  return out
}
