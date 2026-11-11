// A recording stand-in for CanvasRenderingContext2D that emits SVG. It
// implements only the subset draw.js and export/frame.js use, with canvas
// semantics: points are transformed by the CTM when added, arcs become cubic
// béziers, and each fill/stroke/fillText is its own painted element.

const TAU = Math.PI * 2

/** Rounds to ≤ `d` decimals, without "-0". */
const num = (v, d = 2) => {
  const r = Number(v.toFixed(d))
  return String(r === 0 ? 0 : r)
}
const pt = (p) => num(p[0]) + ' ' + num(p[1])

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
// eslint-disable-next-line no-control-regex
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')

/** Splits a CSS colour into an SVG paint and an opacity (rgba() is not SVG 1.1). */
function paint(color) {
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(color)
  if (m) {
    const a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
    return { color: `rgb(${m[1]},${m[2]},${m[3]})`, alpha: a }
  }
  if (/^transparent$/i.test(color)) return { color: '#000', alpha: 0 }
  return { color, alpha: 1 }
}

/** Parses the CSS font shorthand that canvas accepts (as produced by text.js fontOf). */
export function parseFont(font) {
  const m = /^\s*((?:(?:normal|italic|oblique|small-caps|bold|bolder|lighter|\d{1,4})\s+)*)([\d.]+)px(?:\s*\/\s*\S+)?\s+(.+?)\s*$/i.exec(font)
  if (!m) return null
  let style = 'normal', weight = '400'
  for (const t of m[1].trim().split(/\s+/).filter(Boolean)) {
    if (/^(italic|oblique)$/i.test(t)) style = t.toLowerCase()
    else if (/^bold$/i.test(t)) weight = '700'
    else if (/^\d+$/.test(t)) weight = t
  }
  return { style, weight, size: parseFloat(m[2]), family: m[3] }
}

const ANCHOR = { left: 'start', start: 'start', center: 'middle', right: 'end', end: 'end' }
// canvas textBaseline → SVG dominant-baseline (canvas 'middle' is the middle of the em box)
const BASELINE = { top: 'text-before-edge', hanging: 'hanging', middle: 'central', alphabetic: null, ideographic: 'ideographic', bottom: 'text-after-edge' }

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
]
const finite = (...v) => v.every(Number.isFinite)

/** Canvas sweep for ellipse()/arc(): Chromium's AdjustEndAngle, as a signed sweep. */
export function arcSweep(start, end, anticlockwise) {
  if (!anticlockwise && end - start >= TAU) return TAU
  if (anticlockwise && start - end >= TAU) return -TAU
  if (!anticlockwise && start > end) return TAU - ((start - end) % TAU)
  if (anticlockwise && start < end) return -(TAU - ((end - start) % TAU))
  return end - start
}

/** Cubic segments (≤ 90° each) for an elliptical arc, in user space. */
function arcCubics(cx, cy, rx, ry, rot, start, sweep) {
  const cr = Math.cos(rot), sr = Math.sin(rot)
  const at = (t) => [cx + rx * Math.cos(t) * cr - ry * Math.sin(t) * sr, cy + rx * Math.cos(t) * sr + ry * Math.sin(t) * cr]
  const tan = (t) => [-rx * Math.sin(t) * cr - ry * Math.cos(t) * sr, -rx * Math.sin(t) * sr + ry * Math.cos(t) * cr]
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9))
  const d = sweep / n, k = (4 / 3) * Math.tan(d / 4)
  const out = []
  for (let i = 0; i < n; i++) {
    const t0 = start + d * i, t1 = t0 + d
    const p0 = at(t0), p1 = at(t1), d0 = tan(t0), d1 = tan(t1)
    out.push([[p0[0] + k * d0[0], p0[1] + k * d0[1]], [p1[0] - k * d1[0], p1[1] - k * d1[1]], p1])
  }
  return { first: at(start), cubics: out }
}

/**
 * A Canvas2D-compatible context that records drawing as SVG.
 * `measure(text, font)` backs measureText; `baseline(font, textBaseline)`, when
 * given, returns the offset from the textBaseline line down to the alphabetic
 * baseline so text is placed without dominant-baseline. `toString()` returns
 * the standalone document; set `fontCss` first to embed @font-face rules.
 */
