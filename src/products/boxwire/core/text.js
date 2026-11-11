// Text measurement and layout. The measure function is injectable so layout is testable without a canvas.

export const FONTS = {
  sans: 'Inter, "Helvetica Neue", Arial, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
}
export const LINE_HEIGHT = 1.35

export const fontOf = (size, family = 'sans', weight = 500, italic = false) =>
  `${italic ? 'italic ' : ''}${weight} ${size}px ${FONTS[family] ?? FONTS.sans}`

let ctx = null
const widthCache = new Map()

/** Widths measured with a fallback font are wrong once the real font arrives. */
export const clearMeasureCache = () => widthCache.clear()

export function measureText(str, font) {
  const key = font + '\u0000' + str
  let w = widthCache.get(key)
  if (w === undefined) {
    ctx ??= document.createElement('canvas').getContext('2d')
    ctx.font = font
    w = ctx.measureText(str).width
    if (widthCache.size > 5000) widthCache.clear()
    widthCache.set(key, w)
  }
  return w
}

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
const graphemes = (s) => (segmenter ? Array.from(segmenter.segment(s), (g) => g.segment) : Array.from(s))

/** Splits an overlong token into chunks that fit, never inside a grapheme (emoji, accents). */
function breakToken(token, maxWidth, font, measure) {
  const chars = graphemes(token)
  const out = []
  while (chars.length) {
    let lo = 1, hi = chars.length // largest prefix that fits, at least one grapheme
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (measure(chars.slice(0, mid).join(''), font) <= maxWidth) lo = mid
      else hi = mid - 1
    }
    out.push(chars.splice(0, lo).join(''))
  }
  return out
}

/** Greedy word wrap; tokens wider than a line are broken across lines. */
export function wrapText(text, maxWidth, font, measure = measureText) {
  const lines = []
  for (const para of String(text).split('\n')) {
    let line = ''
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue
      if (measure(line + word, font) <= maxWidth) {
        line += word
        continue
      }
      if (line.trim()) lines.push(line.trimEnd())
      const token = word.trimStart()
      if (!token) {
        line = ''
        continue
      }
      const parts = measure(token, font) > maxWidth ? breakToken(token, maxWidth, font, measure) : [token]
      lines.push(...parts.slice(0, -1))
      line = parts[parts.length - 1]
    }
    lines.push(line.trimEnd())
  }
  return lines
}

/** UML / ER text uses lines of dashes to separate compartments; consecutive separators make empty ones. */
export function splitSections(text) {
  const sections = [[]]
  for (const line of String(text).split('\n')) {
    if (/^\s*-{2,}\s*$/.test(line)) sections.push([])
    else sections[sections.length - 1].push(line)
  }
  return sections
}
