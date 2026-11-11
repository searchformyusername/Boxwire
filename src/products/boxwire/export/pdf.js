// Vector PDF: one page per frame (or one page for the whole board), each page
// the same SVG the SVG export produces (so still the single renderer), drawn
// into the PDF by svg2pdf.js on jsPDF. Text stays text, so it is selectable
// and searchable. Both libraries are MIT and load only when a PDF is made.
//
// PDFs can only embed TrueType fonts, and Boxwire's Inter ships as WOFF2, so
// labels are set in the PDF's standard Helvetica (Courier for mono): metrics
// differ slightly from the screen, positions don't.

import { framesOf, isFrame } from '../core/elements.js'
import { canvasBaseline, renderSvgString } from './svg.js'

/** Page rects in world space: each frame (with its title) or the whole board. */
export function pageRects(editor, { padding = 24 } = {}) {
  const frames = framesOf(editor.scene().nodes)
  const rects = frames.length
    ? frames.map((f) => ({ title: f.text || 'Frame', b: editor.boundsOf(f) }))
    : [{ title: 'Board', b: editor.contentBounds(editor.scene().elements.filter((el) => !isFrame(el))) }]
  return rects.filter((r) => r.b).map(({ title, b }) => ({ title, camera: { x: b.x - padding, y: b.y - padding, w: b.w + padding * 2, h: b.h + padding * 2 } }))
}

// The standard fonts only cover WinAnsi; these are the symbols labels commonly use beyond it.
const ASCII = { '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '≈': '~', '≤': '<=', '≥': '>=', '≠': '!=', '✓': 'v', '✗': 'x', '−': '-', '∞': 'inf', '…': '...' }
const ASCII_RE = new RegExp(`[${Object.keys(ASCII).join('')}]`, 'g')

/** Map Boxwire's font stacks onto the PDF standard fonts svg2pdf knows, and their missing symbols onto ASCII. */
const pdfFonts = (svg) => svg
  .replace(/font-family="[^"]*Plex Mono[^"]*"/g, 'font-family="courier"')
  .replace(/font-family="[^"]*Inter[^"]*"/g, 'font-family="helvetica"')
  // the standard fonts come in regular and bold only; svg2pdf falls back to Times for numeric weights
  .replace(/font-weight="(\d+)"/g, (_, w) => `font-weight="${Number(w) >= 600 ? 'bold' : 'normal'}"`)
  .replace(ASCII_RE, (c) => ASCII[c])

/**
 * Build the PDF. Returns { blob, pages }. `theme` picks the palette (light by
 * default: PDFs are for printing and sharing).
 */
export async function exportPdf(editor, { theme = 'light', title = 'Boxwire board' } = {}) {
  await document.fonts?.ready
  const pages = pageRects(editor)
  if (!pages.length) throw new Error('Nothing to export yet.')
  const [{ jsPDF }, { svg2pdf }] = await Promise.all([import('jspdf'), import('svg2pdf.js')])
  let pdf = null
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:0;height:0;overflow:hidden'
  document.body.appendChild(host)
  try {
    for (const { camera } of pages) {
      const width = Math.ceil(camera.w), height = Math.ceil(camera.h)
      const orientation = width >= height ? 'landscape' : 'portrait'
      if (!pdf) pdf = new jsPDF({ unit: 'px', format: [width, height], orientation, hotfixes: ['px_scaling'], compress: true })
      else pdf.addPage([width, height], orientation)
      const svg = pdfFonts(renderSvgString(editor.doc, { camera, width, height, theme, baseline: canvasBaseline }))
      host.innerHTML = svg
      await svg2pdf(host.firstElementChild, pdf, { x: 0, y: 0, width, height })
      host.innerHTML = ''
    }
    pdf.setProperties({ title, creator: 'Boxwire · gitreset.dev' })
    return { blob: pdf.output('blob'), pages: pages.length }
  } finally {
    host.remove()
  }
}
