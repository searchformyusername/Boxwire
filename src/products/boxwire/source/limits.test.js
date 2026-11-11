// The source layer's former limits, each measured: reconnecting or re-kinding an id-less edge, comments
// inside a `contains` array, and auto layout moving nodes nobody touched after a structural canvas edit.

import { describe, expect, it } from 'vitest'
import { compileDiagram } from '../author/compile.js'
import { createDocStore, fold } from '../core/history.js'
import { validateBoard } from '../core/validate.js'
import { makeNode } from '../core/elements.js'
import { allChanges, diffModels, isPin, summarise } from '../change/diff.js'
import { parseSource } from './cst.js'
import { sourceForChanges } from './accept.js'
import { applySourceOps } from './edit.js'
import { createSourceSession } from './session.js'
import { reflowPins } from './sync.js'
import { churn, lineDiff } from './linediff.js'

const measure = (s, font) => s.length * Number(/(\d+)px/.exec(font)[1]) * 0.55
const value = (t) => parseSource(t).value

const EDGES = `{
  "format": "boxwire-diagram",
  "version": 1,
  "nodes": [
    { "id": "a", "kind": "service", "label": "A" },
    { "id": "b", "kind": "service", "label": "B" },
    { "id": "c", "kind": "sql-database", "label": "C" },
    { "id": "d", "kind": "cache", "label": "D" }
  ],
  "edges": [
    // the read path
    { "from": "a", "to": "b" },
    { "from": "b", "to": "c", "label": "query" },
    { "from": "a", "to": "d" }
  ]
}
`

describe('reconnecting or re-kinding an id-less edge is one field change', () => {
  it('moving one end', () => {
    const next = EDGES.replace('{ "from": "b", "to": "c", "label": "query" }', '{ "from": "b", "to": "d", "label": "query" }')
    const d = diffModels(value(EDGES), value(next))
    expect(allChanges(d).map((c) => c.id)).toEqual(['edge:b->c:flow:to'])
    expect(summarise(d.semantic)).toEqual(['Reconnected B → C as B → D'])
  })

  it('changing the kind', () => {
    const next = EDGES.replace('{ "from": "a", "to": "b" }', '{ "from": "a", "to": "b", "kind": "async" }')
    const d = diffModels(value(EDGES), value(next))
    expect(allChanges(d).map((c) => c.id)).toEqual(['edge:a->b:flow:kind'])
  })

  it('moving one end and relabelling it, accepted as minimal edits that keep the comment', () => {
    const next = EDGES.replace('{ "from": "b", "to": "c", "label": "query" }', '{ "from": "b", "to": "d", "label": "lookup" }')
    const d = diffModels(value(EDGES), value(next))
    expect(allChanges(d).map((c) => c.id)).toEqual(['edge:b->c:flow:label', 'edge:b->c:flow:to'])
    const w = sourceForChanges(EDGES, allChanges(d), value(next))
    expect(w.unsupported).toEqual([])
    expect(w.applied).toHaveLength(2)
    expect(w.text).toBe(next)
    expect(churn(lineDiff(EDGES, w.text))).toEqual({ removed: 1, added: 1 })
  })

  it('an edge whose two ends both changed has nothing left to identify it, so it stays a remove plus an add', () => {
    const next = EDGES.replace('{ "from": "a", "to": "b" }', '{ "from": "c", "to": "d" }')
    const types = allChanges(diffModels(value(EDGES), value(next))).map((c) => c.type).sort()
    expect(types).toEqual(['add', 'remove'])
  })

  it('a new edge that merely lands on a removed edge\'s generated id, with different ends, is not mistaken for it', () => {
    const next = EDGES.replace('{ "from": "a", "to": "b" },', '{ "from": "c", "to": "d" },')
    const d = allChanges(diffModels(value(EDGES), value(next)))
    expect(d.map((c) => c.type).sort()).toEqual(['add', 'remove'])
  })
})

