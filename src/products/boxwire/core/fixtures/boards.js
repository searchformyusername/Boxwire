// Large boards for the routing gate (scripts/boxwire-route-gate.mjs) and its tests.
// - tiledReferences(edges): copies of the 12 reference designs laid out side by side until the board has
//   at least `edges` connectors: realistic local wiring at the scale of a big architecture board.
// - denseRandom(nodes): the change-review fixture (change/fixtures/large.js) compiled with auto layout:
//   eight tiers of up to 175 nodes, each node wired to random nodes of the next tier, so most connectors
//   are long and cross dense columns. An adversarial case, not a realistic board.

import fs from 'node:fs'
import { compileDiagram } from '../../author/compile.js'
import { largeSources } from '../../change/fixtures/large.js'

export const measure = (s, font) => s.length * Number(/(\d+)px/.exec(font)?.[1] ?? 14) * 0.55
const SOLUTIONS = new URL('../../problems/solutions/', import.meta.url)

export function referenceDocs() {
  return fs.readdirSync(SOLUTIONS).filter((f) => f.endsWith('.json')).sort().map((f) => ({ name: f.replace('.boxwire-diagram.json', ''), doc: compileDiagram(JSON.parse(fs.readFileSync(new URL(f, SOLUTIONS), 'utf8')), { measure }).doc }))
}

export function tiledReferences(minEdges = 2330) {
  const parts = referenceDocs().map((r) => r.doc)
  const doc = {}
  let edges = 0, k = 0
  while (edges < minEdges) {
    const els = Object.values(parts[k % parts.length]).filter((e) => e.type === 'node' || e.type === 'edge')
    const nodes = els.filter((e) => e.type === 'node')
    const x0 = Math.min(...nodes.map((n) => n.x)), y0 = Math.min(...nodes.map((n) => n.y))
    const ox = (k % 6) * 3200, oy = Math.floor(k / 6) * 2600
    const id = (x) => `t${k}-${x}`
    for (const e of els) {
      if (e.type === 'node') doc[id(e.id)] = { ...e, id: id(e.id), x: e.x - x0 + ox, y: e.y - y0 + oy, ...(e.members && { members: e.members.map(id) }) }
      else {
        doc[id(e.id)] = { ...e, id: id(e.id), from: { ...e.from, id: id(e.from.id) }, to: { ...e.to, id: id(e.to.id) } }
        edges++
      }
    }
    k++
  }
  return doc
}

export const denseRandom = (nodes = 1400) => compileDiagram(largeSources(nodes).prop, { measure }).doc
