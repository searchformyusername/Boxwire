// Vector export: the same frame renderer as PNG, drawn into the recording SVG
// context. Web fonts are inlined as data URLs because an SVG opened as an
// image can't fetch them.

import { createFrameRenderer } from './frame.js'
import { THEMES } from '../render/theme.js'
import { createSvgContext } from '../render/svgContext.js'
import { FONTS, measureText } from '../core/text.js'

// Same stylesheet Boxwire.jsx loads; index.html's Google Fonts link (IBM Plex Mono) is picked up from the page.
const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;600;650;700&display=swap'
const familyOf = (key) => FONTS[key].split(',')[0].trim().replace(/^["']|["']$/g, '')
const FAMILIES = new Set(Object.keys(FONTS).map(familyOf))

let probe = null
/** Offset from a canvas textBaseline to the alphabetic baseline, as the browser's canvas computes it. */
export function canvasBaseline(font, textBaseline) {
  probe ??= document.createElement('canvas').getContext('2d')
  probe.font = font
  probe.textBaseline = textBaseline
  return -probe.measureText('').alphabeticBaseline || 0
}

/**
 * Renders `doc` into an SVG string with the shared frame renderer: world rect
 * `camera` fills a width×height viewport, exactly as export/png.js draws it.
 */
export function renderSvgString(doc, { camera, width, height, theme = 'light', background = true, only = null, measure = measureText, baseline = null, fontCss = '', routes = null }) {
  const ctx = createSvgContext(width, height, { measure, baseline, fontCss })
  createFrameRenderer()(ctx, doc, { camera, width, height, theme: typeof theme === 'string' ? THEMES[theme] : theme, background, only, routes })
  return ctx.toString()
}

/** Every character a document's labels can paint (ER key flags are upper-cased). */
export const docText = (doc) => {
  const s = Object.values(doc).map((el) => el.text ?? '').join('\n')
  return s + s.toUpperCase()
}

const cssCache = new Map()
const fontCache = new Map()

const fetchOnce = (cache, url, read) => {
  if (!cache.has(url)) cache.set(url, fetch(url).then((r) => (r.ok ? read(r) : Promise.reject(new Error(r.status)))).catch((e) => { cache.delete(url); throw e }))
  return cache.get(url)
}

async function dataUrl(res) {
  const bytes = new Uint8Array(await res.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:${res.headers.get('content-type') || 'font/woff2'};base64,${btoa(bin)}`
}

function inRange(range, text) {
  const spans = range.split(',').map((r) => {
    const [a, b] = r.trim().replace(/^U\+/i, '').split('-')
    return a.includes('?') ? [parseInt(a.replace(/\?/g, '0'), 16), parseInt(a.replace(/\?/g, 'F'), 16)] : [parseInt(a, 16), parseInt(b ?? a, 16)]
  })
  for (const ch of text) {
    const c = ch.codePointAt(0)
    if (spans.some(([a, b]) => c >= a && c <= b)) return true
  }
  return false
}

/** First family name of each FONTS stack the document's elements use. */
export function docFamilies(doc) {
  const keys = new Set(['sans', ...Object.values(doc).map((el) => el.font).filter((f) => Object.hasOwn(FONTS, f))])
  return new Set([...keys].map(familyOf))
}

/**
 * @font-face rules for Boxwire's fonts with the files inlined, limited to
 * `families` and to the unicode subsets `text` uses. Faces sharing one
 * (variable) font file collapse into a single weight-range rule. Resolves to ''
 * when anything can't be fetched.
 */
export async function embedFontCss(text, families = FAMILIES) {
  if (!text || typeof document === 'undefined') return ''
  try {
    const hrefs = new Set([FONT_HREF, ...Array.from(document.querySelectorAll('link[rel="stylesheet"][href^="https://fonts.googleapis.com/"]'), (l) => l.href)])
    const sheets = await Promise.all([...hrefs].map((h) => fetchOnce(cssCache, h, (r) => r.text()).catch(() => '')))
    const faces = new Map()
    for (const css of sheets) {
      for (const [rule] of css.matchAll(/@font-face\s*\{[^}]*\}/g)) {
        const prop = (name) => new RegExp(`${name}:\\s*([^;}]+)`).exec(rule)?.[1].trim()
        const family = prop('font-family')?.replace(/^['"]|['"]$/g, '')
        const range = prop('unicode-range')
        const url = /url\(\s*['"]?([^)'"]+)['"]?\s*\)/.exec(rule)?.[1]
        if (!FAMILIES.has(family) || !families.has(family) || !url || (range && !inRange(range, text))) continue
        const key = [family, prop('font-style'), url, range].join('|')
        const weights = (prop('font-weight') ?? '400').split(/\s+/).map(Number)
        if (faces.has(key)) faces.get(key).weights.push(...weights)
        else faces.set(key, { rule, url, weights })
      }
    }
    const rules = [...faces.values()].map(({ rule, url, weights }) => fetchOnce(fontCache, url, dataUrl).then(
      (data) => rule
        .replace(/url\([^)]*\)/, `url(${data})`)
        .replace(/font-weight:[^;}]*/, `font-weight: ${[...new Set([Math.min(...weights), Math.max(...weights)])].join(' ')}`)
        .replace(/font-display:[^;}]*/, 'font-display: block'),
      () => '',
    ))
    return (await Promise.all(rules)).filter(Boolean).join('\n')
  } catch {
    return ''
  }
}

/**
 * Board (or selection) as a standalone SVG document. Camera, padding and the
 * selection filter match exportPng; `scale` multiplies the pixel size.
 */
export async function exportSvg(editor, { background = true, theme = editor.ui.theme, selectionOnly = false, padding = 32, scale = 1, embedFonts = true } = {}) {
  await document.fonts?.ready
  const els = selectionOnly && editor.ui.selection.length ? editor.selected() : editor.scene().elements
  const b = editor.contentBounds(els)
  if (!b) throw new Error('Nothing to export yet.')
  const camera = { x: b.x - padding, y: b.y - padding, w: b.w + padding * 2, h: b.h + padding * 2 }
  const width = Math.max(1, Math.round(camera.w * scale)), height = Math.max(1, Math.round(camera.h * scale))
  const only = selectionOnly && editor.ui.selection.length ? new Set(els.map((e) => e.id)) : null
  const fontCss = embedFonts ? await embedFontCss(docText(editor.doc), docFamilies(editor.doc)) : ''
  const svg = renderSvgString(editor.doc, { camera, width, height, theme, background, only, measure: editor.measure ?? measureText, baseline: canvasBaseline, fontCss })
  return { svg, width, height }
}

/** The SVG string as a downloadable Blob. */
export const svgBlob = (svg) => new Blob([svg], { type: 'image/svg+xml' })