const ZONES = `{
  "format": "boxwire-diagram",
  "version": 1,
  "nodes": [
    { "id": "a", "kind": "service" },
    { "id": "b", "kind": "service" },
    { "id": "c", "kind": "sql-database" },
    { "id": "d", "kind": "cache" }
  ],
  "edges": [{ "from": "a", "to": "b" }, { "from": "b", "to": "c" }, { "from": "a", "to": "d" }],
  "zones": [
    {
      "id": "core",
      "label": "Core",
      "contains": [
        // the services
        "a",
        "b", // the second one
        /* storage */ "c"
      ]
    }
  ]
}
`
const comments = (t) => t.split('\n').map((l) => /\/\/.*|\/\*.*\*\//.exec(l)?.[0]).filter(Boolean)

describe('comments inside a contains array survive membership changes', () => {
  it('accepting an added and a removed member edits one entry each', () => {
    const next = ZONES.replace('"b", // the second one', '"b", // the second one\n        "d",').replace('        /* storage */ "c"\n', '').replace('"d",\n      ]', '"d"\n      ]')
    const d = allChanges(diffModels(value(ZONES), value(next)))
    expect(d.map((c) => c.id)).toEqual(['zone:core:contains.c', 'zone:core:contains.d'])
    const w = sourceForChanges(ZONES, d, value(next))
    expect(w.unsupported).toEqual([])
    expect(value(w.text).zones[0].contains).toEqual(['a', 'b', 'd'])
    // the removed member takes its own comment; the others stay byte for byte
    expect(comments(w.text)).toEqual(['// the services', '// the second one'])
  })

  it('member ops keep every other comment, add after a named member, and refuse to empty a zone', () => {
    const r = applySourceOps(ZONES, [{ op: 'addMember', entity: 'zone', id: 'core', member: 'd', after: 'a' }])
    expect(value(r.text).zones[0].contains).toEqual(['a', 'd', 'b', 'c'])
    expect(comments(r.text)).toEqual(comments(ZONES))
    const one = applySourceOps(ZONES, [{ op: 'removeMember', entity: 'zone', id: 'core', member: 'a' }, { op: 'removeMember', entity: 'zone', id: 'core', member: 'b' }])
    expect(applySourceOps(one.text, [{ op: 'removeMember', entity: 'zone', id: 'core', member: 'c' }]).error).toMatch(/at least one member/)
  })

  it('a canvas membership edit writes one entry, not the whole array', () => {
    const r = compileDiagram(value(ZONES), { measure })
    const store = createDocStore({ base: r.board.base, done: r.board.done })
    const session = createSourceSession({ store, text: ZONES, measure })
    store.set('core', { ...store.doc.core, members: ['a', 'b', 'c', 'd'] }, 'group')
    expect(value(session.text).zones[0].contains).toEqual(['a', 'b', 'c', 'd'])
    expect(comments(session.text)).toEqual(comments(ZONES))
    store.undo()
    expect(session.text).toBe(ZONES)
  })
})

const AUTO = `{
  "format": "boxwire-diagram",
  "version": 1,
  // auto layout
  "nodes": [
    { "id": "client", "kind": "web-client" },
    { "id": "api", "kind": "service" },
    { "id": "db", "kind": "sql-database" },
    { "id": "cache", "kind": "cache" }
  ],
  "edges": [{ "from": "client", "to": "api" }, { "from": "api", "to": "db" }, { "from": "api", "to": "cache" }]
}
`

function openAuto() {
  const r = compileDiagram(value(AUTO), { measure })
  const store = createDocStore({ base: r.board.base, done: r.board.done })
  const session = createSourceSession({ store, text: AUTO, measure })
  return { store, session }
}
/** Where each node of the board is, and where the session's source puts it. */
function drift(store, session) {
  const doc = compileDiagram(value(session.text), { measure }).doc
  return Object.values(store.doc).filter((el) => el.type === 'node' && el.shape !== 'zone' && el.shape !== 'frame').filter((el) => doc[el.id]?.x !== el.x || doc[el.id]?.y !== el.y).map((el) => el.id)
}

describe('auto layout: a structural canvas edit never moves the nodes nobody touched', () => {
  it('connecting two nodes would re-rank one; it is pinned where the board has it, and the source compiles to the board', () => {
    const { store, session } = openAuto()
    // an edge cache → db pushes db a rank further right under auto layout
    const naive = compileDiagram({ ...value(AUTO), edges: [...value(AUTO).edges, { from: 'cache', to: 'db' }] }, { measure }).doc
    expect(naive.db.x).not.toBe(store.doc.db.x)
    store.set('e-new', { id: 'e-new', type: 'edge', from: { id: 'cache' }, to: { id: 'db' }, head: 'arrow', tail: 'none', dash: 'solid', route: 'ortho', color: 'ink', stroke: 2, size: 14, font: 'sans', text: '', z: 50 }, 'connect')
    expect(session.unsupported).toEqual([])
    expect(session.reflowed).toContain('db')
    expect(drift(store, session)).toEqual([])
    store.undo()
    expect(session.text).toBe(AUTO)
  })

  it('adding and removing a node keep the board and the source in step', () => {
    const { store, session } = openAuto()
    store.set('worker', { ...makeNode('rect', 600, 400, { kind: 'worker', text: 'Worker' }), id: 'worker', z: 60 }, 'add')
    expect(drift(store, session)).toEqual([])
    store.apply([['cache', null], ...Object.values(store.doc).filter((e) => e.type === 'edge' && (e.from.id === 'cache' || e.to.id === 'cache')).map((e) => [e.id, null])], 'delete')
    expect(session.unsupported).toEqual([])
    expect(drift(store, session)).toEqual([])
  })

  // reviewer P2: every structural edit type, then "reopen" (compile the saved source) and compare positions
  const EDITS = {
    'insert an edge': (st) => st.set('e-new', { ...st.doc.e2, id: 'e-new', from: { id: 'cache' }, to: { id: 'db' } }, 'connect'),
    'remove an edge': (st) => st.set('e2', null, 'remove'),
    'reconnect the from end': (st) => st.set('e2', { ...st.doc.e2, from: { ...st.doc.e2.from, id: 'cache' } }, 'reconnect'),
    'reconnect the to end': (st) => st.set('e3', { ...st.doc.e3, to: { ...st.doc.e3.to, id: 'client' } }, 'reconnect'),
    'retarget both ends': (st) => st.set('e1', { ...st.doc.e1, from: { id: 'cache' }, to: { id: 'db' } }, 'retarget'),
    'change the relation (arrowheads)': (st) => st.set('e2', { ...st.doc.e2, head: 'triangle' }, 'relation'),
    'reverse an edge': (st) => st.set('e1', { ...st.doc.e1, from: { id: 'api' }, to: { id: 'client' } }, 'reverse'),
    'add a node': (st) => st.set('worker', { ...makeNode('rect', 900, 300, { kind: 'worker', text: 'Worker' }), id: 'worker', z: 60 }, 'add'),
    'remove a node and its edges': (st) => st.apply([['db', null], ['e2', null]], 'delete'),
    'relabel (no layout change)': (st) => st.set('api', { ...st.doc.api, text: 'Orders API' }, 'text'),
  }
  for (const [name, edit] of Object.entries(EDITS)) {
    it(`reopening after "${name}" puts every node exactly where the board has it; undo and redo are exact`, () => {
      const { store, session } = openAuto()
      edit(store)
      expect(session.unsupported).toEqual([])
      expect(drift(store, session)).toEqual([])
      if (name.startsWith('relabel')) expect(session.reflowed).toEqual([])
      const after = session.text
      store.undo()
      expect(session.text).toBe(AUTO)
      store.redo()
      expect(session.text).toBe(after)
      expect(drift(store, session)).toEqual([])
    })
  }

  it('the reviewer\'s reconnect writes back as one edge reconnected and relabelled, not a remove and an add', () => {
    const v = { format: 'boxwire-diagram', version: 1, nodes: [{ id: 'client', kind: 'web-client' }, { id: 'api', kind: 'service' }, { id: 'db', kind: 'sql-database' }, { id: 'cache', kind: 'cache' }], edges: [{ from: 'client', to: 'api' }, { from: 'api', to: 'db', label: 'query' }, { from: 'api', to: 'cache' }] }
    const next = structuredClone(v)
    next.edges[1] = { from: 'api', to: 'cache', label: 'cache lookup' }
    expect(allChanges(diffModels(v, next)).map((c) => c.id)).toEqual(['edge:api->db:flow:label', 'edge:api->db:flow:to'])
  })

  it('reflowPins is empty in manual layout and when nothing would move', () => {
    expect(reflowPins({ ...value(AUTO), layout: 'manual' }, {})).toEqual([])
    const doc = compileDiagram(value(AUTO), { measure }).doc
    expect(reflowPins(value(AUTO), doc, { measure })).toEqual([])
  })
})

describe('accepting several additions', () => {
  it('writes them in the proposal\'s order, anchors first, without pinning any generated id (regression)', () => {
    const base = '{\n  "format": "boxwire-diagram",\n  "version": 1,\n  "nodes": [{ "id": "a", "kind": "service" }]\n}\n'
    const next = { format: 'boxwire-diagram', version: 1, nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id, kind: 'service' })), edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'd' }] }
    const d = allChanges(diffModels(value(base), next))
    const w = sourceForChanges(base, d, next)
    expect(w.unsupported).toEqual([])
    expect(w.applied).toHaveLength(d.length)
    expect(value(w.text)).toEqual(next)
    expect(w.text).not.toContain('"id": "e')
  })

  it('a failed addition is reported, never counted as skipped', () => {
    const base = '{\n  "format": "boxwire-diagram",\n  "version": 1,\n  "nodes": [{ "id": "a", "kind": "service" }]\n}\n'
    const add = { id: 'node:a', type: 'add', entity: 'node', key: 'a', after: { id: 'a', kind: 'service' }, anchor: null, index: 1 }
    const w = sourceForChanges(base, [add], { nodes: [{ id: 'a', kind: 'service' }, { id: 'a', kind: 'service' }] })
    expect(w.skipped).toEqual([])
    expect(w.unsupported.map((u) => u.id)).toEqual(['node:a'])
  })
})

