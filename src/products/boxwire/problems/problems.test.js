// The problem set and its reference solutions: every solution compiles
// cleanly, lints with no violations or unknowns, has the parts the rubric and
// the walkthrough rely on, and is published byte-for-byte for agents.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { PROBLEMS, problemById } from './index.js'
import { compileDiagram } from '../author/compile.js'
import { NODE_KINDS } from '../author/vocabulary.js'
import { lint } from '../review/lint.js'
import { ROLES } from '../review/graph.js'
import { sourceLoad } from '../review/capacity.js'

const measure = (s, font) => s.length * Number(/(\d+)px/.exec(font)[1]) * 0.55
const SOLUTIONS = new URL('./solutions/', import.meta.url)
const PUBLIC = new URL('../../../../public/products/boxwire/examples/', import.meta.url)
const FILE = (id) => `${id}.boxwire-diagram.json`
const IDS = ['url-shortener', 'news-feed', 'chat', 'rate-limiter', 'notifications', 'web-crawler', 'typeahead', 'ride-hailing', 'video-streaming', 'payments', 'ticket-booking', 'file-sync']
const CLIENT_KINDS = new Set(ROLES.client)
const live = (src) => src.nodes.filter((n) => !n.crossed)

describe('problem set', () => {
  it('lists the twelve problems in order, with unique ids', () => {
    expect(PROBLEMS.map((p) => p.id)).toEqual(IDS)
    expect(new Set(PROBLEMS.map((p) => p.id)).size).toBe(PROBLEMS.length)
  })

  it('has exactly one solution file per problem', () => {
    const files = readdirSync(SOLUTIONS).filter((f) => f.endsWith('.json')).sort()
    expect(files).toEqual(IDS.map(FILE).sort())
  })

  it('looks problems up by id', () => {
    for (const p of PROBLEMS) expect(problemById(p.id)).toBe(p)
    expect(problemById('nope')).toBeNull()
  })

  it('gives every problem complete metadata', () => {
    for (const p of PROBLEMS) {
      expect(p.tag, p.id).toBe('HLD')
      for (const k of ['name', 'blurb', 'prompt']) expect(typeof p[k] === 'string' && p[k].length > 0, `${p.id}.${k}`).toBe(true)
      expect(p.functional.length, p.id).toBeGreaterThanOrEqual(3)
      expect(p.functional.length, p.id).toBeLessThanOrEqual(5)
      expect(p.nonFunctional.length, p.id).toBeGreaterThanOrEqual(3)
      expect(p.nonFunctional.length, p.id).toBeLessThanOrEqual(5)
      expect(p.estimates.length, p.id).toBeGreaterThanOrEqual(2)
      expect(p.estimates.length, p.id).toBeLessThanOrEqual(4)
      expect(p.deepDives.length, p.id).toBeGreaterThanOrEqual(2)
      expect(p.deepDives.length, p.id).toBeLessThanOrEqual(4)
      expect(typeof p.readHeavy, p.id).toBe('boolean')
      expect(p.components.length, p.id).toBeGreaterThanOrEqual(3)
      expect(p.components.length, p.id).toBeLessThanOrEqual(5)
      expect(new Set(p.components.map((c) => c.id)).size, p.id).toBe(p.components.length)
      for (const c of p.components) {
        expect(c.title && c.why, `${p.id}/${c.id}`).toBeTruthy()
        for (const k of c.anyOf) expect(Object.hasOwn(NODE_KINDS, k), `${p.id}/${c.id}: ${k}`).toBe(true)
      }
      expect(typeof p.solution, p.id).toBe('function')
    }
  })
})

for (const p of PROBLEMS) {
  describe(`${p.id} solution`, () => {
    const text = readFileSync(new URL(FILE(p.id), SOLUTIONS), 'utf8')
    const src = JSON.parse(text)
    const r = compileDiagram(src, { measure })

    it('compiles with no errors or warnings', () => {
      expect(r.errors).toEqual([])
      expect(r.warnings).toEqual([])
    })

    it('lints with no violations and no unknowns', () => {
      const res = lint(r.doc)
      const bad = [...res.violations, ...res.unknowns].map((x) => `${x.status} ${x.id}: ${x.message}`)
      expect(bad).toEqual([])
      expect(res.passes.length).toBeGreaterThan(0)
    })

    it('declares carries "reads" only from nodes that receive reads (a consumer reading a store uses "lookups")', () => {
      const { capacity } = lint(r.doc)
      const idle = src.edges.filter((e) => e.carries === 'reads' && [capacity.nodes.get(e.from).in.r].flat().every((v) => v === 0))
      expect(idle.map((e) => `${e.from} → ${e.to}`)).toEqual([])
    })

    it('has every must-have component, not crossed out', () => {
      const kinds = new Set(live(src).map((n) => n.kind))
      for (const c of p.components) expect(c.anyOf.some((k) => kinds.has(k)), `${c.id}: one of ${c.anyOf.join(', ')}`).toBe(true)
    })

    it('has a cache or CDN when the problem is read-heavy', () => {
      if (p.readHeavy) expect(live(src).some((n) => n.kind === 'cache' || n.kind === 'cdn')).toBe(true)
    })

    it('has requirements and trade-offs notes, a rejected option and a walkthrough', () => {
      const notes = src.nodes.filter((n) => n.kind === 'note').map((n) => n.label)
      const req = notes.find((l) => l.startsWith('Requirements'))
      const trade = notes.find((l) => l.startsWith('Trade-offs'))
      expect(req?.split('\n').length).toBeGreaterThanOrEqual(5)
      expect(trade?.split('\n').length).toBeGreaterThanOrEqual(4)
      expect(src.nodes.some((n) => n.crossed === true)).toBe(true)
      expect(src.frames.length).toBeGreaterThanOrEqual(2)
      expect(src.frames.length).toBeLessThanOrEqual(4)
    })

    it('stays readable: 10 to 22 nodes, short label lines', () => {
      expect(src.nodes.length).toBeGreaterThanOrEqual(10)
      expect(src.nodes.length).toBeLessThanOrEqual(22)
      for (const n of src.nodes) for (const line of String(n.label ?? '').split('\n')) expect(line.length, `${n.id}: ${line}`).toBeLessThanOrEqual(32)
    })

    it('has a client that declares load and its write payload', () => {
      const clients = live(src).filter((n) => CLIENT_KINDS.has(n.kind) && n.capacity && sourceLoad(n.capacity))
      expect(clients.length).toBeGreaterThan(0)
      expect(clients.every((n) => n.capacity.writeKB !== undefined)).toBe(true)
    })

    it('loads lazily as the same diagram', async () => {
      const mod = await p.solution()
      expect(mod.default).toEqual(src)
    })

    it('is published byte-for-byte for agents', () => {
      expect(readFileSync(new URL(FILE(p.id), PUBLIC)).equals(readFileSync(new URL(FILE(p.id), SOLUTIONS)))).toBe(true)
    })
  })
}

describe('url-shortener load', () => {
  it('derives write and read QPS from 100M URLs a month at 100:1', () => {
    const src = JSON.parse(readFileSync(new URL(FILE('url-shortener'), SOLUTIONS), 'utf8'))
    const cap = src.nodes.find((n) => n.id === 'client').capacity
    const { load } = sourceLoad(cap)
    const writes = (100e6 / (30 * 86400)) * cap.peak
    expect(load.w[0]).toBe(load.w[1])
    expect(Math.abs(load.w[0] - writes) / writes).toBeLessThan(0.01)
    expect(Math.abs(load.r[0] - writes * 100) / (writes * 100)).toBeLessThan(0.01)
  })
})
