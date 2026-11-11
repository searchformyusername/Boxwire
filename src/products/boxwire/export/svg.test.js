import { beforeAll, describe, expect, it } from 'vitest'
import { SHAPES, makeEdge, makeNode, makeStroke } from '../core/elements.js'
import { THEMES } from '../render/theme.js'
import { TEMPLATES, buildTemplate } from '../templates.js'
import { createEditor } from '../editor/editor.js'

const measure = (s) => s.length * 8
const HEADS = ['none', 'arrow', 'open', 'triangle', 'diamond', 'diamondFilled', 'circle', 'one', 'many', 'oneMany', 'zeroMany']

let renderSvgString, docText
beforeAll(async () => {
  // node has no canvas: draw.js wraps labels with the default measure, and icons build a Path2D
  globalThis.document ??= { createElement: () => ({ getContext: () => ({ font: '', measureText: (s) => ({ width: measure(s) }) }) }) }
  globalThis.Path2D ??= class Path2D {}
  ;({ renderSvgString, docText } = await import('./svg.js'))
})

/** Minimal XML well-formedness check: balanced tags, quoted attributes, escaped text. */
function assertWellFormed(xml) {
  const stack = []
  let i = 0
  const text = (s) => expect(s).not.toMatch(/<|&(?!(amp|lt|gt|quot|apos);)/)
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) { text(xml.slice(i)); break }
    text(xml.slice(i, lt))
    if (xml.startsWith('<![CDATA[', lt)) { i = xml.indexOf(']]>', lt) + 3; expect(i).toBeGreaterThan(2); continue }
    const gt = xml.indexOf('>', lt)
    const tag = xml.slice(lt + 1, gt)
    if (tag.startsWith('/')) expect(stack.pop()).toBe(tag.slice(1))
    else {
      const m = /^([\w:-]+)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)$/.exec(tag)
      expect(m, tag).not.toBeNull()
      for (const [, v] of m[2].matchAll(/="([^"]*)"/g)) text(v)
      if (!m[3]) stack.push(m[1])
    }
    i = gt + 1
  }
  expect(stack).toEqual([])
}

function everythingDoc() {
  const doc = {}
  const add = (el) => (doc[el.id] = el)
  let x = 0, z = 1
  for (const shape of Object.keys(SHAPES)) {
    add({ ...makeNode(shape, x, 0, { text: shape === 'zone' ? 'VPC & <private>' : `${shape} label`, z: z++ }), id: 'n-' + shape })
    x += 260
  }
  add({ ...makeNode('component', 0, 300, { text: 'API', icon: 'server', z: z++ }), id: 'comp' })
  add({ ...makeNode('component', 0, 400, { text: 'Cache', icon: 'database', fill: 'solid', z: z++ }), id: 'comp2' })
  add({ ...makeNode('rect', 260, 300, { text: 'gone', crossed: true, dash: 'dotted', z: z++ }), id: 'crossed' })
  add({ ...makeNode('class', 600, 300, { text: '«interface»\nShape\n---\n- id: int {static}\n---\n+ area(): float {abstract}', w: 240, h: 160, z: z++ }), id: 'cls' })
  add({ ...makeNode('table', 900, 300, { text: 'users\n---\nid uuid PK\norg_id uuid FK\nemail text', w: 240, h: 140, z: z++ }), id: 'tbl' })
  HEADS.forEach((head, k) => {
    add({ ...makeEdge({ x: 0, y: 700 + k * 60 }, { x: 400, y: 700 + k * 60 }, { head, tail: HEADS[(k + 3) % HEADS.length], text: k % 3 ? '' : 'label ' + head, dash: ['solid', 'dashed', 'dotted'][k % 3], z: z++ }), id: 'e-' + head })
  })
  add({ ...makeEdge({ id: 'comp' }, { id: 'tbl' }, { route: 'ortho', text: 'reads', z: z++ }), id: 'wire' })
  add({ ...makeStroke([{ x: 500, y: 700 }, { x: 540, y: 760 }, { x: 600, y: 720 }, { x: 650, y: 790 }], { z: z++ }), id: 'ink' })
  add({ ...makeStroke([{ x: 500, y: 900 }, { x: 700, y: 900 }], { marker: true, z: z++ }), id: 'marker' })
  return doc
}

const camera = { x: -60, y: -60, w: 3800, h: 1500 }
const render = (doc, theme = 'light', more = {}) => renderSvgString(doc, { camera, width: 1900, height: 750, theme, measure, ...more })

describe('renderSvgString', () => {
  it('draws every shape, arrowhead, stroke, icon, class and table as well-formed vector SVG', () => {
    const svg = render(everythingDoc())
    assertWellFormed(svg)
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="1900" height="750" viewBox="0 0 1900 750">/)
    expect(svg).not.toContain('<image')
    expect(svg).toContain(`<rect x="0" y="0" width="1900" height="750" fill="${THEMES.light.paper}"/>`)
    expect(svg).toContain('VPC &amp; &lt;private&gt;')
    expect(svg).toContain('«interface»')
    expect(svg).toMatch(/<path d="M[^"]*a[^"]*"[^>]* transform="matrix\(/) // lucide icon path stroked through its CTM
    expect(svg).toMatch(/stroke-dasharray="/)
    expect(svg).toMatch(/stroke-opacity="0\.35"/) // marker stroke
    expect(svg).toMatch(/fill-opacity="0\.7"/) // muted ER column type
    expect((svg.match(/<text /g) ?? []).length).toBeGreaterThan(20)
  })

  it('is deterministic', () => {
    const doc = everythingDoc()
    expect(render(doc, 'dark')).toBe(render(doc, 'dark'))
    expect(render(doc, 'dark')).not.toBe(render(doc, 'light'))
  })

  it('omits the background when asked and only draws `only`', () => {
    const doc = everythingDoc()
    const svg = render(doc, 'light', { background: false, only: new Set(['comp']) })
    expect(svg).not.toContain(`fill="${THEMES.light.paper}"/>`)
    expect((svg.match(/<text /g) ?? []).length).toBe(1)
  })

  it('renders every starter template', () => {
    for (const t of TEMPLATES) {
      const editor = createEditor({ measure })
      buildTemplate(editor, t)
      const b = editor.contentBounds()
      const svg = renderSvgString(editor.doc, { camera: { x: b.x - 32, y: b.y - 32, w: b.w + 64, h: b.h + 64 }, width: Math.round(b.w + 64), height: Math.round(b.h + 64), theme: 'dark', measure })
      assertWellFormed(svg)
      expect(svg).not.toContain('<image')
      expect(svg).not.toMatch(/NaN|undefined|Infinity/)
    }
  })

  it('docText covers labels and upper-cased ER flags', () => {
    expect(docText({ a: { text: 'id pk' }, b: {} })).toContain('PK')
  })
})
