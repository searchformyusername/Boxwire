// Collaboration readiness: two people edit the same commented source on their own canvases, with no server;
// their texts are merged by mergeSources. The gates (DESIGN.md, "Concurrent edits"):
// G1 symmetric and deterministic; G2 conflict-free merges keep every change of both sides and compile;
// G3 nothing is overwritten silently (both sides changed the same thing → a conflict card); G4 resolving
// the cards either way gives a valid board; G5 idempotent; G6 comments kept; G7 fast at scale.

import fs from 'node:fs'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { compileDiagram } from '../author/compile.js'
import { createDocStore } from '../core/history.js'
import { makeEdge, makeNode } from '../core/elements.js'
import { parseSource } from '../source/cst.js'
import { createSourceSession } from '../source/session.js'
import { allChanges, diffModels } from './diff.js'
import { canon, checkValue } from './model.js'
import { mergeSources, resolveSources } from './collab.js'
import { largeSources } from './fixtures/large.js'

const measure = (s, font) => s.length * Number(/(\d+)px/.exec(font)?.[1] ?? 16) * 0.55
const BASE = fs.readFileSync(new URL('../source/fixtures/review-baseline.boxwire.jsonc', import.meta.url), 'utf8')
const value = (t) => parseSource(t).value
const comments = (t) => t.split('\n').map((l) => /\/\/.*|\/\*.*?\*\//.exec(l)?.[0]?.trim()).filter(Boolean)

function rng(seed) {
  let x = seed >>> 0
  return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32)
}

/** One person's session on BASE: a few random canvas edits, written back to the source as the app does. */
function editSession(seed, steps = 3) {
  const r = compileDiagram(value(BASE), { measure })
  const store = createDocStore({ base: r.board.base, done: r.board.done })
  const session = createSourceSession({ store, text: BASE, measure })
  const rnd = rng(seed), pick = (a) => a[Math.floor(rnd() * a.length)]
  for (let s = 0; s < steps; s++) {
    const doc = store.doc
    const nodes = Object.values(doc).filter((e) => e.type === 'node' && e.shape !== 'zone' && e.shape !== 'frame')
    const edges = Object.values(doc).filter((e) => e.type === 'edge')
    const n = pick(nodes), op = Math.floor(rnd() * 7)
    if (op === 0) store.set(n.id, { ...n, text: `${n.text || n.id} v${seed % 7}` }, 'text')
    else if (op === 1) store.set(n.id, { ...n, x: n.x + 40 + Math.floor(rnd() * 80), y: n.y + 20 }, 'move')
    else if (op === 2) store.set(n.id, { ...n, cap: { ...(n.cap ?? {}), replicas: 2 + Math.floor(rnd() * 4) } }, 'capacity')
    else if (op === 3) {
      const id = `n${seed}x${s}`
      store.apply([[id, { ...makeNode('rect', 1500 + s * 200, 800 + (seed % 5) * 120, { kind: 'service', text: `New ${seed}` }), id, z: 900 + s }], [`e${seed}x${s}`, { ...makeEdge({ id: n.id }, { id }), id: `e${seed}x${s}`, z: 901 + s }]], 'add')
    } else if (op === 4 && edges.length) {
      const e = pick(edges), to = pick(nodes)
      if (to.id !== e.from.id && to.id !== e.to.id) store.set(e.id, { ...e, to: { ...e.to, id: to.id } }, 'reconnect')
    } else if (op === 5) {
      store.apply([[n.id, null], ...edges.filter((e) => e.from.id === n.id || e.to.id === n.id).map((e) => [e.id, null])], 'delete')
    } else {
      store.set(n.id, { ...n, meta: { ...(n.meta ?? {}), owner: `team-${seed % 3}` } }, 'meta')
    }
  }
  session.dispose()
  return session.text
}

const PAIRS = Array.from({ length: 120 }, (_, i) => [editSession(1000 + i), editSession(5000 + i)])

