// Composition of the published reference designs: frames, notes and labels
// never collide. A reference is the first thing people see of Boxwire, so it
// has to read as composed, not merely valid. Text metrics are this suite's
// approximation (0.55 em per character), slightly wider than Inter, so a pass
// here leaves margin in the browser.

import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compileDiagram } from '../author/compile.js'
import { createRouter, routingObstacles } from '../core/edges.js'
import { framesOf } from '../core/elements.js'
import { inflate, intersects } from '../core/geometry.js'
import { edgeLabelBox } from '../render/draw.js'
import { elementBounds, frameTitleBox } from '../render/bounds.js'
import { PROBLEMS } from './index.js'

const measure = (s, font) => s.length * Number(/(\d+)px/.exec(font)[1]) * 0.55
const contains = (o, r) => r.x >= o.x && r.y >= o.y && r.x + r.w <= o.x + o.w && r.y + r.h <= o.y + o.h
const solution = (id) => JSON.parse(fs.readFileSync(new URL(`./solutions/${id}.boxwire-diagram.json`, import.meta.url), 'utf8'))

function scene(id) {
  const { doc } = compileDiagram(solution(id), { measure })
  const all = Object.values(doc)
  const nodes = all.filter((e) => e.type === 'node' && e.shape !== 'frame')
  const routes = createRouter()(doc, routingObstacles(nodes))
  const frames = framesOf(all)
  const boxes = nodes.filter((n) => n.shape !== 'zone').map((n) => ({ id: n.id, r: elementBounds(n, routes, measure) }))
  const labels = all.filter((e) => e.type === 'edge' && e.text).map((e) => ({ id: `label of ${e.id}`, r: edgeLabelBox(e, routes.get(e.id), measure) })).filter((l) => l.r)
  const titles = frames.map((f, i) => ({ id: `title of ${f.id}`, f, r: frameTitleBox(f, i, measure) }))
  return { frames, boxes, labels, titles }
}

describe.each(PROBLEMS.map((p) => p.id))('%s reference composition', (id) => {
  const { frames, boxes, labels, titles } = scene(id)

  it('keeps frame titles clear of every node, note, connector label and other title', () => {
    const hits = []
    for (const t of titles) {
      const pad = inflate(t.r, 4)
      for (const o of [...boxes, ...labels, ...titles.filter((x) => x !== t)]) if (intersects(pad, o.r)) hits.push(`${t.id} hits ${o.id}`)
    }
    expect(hits).toEqual([])
  })

  it('never overlaps two frames unless one is nested inside the other', () => {
    const hits = []
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) {
        const a = frames[i], b = frames[j]
        if (intersects(a, b) && !contains(a, b) && !contains(b, a)) hits.push(`${a.id} overlaps ${b.id}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('never lets a frame edge cut through a node or a note', () => {
    const hits = []
    for (const f of frames) for (const b of boxes) if (intersects(f, b.r) && !contains(f, b.r)) hits.push(`${f.id} cuts ${b.id}`)
    expect(hits).toEqual([])
  })

  it('never lets a frame edge cut through a connector label', () => {
    const hits = []
    for (const f of frames) for (const l of labels) if (intersects(f, l.r) && !contains(f, l.r)) hits.push(`${f.id} cuts ${l.id}`)
    expect(hits).toEqual([])
  })
})
