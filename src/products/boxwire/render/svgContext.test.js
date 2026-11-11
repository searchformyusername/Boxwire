import { describe, expect, it } from 'vitest'
import { arcSweep, createSvgContext, parseFont } from './svgContext.js'

const svgOf = (draw, w = 200, h = 100) => {
  const ctx = createSvgContext(w, h, { measure: (s) => s.length * 8 })
  draw(ctx)
  return ctx.toString()
}
const paths = (svg) => [...svg.matchAll(/<path ([^>]*)\/>/g)].map((m) => Object.fromEntries([...m[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])))
const texts = (svg) => [...svg.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)].map((m) => ({ ...Object.fromEntries([...m[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]])), body: m[2] }))
/** Absolute M/L/C/Q/Z commands → list of [cmd, ...numbers]. */
const cmds = (d) => [...d.matchAll(/([MLCQZ])([^MLCQZ]*)/g)].map((m) => [m[1], ...m[2].trim().split(/\s+/).filter(Boolean).map(Number)])
const ends = (d) => cmds(d).filter((c) => c[0] !== 'Z').map((c) => c.slice(-2))

describe('svg context paths', () => {
  it('records lines in device space and closes subpaths', () => {
    const [p] = paths(svgOf((c) => {
      c.beginPath(); c.moveTo(1, 2); c.lineTo(10.006, 2); c.lineTo(10, 20); c.closePath(); c.stroke()
    }))
    expect(p.d).toBe('M1 2L10.01 2L10 20Z')
    expect(p.fill).toBe('none')
    expect(p.stroke).toBe('#000000')
  })

  it('treats lineTo without a subpath as moveTo and drops lone moveTos', () => {
    const [p] = paths(svgOf((c) => { c.beginPath(); c.lineTo(5, 5); c.lineTo(6, 6); c.moveTo(50, 50); c.stroke() }))
    expect(p.d).toBe('M5 5L6 6')
  })

  it('roundRect starts after the top-left corner, goes clockwise, and scales radii that overflow', () => {
    const [p] = paths(svgOf((c) => { c.beginPath(); c.roundRect(0, 0, 100, 40, 10); c.fill() }))
    const c = cmds(p.d)
    expect(c[0]).toEqual(['M', 10, 0])
    expect(c[1]).toEqual(['L', 90, 0])
    expect(c[2].slice(-2)).toEqual([100, 10]) // top-right corner
    expect(c.at(-1)).toEqual(['Z'])
    expect(c.filter((x) => x[0] === 'C')).toHaveLength(4)
    // radius 30 on a 40 high box: scaled to 20 so both corners meet
    const [q] = paths(svgOf((c) => { c.beginPath(); c.roundRect(0, 0, 100, 40, 30); c.fill() }))
    expect(cmds(q.d)[0]).toEqual(['M', 20, 0])
    // [tl, tr, br, bl] with square bottom corners
    const [t] = paths(svgOf((c) => { c.beginPath(); c.roundRect(0, 0, 100, 40, [8, 8, 0, 0]); c.fill() }))
    expect(cmds(t.d).filter((x) => x[0] === 'C')).toHaveLength(2)
    expect(ends(t.d)).toContainEqual([100, 40])
    expect(ends(t.d)).toContainEqual([0, 40])
  })

  it('normalises ellipse sweeps like canvas', () => {
    const P = Math.PI
    expect(arcSweep(0, 2 * P, false)).toBeCloseTo(2 * P)
    expect(arcSweep(0, 5 * P, false)).toBeCloseTo(2 * P)
    expect(arcSweep(P, 0, true)).toBeCloseTo(-P) // cylinder caps
    expect(arcSweep(-P / 2, P / 2, true)).toBeCloseTo(-P) // queue detail
    expect(arcSweep(-P / 2, P / 2, false)).toBeCloseTo(P)
    expect(arcSweep(P / 2, 0, false)).toBeCloseTo(1.5 * P)
    expect(arcSweep(0, P / 2, true)).toBeCloseTo(-1.5 * P)
    expect(arcSweep(1, 1, false)).toBe(0)
  })

  it('anticlockwise half-ellipse runs through the bottom and joins the current point', () => {
    const [p] = paths(svgOf((c) => {
      c.beginPath(); c.moveTo(0, 0); c.lineTo(0, 50)
      c.ellipse(50, 50, 50, 10, 0, Math.PI, 0, true)
      c.stroke()
    }))
    const c = cmds(p.d)
    expect(c[1]).toEqual(['L', 0, 50]) // implicit lineTo to the start point lands on the existing point
    const curve = c.filter((x) => x[0] === 'C')
    expect(curve).toHaveLength(2)
    expect(curve[0].slice(-2)).toEqual([50, 60]) // bottom of the ellipse (y down)
    expect(curve[1].slice(-2)).toEqual([100, 50])
  })

  it('full ellipse splits into four quarter béziers on the ellipse', () => {
    const [p] = paths(svgOf((c) => { c.beginPath(); c.ellipse(100, 50, 40, 20, 0, 0, Math.PI * 2); c.fill() }))
    const e = ends(p.d)
    expect(e).toEqual([[140, 50], [100, 70], [60, 50], [100, 30], [140, 50]])
    // quarter-circle control points sit at the 0.5523 kappa
    expect(cmds(p.d)[1].slice(1, 3)).toEqual([140, 61.05])
  })

  it('arcTo rounds a corner with tangent points r / tan(θ/2) away', () => {
    const [p] = paths(svgOf((c) => { c.beginPath(); c.moveTo(0, 0); c.arcTo(100, 0, 100, 100, 10); c.lineTo(100, 100); c.stroke() }))
    const c = cmds(p.d)
    expect(c[1]).toEqual(['L', 90, 0])
    expect(c[2][0]).toBe('C')
    expect(c[2].slice(-2)).toEqual([100, 10])
    expect(c[3]).toEqual(['L', 100, 100])
    // collinear points and zero radius degrade to a line to (x1, y1)
    const [q] = paths(svgOf((c) => { c.beginPath(); c.moveTo(0, 0); c.arcTo(50, 0, 100, 0, 10); c.arcTo(50, 50, 0, 0, 0); c.stroke() }))
    expect(q.d).toBe('M0 0L50 0L50 50')
  })

  it('quadratic and cubic curves start a subpath at their first control point when needed', () => {
    const [p] = paths(svgOf((c) => { c.beginPath(); c.quadraticCurveTo(1, 1, 2, 0); c.bezierCurveTo(3, 3, 4, 4, 5, 0); c.stroke() }))
    expect(p.d).toBe('M1 1Q1 1 2 0C3 3 4 4 5 0')
  })
})