describe('concurrent edits of one source, merged without a server', () => {
  it('G1: symmetric and deterministic: either order gives the same text and the same cards (sides swapped)', () => {
    for (const [a, b] of PAIRS) {
      const ab = mergeSources({ base: BASE, ours: a, theirs: b }), ba = mergeSources({ base: BASE, ours: b, theirs: a })
      expect(ab.error).toBeUndefined()
      expect(ba.text).toBe(ab.text)
      expect(ba.conflicts.map((c) => c.id)).toEqual(ab.conflicts.map((c) => c.id))
      for (let k = 0; k < ab.conflicts.length; k++) {
        expect(canon(ba.conflicts[k].ours)).toBe(canon(ab.conflicts[k].theirs))
        expect(canon(ba.conflicts[k].theirs)).toBe(canon(ab.conflicts[k].ours))
      }
      expect(mergeSources({ base: BASE, ours: a, theirs: b }).text).toBe(ab.text)
    }
  })

  it('G2: a conflict-free merge keeps every change of both sides, compiles, and its text reads back as its model', () => {
    let clean = 0
    for (const [a, b] of PAIRS) {
      const m = mergeSources({ base: BASE, ours: a, theirs: b })
      expect(value(m.text)).toEqual(m.value)
      if (m.conflicts.length) continue
      clean++
      expect(m.unsupported).toEqual([])
      expect(checkValue(m.value).errors).toEqual([])
      expect(keepsBoth(value(BASE), value(a), value(b), m.value)).toEqual([])
    }
    expect(clean).toBeGreaterThan(40) // the generator really produces both kinds of pair
    console.log(`collab gate: ${PAIRS.length} concurrent pairs, ${clean} conflict-free, ${PAIRS.length - clean} with cards`)
  })

  it('G3: nothing is overwritten silently: a field both sides changed differently is always a card', () => {
    let cards = 0
    for (const [a, b] of PAIRS) {
      const m = mergeSources({ base: BASE, ours: a, theirs: b })
      const ca = new Map(allChanges(diffModels(value(BASE), value(a))).map((c) => [c.id, c])), cb = allChanges(diffModels(value(BASE), value(b)))
      const conflicted = new Set(m.conflicts.flatMap((c) => [...c.changes.ours, ...c.changes.theirs]))
      for (const c of cb) {
        const o = ca.get(c.id)
        if (o && c.type === 'change' && canon(o.after) !== canon(c.after)) expect(conflicted.has(c.id), c.id).toBe(true)
      }
      cards += m.conflicts.length
      for (const c of m.conflicts) expect(c.message).toMatch(/\S/)
    }
    expect(cards).toBeGreaterThan(20)
    console.log(`collab gate: ${cards} conflict cards in total`)
  })

  it('G4: resolving every card to either side gives a valid board, written as minimal edits', () => {
    for (const [a, b] of PAIRS) {
      const m = mergeSources({ base: BASE, ours: a, theirs: b })
      if (!m.conflicts.length) continue
      for (const side of ['ours', 'theirs']) {
        const r = resolveSources({ base: BASE, ours: a, theirs: b }, m, Object.fromEntries(m.conflicts.map((c) => [c.id, side])))
        expect(r.unresolved).toEqual([])
        expect(checkValue(r.value).errors, side).toEqual([])
        expect(value(r.text)).toEqual(r.value)
      }
    }
  })

  it('G5: idempotent: merging an edit with itself, or with the untouched base, gives that edit', () => {
    for (const [a] of PAIRS.slice(0, 40)) {
      const real = (x, y) => allChanges(diffModels(x, y)).filter((c) => c.class !== 'identity')
      const same = mergeSources({ base: BASE, ours: a, theirs: a })
      expect(same.conflicts).toEqual([])
      expect(real(same.value, value(a))).toEqual([])
      const one = mergeSources({ base: BASE, ours: BASE, theirs: a })
      expect(one.conflicts).toEqual([])
      expect(real(one.value, value(a))).toEqual([])
    }
  })

  it('G6: comments both sides kept are in the merge; comments on what either side added come with it', () => {
    for (const [a, b] of PAIRS) {
      const m = mergeSources({ base: BASE, ours: a, theirs: b })
      const kept = comments(a).filter((c) => comments(b).includes(c) && comments(BASE).includes(c))
      for (const c of kept) expect(m.text, c).toContain(c)
    }
    const withNote = (t, id) => t.replace(`{ "id": "${id}"`, `// added by its owner\n    { "id": "${id}"`)
    const a = withNote(BASE.replace('"nodes": [', '"nodes": [\n    { "id": "audit", "kind": "service" },'), 'audit')
    const m = mergeSources({ base: BASE, ours: a, theirs: BASE.replace('"label": "API gateway"', '"label": "Edge gateway"') })
    expect(m.conflicts).toEqual([])
    expect(m.text).toContain('// added by its owner')
    expect(m.text).toContain('"label": "Edge gateway"')
  })

  it('G7: two small edits of a 1,400-node source merge in well under a second', () => {
    const { baseline } = largeSources(1400)
    const a = baseline.replace('"label": "service 400"', '"label": "service 400 (a)"')
    const b = baseline.replace('"label": "service 500"', '"label": "service 500 (b)"')
    const c0 = process.cpuUsage()
    const m = mergeSources({ base: baseline, ours: a, theirs: b })
    const c = process.cpuUsage(c0)
    expect(m.conflicts).toEqual([])
    expect(m.text).toContain('service 400 (a)')
    expect(m.text).toContain('service 500 (b)')
    expect((c.user + c.system) / 1000).toBeLessThan(1000)
  })
})