export function createSvgContext(width, height, { measure = (s) => s.length * 8, baseline = null, fontCss = '' } = {}) {
  const items = []
  const stack = []
  let st = {
    m: [1, 0, 0, 1, 0, 0], fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
    miterLimit: 10, dash: [], dashOffset: 0, alpha: 1, font: '10px sans-serif', parsed: parseFont('10px sans-serif'),
    textAlign: 'start', textBaseline: 'alphabetic',
  }
  // current path, in device coordinates
  let segs = [], cur = null, start = null, pendingMove = false

  const tx = (x, y) => [st.m[0] * x + st.m[2] * y + st.m[4], st.m[1] * x + st.m[3] * y + st.m[5]]
  const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))
  const inv = (p) => {
    const [a, b, c, d, e, f] = st.m, det = a * d - b * c
    if (!det) return null
    const x = p[0] - e, y = p[1] - f
    return [(d * x - c * y) / det, (a * y - b * x) / det]
  }

  const devMove = (p) => { cur = p; start = p; pendingMove = true }
  const flushMove = () => {
    if (pendingMove) segs.push('M' + pt(cur))
    pendingMove = false
  }
  const devLine = (p) => {
    if (!cur) return devMove(p)
    if (!pendingMove && pt(p) === pt(cur)) return void (cur = p) // e.g. an arc's implicit lineTo onto the current point
    flushMove()
    segs.push('L' + pt(p))
    cur = p
  }
  const devCubic = (a, b, p) => {
    flushMove()
    segs.push('C' + pt(a) + ' ' + pt(b) + ' ' + pt(p))
    cur = p
  }
  const ensure = (x, y) => { if (!cur) devMove(tx(x, y)) }

  function addArc(cx, cy, rx, ry, rot, a0, sweep, connect = true) {
    const { first, cubics } = arcCubics(cx, cy, rx, ry, rot, a0, sweep)
    const p = tx(first[0], first[1])
    if (connect) {
      if (cur) devLine(p)
      else devMove(p)
    }
    for (const [a, b, q] of cubics) devCubic(tx(a[0], a[1]), tx(b[0], b[1]), tx(q[0], q[1]))
  }

  const pathD = () => segs.join('')
  const paintAttrs = (style, kind) => {
    const p = paint(style)
    const a = p.alpha * st.alpha
    return { [kind]: p.color, [kind + '-opacity']: a < 1 ? num(a, 3) : null }
  }
  const strokeAttrs = (k) => ({
    ...paintAttrs(st.strokeStyle, 'stroke'),
    'stroke-width': num(st.lineWidth * k, 3),
    'stroke-linecap': st.lineCap === 'butt' ? null : st.lineCap,
    'stroke-linejoin': st.lineJoin === 'miter' ? null : st.lineJoin,
    'stroke-miterlimit': st.lineJoin === 'miter' && st.miterLimit !== 4 ? num(st.miterLimit) : null,
    'stroke-dasharray': st.dash.length ? st.dash.map((v) => num(v * k, 3)).join(' ') : null,
    'stroke-dashoffset': st.dash.length && st.dashOffset ? num(st.dashOffset * k, 3) : null,
  })
  const matrix = (m) => `matrix(${m.slice(0, 4).map((v) => num(v, 5)).join(' ')} ${num(m[4], 3)} ${num(m[5], 3)})`

  function doFill(d, rule, transform = null) {
    if (!d) return
    items.push({ tag: 'path', a: { d, ...paintAttrs(st.fillStyle, 'fill'), 'fill-rule': rule === 'evenodd' ? 'evenodd' : null, transform } })
  }
  function doStroke(d, transform = null) {
    if (!d) return
    const k = transform ? 1 : scaleOf(st.m)
    const s = strokeAttrs(k)
    const last = items[items.length - 1]
    // a stroke right after a fill of the same path paints in the same order as one element
    if (last && last.tag === 'path' && last.a.d === d && last.a.transform === transform && !last.a.stroke) Object.assign(last.a, s)
    else items.push({ tag: 'path', a: { d, fill: 'none', ...s, transform } })
  }
  const pathOf = (p) => (p && typeof p.d === 'string' ? p.d : null)

  const ctx = {
    width, height, fontCss,
    get canvas() { return { width, height } },

    save() { stack.push({ ...st, m: [...st.m], dash: [...st.dash] }) },
    restore() { if (stack.length) st = stack.pop() },

    setTransform(a, b, c, d, e, f) {
      if (typeof a === 'object' && a) ({ a, b, c, d, e, f } = a)
      if (finite(a, b, c, d, e, f)) st.m = [a, b, c, d, e, f]
    },
    resetTransform() { st.m = [1, 0, 0, 1, 0, 0] },
    getTransform() { const [a, b, c, d, e, f] = st.m; return { a, b, c, d, e, f } },
    transform(a, b, c, d, e, f) { if (finite(a, b, c, d, e, f)) st.m = mul(st.m, [a, b, c, d, e, f]) },
    translate(x, y) { if (finite(x, y)) st.m = mul(st.m, [1, 0, 0, 1, x, y]) },
    scale(x, y) { if (finite(x, y)) st.m = mul(st.m, [x, 0, 0, y, 0, 0]) },
    rotate(t) {
      if (!finite(t)) return
      const c = Math.cos(t), s = Math.sin(t)
      st.m = mul(st.m, [c, s, -s, c, 0, 0])
    },

    beginPath() { segs = []; cur = null; start = null; pendingMove = false },
    moveTo(x, y) { if (finite(x, y)) devMove(tx(x, y)) },
    lineTo(x, y) { if (finite(x, y)) devLine(tx(x, y)) },
    closePath() {
      if (!cur) return
      if (!pendingMove) segs.push('Z')
      cur = start
    },
    bezierCurveTo(ax, ay, bx, by, x, y) {
      if (!finite(ax, ay, bx, by, x, y)) return
      ensure(ax, ay)
      devCubic(tx(ax, ay), tx(bx, by), tx(x, y))
    },
    quadraticCurveTo(qx, qy, x, y) {
      if (!finite(qx, qy, x, y)) return
      ensure(qx, qy)
      flushMove()
      const q = tx(qx, qy), p = tx(x, y)
      segs.push('Q' + pt(q) + ' ' + pt(p))
      cur = p
    },
    rect(x, y, w, h) {
      if (!finite(x, y, w, h)) return
      devMove(tx(x, y)); devLine(tx(x + w, y)); devLine(tx(x + w, y + h)); devLine(tx(x, y + h))
      ctx.closePath()
    },
    ellipse(x, y, rx, ry, rot, a0, a1, ccw = false) {
      if (!finite(x, y, rx, ry, rot, a0, a1)) return
      if (rx < 0 || ry < 0) throw new RangeError('The radius provided is negative.')
      addArc(x, y, rx, ry, rot, a0, arcSweep(a0, a1, !!ccw))
    },
    arc(x, y, r, a0, a1, ccw = false) {
      if (!finite(x, y, r, a0, a1)) return
      if (r < 0) throw new RangeError('The radius provided is negative.')
      addArc(x, y, r, r, 0, a0, arcSweep(a0, a1, !!ccw))
    },
    arcTo(x1, y1, x2, y2, r) {
      if (!finite(x1, y1, x2, y2, r)) return
      if (r < 0) throw new RangeError('The radius provided is negative.')
      ensure(x1, y1)
      const p0 = inv(cur)
      if (!p0) return
      const d1x = p0[0] - x1, d1y = p0[1] - y1, d2x = x2 - x1, d2y = y2 - y1
      const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y)
      const cross = (x1 - p0[0]) * (y2 - y1) - (y1 - p0[1]) * (x2 - x1)
      if (!l1 || !l2 || !r || Math.abs(cross) < 1e-9 * l1 * l2) return devLine(tx(x1, y1))
      const u1 = [d1x / l1, d1y / l1], u2 = [d2x / l2, d2y / l2]
      const theta = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])))
      const t = r / Math.tan(theta / 2)
      const t1 = [x1 + u1[0] * t, y1 + u1[1] * t], t2 = [x1 + u2[0] * t, y1 + u2[1] * t]
      const bx = u1[0] + u2[0], by = u1[1] + u2[1], bl = Math.hypot(bx, by), h = r / Math.sin(theta / 2)
      const c = [x1 + (bx / bl) * h, y1 + (by / bl) * h]
      const a0 = Math.atan2(t1[1] - c[1], t1[0] - c[0])
      const sweep = (cross > 0 ? 1 : -1) * (Math.PI - theta)
      devLine(tx(t1[0], t1[1]))
      addArc(c[0], c[1], r, r, 0, a0, sweep, false)
      cur = tx(t2[0], t2[1])
    },
    roundRect(x, y, w, h, radii = 0) {
      if (!finite(x, y, w, h)) return
      const list = (Array.isArray(radii) ? radii : [radii]).map((r) => (typeof r === 'number' ? { x: r, y: r } : { x: r?.x ?? 0, y: r?.y ?? 0 }))
      if (list.length < 1 || list.length > 4) throw new RangeError('roundRect needs 1 to 4 radii.')
      if (list.some((r) => !finite(r.x, r.y))) return
      if (list.some((r) => r.x < 0 || r.y < 0)) throw new RangeError('The radius provided is negative.')
      const [l0, l1 = l0, l2 = l0, l3 = l1] = list
      let tl = l0, tr = l1, br = l2, bl = l3
      if (w < 0) { x += w; w = -w; [tl, tr, br, bl] = [tr, tl, bl, br] }
      if (h < 0) { y += h; h = -h; [tl, tr, br, bl] = [bl, br, tr, tl] }
      const fit = (len, sum) => (sum > 0 ? len / sum : 1)
      const f = Math.min(1, fit(w, tl.x + tr.x), fit(h, tr.y + br.y), fit(w, br.x + bl.x), fit(h, bl.y + tl.y))
      if (f < 1) [tl, tr, br, bl] = [tl, tr, br, bl].map((r) => ({ x: r.x * f, y: r.y * f }))
      const H = Math.PI / 2
      devMove(tx(x + tl.x, y))
      devLine(tx(x + w - tr.x, y))
      if (tr.x && tr.y) addArc(x + w - tr.x, y + tr.y, tr.x, tr.y, 0, -H, H)
      devLine(tx(x + w, y + h - br.y))
      if (br.x && br.y) addArc(x + w - br.x, y + h - br.y, br.x, br.y, 0, 0, H)
      devLine(tx(x + bl.x, y + h))
      if (bl.x && bl.y) addArc(x + bl.x, y + h - bl.y, bl.x, bl.y, 0, H, H)
      devLine(tx(x, y + tl.y))
      if (tl.x && tl.y) addArc(x + tl.x, y + tl.y, tl.x, tl.y, 0, Math.PI, H)
      ctx.closePath()
      devMove(tx(x, y))
    },

    fill(a, b) {
      if (a && typeof a === 'object') return doFill(pathOf(a), b, matrix(st.m))
      doFill(pathD(), a)
    },
    stroke(path) {
      if (path) return doStroke(pathOf(path), matrix(st.m))
      doStroke(pathD())
    },
    fillRect(x, y, w, h) {
      if (!finite(x, y, w, h) || !w || !h) return
      const [, b, c] = st.m
      if (b === 0 && c === 0) {
        const p = tx(Math.min(x, x + w), Math.min(y, y + h)), q = tx(Math.max(x, x + w), Math.max(y, y + h))
        const x0 = Math.min(p[0], q[0]), y0 = Math.min(p[1], q[1])
        items.push({ tag: 'rect', a: { x: num(x0), y: num(y0), width: num(Math.abs(q[0] - p[0])), height: num(Math.abs(q[1] - p[1])), ...paintAttrs(st.fillStyle, 'fill') } })
        return
      }
      const ps = [tx(x, y), tx(x + w, y), tx(x + w, y + h), tx(x, y + h)]
      doFill('M' + ps.map(pt).join('L') + 'Z')
    },
    clearRect(x, y, w, h) {
      // SVG can't erase; clearing the whole surface (frame.js without a background) drops what came before
      const p = tx(x, y), q = tx(x + w, y + h)
      if (Math.min(p[0], q[0]) <= 0 && Math.min(p[1], q[1]) <= 0 && Math.max(p[0], q[0]) >= width && Math.max(p[1], q[1]) >= height) items.length = 0
    },

    fillText(text, x, y) {
      const s = String(text).replace(/[\t\n\f\r\v]/g, ' ')
      if (!s || !finite(x, y) || !st.parsed) return
      const f = st.parsed
      const [a, b, c, d] = st.m
      const plain = b === 0 && c === 0 && a === d && a > 0
      const k = plain ? a : 1
      const dy = baseline ? baseline(st.font, st.textBaseline) : 0
      const p = plain ? tx(x, y + dy) : [x, y + dy]
      items.push({
        tag: 'text',
        text: s,
        a: {
          x: num(p[0]), y: num(p[1]),
          'font-family': f.family, 'font-size': num(f.size * k, 3),
          'font-weight': f.weight === '400' ? null : f.weight,
          'font-style': f.style === 'normal' ? null : f.style,
          'text-anchor': ANCHOR[st.textAlign] === 'start' ? null : ANCHOR[st.textAlign],
          'dominant-baseline': baseline ? null : BASELINE[st.textBaseline],
          ...paintAttrs(st.fillStyle, 'fill'),
          transform: plain ? null : matrix(st.m),
        },
      })
    },
    measureText(text) { return { width: measure(String(text), st.font) } },

    setLineDash(list) {
      if (!Array.isArray(list) || list.some((v) => !Number.isFinite(v) || v < 0)) return
      st.dash = list.length % 2 ? [...list, ...list] : [...list]
    },
    getLineDash() { return [...st.dash] },

    get fillStyle() { return st.fillStyle },
    set fillStyle(v) { if (typeof v === 'string') st.fillStyle = v },
    get strokeStyle() { return st.strokeStyle },
    set strokeStyle(v) { if (typeof v === 'string') st.strokeStyle = v },
    get lineWidth() { return st.lineWidth },
    set lineWidth(v) { if (Number.isFinite(v) && v > 0) st.lineWidth = v },
    get lineCap() { return st.lineCap },
    set lineCap(v) { if (['butt', 'round', 'square'].includes(v)) st.lineCap = v },
    get lineJoin() { return st.lineJoin },
    set lineJoin(v) { if (['miter', 'round', 'bevel'].includes(v)) st.lineJoin = v },
    get miterLimit() { return st.miterLimit },
    set miterLimit(v) { if (Number.isFinite(v) && v > 0) st.miterLimit = v },
    get lineDashOffset() { return st.dashOffset },
    set lineDashOffset(v) { if (Number.isFinite(v)) st.dashOffset = v },
    get globalAlpha() { return st.alpha },
    set globalAlpha(v) { if (Number.isFinite(v) && v >= 0 && v <= 1) st.alpha = v },
    get font() { return st.font },
    set font(v) {
      const p = parseFont(String(v))
      if (p) { st.font = String(v); st.parsed = p }
    },
    get textAlign() { return st.textAlign },
    set textAlign(v) { if (Object.hasOwn(ANCHOR, v)) st.textAlign = v },
    get textBaseline() { return st.textBaseline },
    set textBaseline(v) { if (Object.hasOwn(BASELINE, v)) st.textBaseline = v },

    /** The standalone SVG document recorded so far. */
    toString() {
      const body = items.map(serialize).join('')
      const style = ctx.fontCss ? `<style><![CDATA[${ctx.fontCss}]]></style>` : ''
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${style}${body}</svg>`
    },
  }
  return ctx
}

function serialize({ tag, a, text }) {
  let s = '<' + tag
  for (const k in a) if (a[k] != null) s += ` ${k}="${esc(a[k])}"`
  return text == null ? s + '/>' : s + ` xml:space="preserve">${esc(text)}</${tag}>`
}