describe('svg context state and transforms', () => {
  it('applies translate+rotate to arrowhead points and scales stroke width and dashes by the CTM', () => {
    const svg = svgOf((c) => {
      c.setTransform(2, 0, 0, 2, 10, 0)
      c.save()
      c.translate(50, 20)
      c.rotate(Math.PI / 2)
      c.beginPath(); c.moveTo(0, 0); c.lineTo(-10, -5); c.lineTo(-10, 5); c.closePath()
      c.fill()
      c.restore()
      c.lineWidth = 3
      c.setLineDash([6, 4])
      c.beginPath(); c.moveTo(0, 0); c.lineTo(10, 0); c.stroke()
    })
    const [head, line] = paths(svg)
    // tip at (50,20) scaled ×2 and shifted 10; rotated 90° so "back" (-x) points up
    expect(ends(head.d)).toEqual([[110, 40], [120, 20], [100, 20]])
    expect(line['stroke-width']).toBe('6')
    expect(line['stroke-dasharray']).toBe('12 8')
  })

  it('save/restore covers styles, alpha, dash and transform but not the path', () => {
    const svg = svgOf((c) => {
      c.fillStyle = '#ff0000'
      c.beginPath(); c.moveTo(0, 0); c.lineTo(10, 0); c.lineTo(10, 10)
      c.save()
      c.fillStyle = '#00ff00'; c.globalAlpha = 0.5; c.setLineDash([1, 2]); c.translate(100, 100)
      c.restore()
      c.fill()
      c.stroke()
    })
    const [p] = paths(svg)
    expect(p.fill).toBe('#ff0000')
    expect(p['fill-opacity']).toBeUndefined()
    expect(p.d).toBe('M0 0L10 0L10 10')
    expect(p['stroke-dasharray']).toBeUndefined()
    expect(p.stroke).toBe('#000000') // merged into the fill element: same path, painted fill then stroke
  })

  it('maps globalAlpha and rgba() to per-paint opacity and ignores invalid values like canvas', () => {
    const svg = svgOf((c) => {
      c.globalAlpha = 0.5
      c.globalAlpha = 2 // ignored
      c.lineWidth = -1 // ignored
      c.fillStyle = 'rgba(30, 31, 36, 0.5)'
      c.fillRect(0, 0, 10, 10)
    })
    expect(svg).toContain('<rect x="0" y="0" width="10" height="10" fill="rgb(30,31,36)" fill-opacity="0.25"/>')
  })

  it('duplicates odd dash lists and rejects negative ones', () => {
    const c = createSvgContext(10, 10)
    c.setLineDash([1, 2, 3])
    expect(c.getLineDash()).toEqual([1, 2, 3, 1, 2, 3])
    c.setLineDash([1, -2])
    expect(c.getLineDash()).toEqual([1, 2, 3, 1, 2, 3])
  })

  it('strokes a Path2D carrying `.d` with the CTM as a transform', () => {
    const svg = svgOf((c) => {
      c.translate(10, 20); c.scale(0.5, 0.5); c.lineWidth = 2; c.lineCap = 'round'; c.lineJoin = 'round'
      c.stroke({ d: 'M0 0h24' })
    })
    const [p] = paths(svg)
    expect(p).toMatchObject({ d: 'M0 0h24', transform: 'matrix(0.5 0 0 0.5 10 20)', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
  })

  it('clearing the whole surface drops earlier output', () => {
    const svg = svgOf((c) => { c.fillRect(0, 0, 5, 5); c.clearRect(0, 0, 200, 100) })
    expect(svg).not.toContain('<rect')
  })
})

describe('svg context text', () => {
  it('parses the canvas font shorthand', () => {
    expect(parseFont('italic 700 14px "IBM Plex Mono", monospace')).toEqual({ style: 'italic', weight: '700', size: 14, family: '"IBM Plex Mono", monospace' })
    expect(parseFont('10px sans-serif')).toEqual({ style: 'normal', weight: '400', size: 10, family: 'sans-serif' })
    expect(parseFont('nonsense')).toBeNull()
  })

  it('escapes text, preserves spaces and maps align/baseline', () => {
    const svg = svgOf((c) => {
      c.font = '600 16px Inter, "Helvetica Neue", sans-serif'
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.fillStyle = '#123456'
      c.setTransform(2, 0, 0, 2, 0, 0)
      c.fillText('  a < b & "c"\t', 10, 20)
      c.textAlign = 'right'
      c.fillText('x', 0, 0)
      c.textAlign = 'left'
      c.textBaseline = 'alphabetic'
      c.fillText('y', 0, 0)
      c.fillText('', 0, 0)
    })
    const [a, b, y] = texts(svg)
    expect(a).toMatchObject({ x: '20', y: '40', 'font-size': '32', 'font-weight': '600', 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: '#123456', 'xml:space': 'preserve' })
    expect(a['font-family']).toBe('Inter, &quot;Helvetica Neue&quot;, sans-serif')
    expect(a.body).toBe('  a &lt; b &amp; &quot;c&quot; ')
    expect(b['text-anchor']).toBe('end')
    expect(y['text-anchor']).toBeUndefined()
    expect(y['dominant-baseline']).toBeUndefined()
    expect(texts(svg)).toHaveLength(3)
  })

  it('uses a transform for rotated text and an injected baseline offset when given', () => {
    const ctx = createSvgContext(100, 100, { baseline: (font, b) => (b === 'middle' ? 5 : 0) })
    ctx.font = '500 10px Inter'
    ctx.textBaseline = 'middle'
    ctx.translate(50, 50)
    ctx.rotate(Math.PI / 2)
    ctx.fillText('hi', 1, 2)
    const [t] = texts(ctx.toString())
    expect(t).toMatchObject({ x: '1', y: '7', 'font-size': '10', transform: 'matrix(0 1 -1 0 50 50)' })
    expect(t['dominant-baseline']).toBeUndefined()
  })

  it('measureText uses the injected measure with the current font', () => {
    const seen = []
    const ctx = createSvgContext(10, 10, { measure: (s, f) => (seen.push(f), s.length * 3) })
    ctx.font = '450 14px Inter'
    expect(ctx.measureText('abcd').width).toBe(12)
    expect(seen).toEqual(['450 14px Inter'])
  })

  it('embeds font CSS in a CDATA style block', () => {
    const ctx = createSvgContext(10, 10)
    ctx.fontCss = '@font-face{font-family:Inter;src:url(data:font/woff2;base64,AAAA)}'
    expect(ctx.toString()).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="10" height="10" viewBox="0 0 10 10"><style><!\[CDATA\[@font-face/)
  })
})