/**
 * What each side did, checked on the merged model itself (not on how a diff happens to describe it):
 * every node, zone and frame field and every position a side changed has that side's value; the merged
 * connectors are the base's, minus what either side removed, plus what either added (compared without ids,
 * which id-less connectors don't have and pins only write down). Returns the mismatches.
 */
function keepsBoth(base, a, b, merged) {
  const bad = []
  const byId = (v, coll) => new Map((v[coll] ?? []).map((o) => [o.id, o]))
  for (const coll of ['nodes', 'zones', 'frames']) {
    const B = byId(base, coll), M = byId(merged, coll)
    for (const side of [a, b]) {
      const S = byId(side, coll)
      for (const [id, o] of S) {
        const was = B.get(id)
        for (const k of new Set([...Object.keys(o), ...Object.keys(was ?? {})])) {
          if (k === 'contains') {
            // membership is merged member by member: what this side added is in, what it removed is out
            const before = new Set(was?.contains ?? []), now = new Set(o.contains ?? []), got = new Set(M.get(id)?.contains ?? [])
            for (const x of now) if (!before.has(x) && !got.has(x)) bad.push(`${coll} ${id} lost member ${x}`)
            for (const x of before) if (!now.has(x) && got.has(x)) bad.push(`${coll} ${id} kept removed member ${x}`)
            continue
          }
          if (canon(o[k]) !== canon(was?.[k]) && canon(M.get(id)?.[k]) !== canon(o[k])) bad.push(`${coll} ${id}.${k}`)
        }
      }
      for (const id of B.keys()) if (!S.has(id) && M.has(id)) bad.push(`${coll} ${id} removed by one side`)
    }
  }
  for (const side of [a, b]) {
    for (const [id, p] of Object.entries(side.positions ?? {})) if (canon(p) !== canon(base.positions?.[id]) && merged.nodes?.some((n) => n.id === id) && canon(merged.positions?.[id]) !== canon(p)) bad.push(`position ${id}`)
  }
  const sig = (e) => {
    const o = { ...e }
    delete o.id
    return canon(o)
  }
  const bag = (v) => {
    const m = new Map()
    for (const e of v.edges ?? []) m.set(sig(e), (m.get(sig(e)) ?? 0) + 1)
    return m
  }
  const B = bag(base), A = bag(a), C = bag(b), M = bag(merged)
  const expected = new Map(B)
  for (const k of new Set([...B.keys(), ...A.keys(), ...C.keys()])) {
    const base0 = B.get(k) ?? 0
    const removed = Math.max(base0 - (A.get(k) ?? 0), base0 - (C.get(k) ?? 0), 0)
    const added = Math.max((A.get(k) ?? 0) - base0, 0) + Math.max((C.get(k) ?? 0) - base0, 0)
    const n = base0 - removed + added
    if (n) expected.set(k, n)
    else expected.delete(k)
  }
  for (const k of new Set([...expected.keys(), ...M.keys()])) if ((expected.get(k) ?? 0) !== (M.get(k) ?? 0)) bad.push(`connector ${k}: expected ${expected.get(k) ?? 0}, merged ${M.get(k) ?? 0}`)
  return bad
}


describe('resolving a card by hand', () => {
  it('a field written by hand is what the merge says, and it compiles', () => {
    const a = BASE.replace('"label": "API gateway"', '"label": "Gateway A"')
    const b = BASE.replace('"label": "API gateway"', '"label": "Gateway B"')
    const m = mergeSources({ base: BASE, ours: a, theirs: b })
    expect(m.conflicts.map((c) => [c.kind, c.field, c.ours, c.theirs])).toEqual([['field', 'label', 'Gateway A', 'Gateway B']])
    const r = resolveSources({ base: BASE, ours: a, theirs: b }, m, { [m.conflicts[0].id]: { edit: 'Gateway (A + B)' } })
    expect(r.valid).toBe(true)
    expect(value(r.text).nodes.find((n) => n.id === 'gw').label).toBe('Gateway (A + B)')
    expect(r.text).toContain('"label": "Gateway (A + B)"')
  })
})