describe('id-less connector identity, closed further', () => {
  const base = {
    format: 'boxwire-diagram', version: 1,
    nodes: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, kind: 'service' })),
    edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: 'orders' }, { from: 'c', to: 'd' }],
  }
  const ids = (d) => allChanges(d).map((c) => c.id)

  it('a reconnect in an array that was also reordered (so the generated id moved) is still one change', () => {
    const next = { ...base, edges: [{ from: 'c', to: 'd' }, { from: 'a', to: 'b' }, { from: 'b', to: 'e', label: 'orders' }] }
    const d = diffModels(base, next)
    expect(ids(d)).toEqual(['edge:b->c:flow:to'])
    expect(d.semantic[0].inferred).toBe(true)
    expect(summarise(d.semantic)[0]).toMatch(/matched by what it still shares/)
  })

  it('both ends changed: matched only by the same kind and non-empty label, and only when unique', () => {
    const next = { ...base, edges: [{ from: 'a', to: 'b' }, { from: 'd', to: 'e', label: 'orders' }, { from: 'c', to: 'd' }] }
    expect(ids(diffModels(base, next))).toEqual(['edge:b->c:flow:from', 'edge:b->c:flow:to'])
    // two candidates with the same label: ambiguous, so a remove plus two adds
    const two = { ...base, edges: [{ from: 'a', to: 'b' }, { from: 'd', to: 'e', label: 'orders' }, { from: 'e', to: 'a', label: 'orders' }, { from: 'c', to: 'd' }] }
    expect(allChanges(diffModels(base, two)).map((c) => c.type).sort()).toEqual(['add', 'add', 'remove'])
    // unlabelled, nothing in common: remove plus add
    const plain = { ...base, edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: 'orders' }, { from: 'e', to: 'a' }] }
    expect(allChanges(diffModels(base, plain)).map((c) => c.type).sort()).toEqual(['add', 'remove'])
  })

  it('two reconnects that could pair either way: the generated ids decide when they line up, otherwise no guess', () => {
    const b2 = { ...base, edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }] }
    // in place: e1 stays e1 and e2 stays e2, each sharing its from end, so they read as two reconnects
    expect(ids(diffModels(b2, { ...base, edges: [{ from: 'a', to: 'd' }, { from: 'a', to: 'e' }] }))).toEqual(['edge:a->b:flow:to', 'edge:a->c:flow:to'])
    // reversed (each end now in the other role) behind a new edge: no end is shared in the same role, so nothing pairs them
    const moved = { ...base, edges: [{ id: 'x', from: 'd', to: 'e' }, { from: 'b', to: 'a' }, { from: 'c', to: 'a' }] }
    expect(allChanges(diffModels(b2, moved)).filter((c) => c.entity === 'edge').map((c) => c.type).sort()).toEqual(['add', 'add', 'add', 'remove', 'remove'])
  })

  it('"give every connector an id" writes the generated ids, after which identity is by id', () => {
    const { store, session } = openAuto()
    const before = session.text
    const r = session.pinAll()
    expect(r.pinned).toEqual(['e1', 'e2', 'e3'])
    expect(value(session.text).edges.map((e) => e.id)).toEqual(['e1', 'e2', 'e3'])
    expect(diffModels(value(before), value(session.text)).identity.every(isPin)).toBe(true)
    expect(Object.keys(store.doc).sort()).toEqual(Object.keys(compileDiagram(value(session.text), { measure }).doc).sort())
    expect(session.pinAll().pinned).toEqual([])
  })

  it('pinAll is a single undo step: undo restores the text exactly, redo writes the ids again, the board never changes', () => {
    const { store, session } = openAuto()
    const doc = store.doc, steps = store.history.done.length
    session.pinAll()
    const pinnedText = session.text
    expect(store.history.done.length).toBe(steps + 1)
    expect(store.history.done.at(-1)).toMatchObject({ label: 'write connector ids', changes: [] })
    expect(store.doc).toBe(doc)
    store.undo()
    expect(session.text).toBe(AUTO)
    expect(store.history.done.length).toBe(steps)
    store.redo()
    expect(session.text).toBe(pinnedText)
    // a later canvas edit undoes back to the pinned text, then to the original
    store.set('api', { ...store.doc.api, text: 'Orders API' }, 'text')
    store.undo()
    expect(session.text).toBe(pinnedText)
    store.undo()
    expect(session.text).toBe(AUTO)
    expect(fold(store.history.base, store.history.done)).toEqual(store.doc) // replay still equals the board
    // a saved board with that step reopens with its history intact
    store.redo()
    const { base, done, undone } = store.history
    expect(validateBoard({ base, done, undone, doc: store.doc }).warning).toBe(null)
  })
})
