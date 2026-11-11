import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compileDiagram } from './compile.js'
import { checkPatch, docHash, planPatch } from './patch.js'
import { createDocStore, fold } from '../core/history.js'
import { lint } from '../review/lint.js'
import { buildCritique } from '../export/critique.js'
import { problemById } from '../problems/index.js'

const measure = (s, font) => s.length * Number(/(\d+)px/.exec(font)[1]) * 0.55
const place = () => ({ x: 0, y: 0 })

function board() {
  const r = compileDiagram({
    format: 'boxwire-diagram', version: 1,
    nodes: [{ id: 'c', kind: 'web-client', capacity: { writeQps: 10, readQps: 100 } }, { id: 'api', kind: 'service', capacity: { replicas: 1 } }, { id: 'r', kind: 'cache' }],
    edges: [{ id: 'e1', from: 'c', to: 'api' }, { id: 'e2', from: 'api', to: 'r' }],
  }, { measure })
  return r
}

const patchFor = (baseline, ops) => ({ format: 'boxwire-patch', version: 1, baseline, ops })

describe('agent patches', () => {
  it('refuses a stale baseline and an unsupported version, with paths', async () => {
    const { doc } = board()
    const h = await docHash(doc)
    expect(checkPatch(patchFor('0'.repeat(64), [{ op: 'remove', id: 'r' }]), doc, h).errors[0]).toMatchObject({ path: 'baseline' })
    expect(checkPatch({ ...patchFor(h, [{ op: 'remove', id: 'r' }]), version: 2 }, doc, h).errors[0]).toMatchObject({ path: 'version' })
  })

  it('rejects every invalid operation and applies none of them', async () => {
    const { doc } = board()
    const h = await docHash(doc)
    const { errors, ops } = checkPatch(patchFor(h, [
      { op: 'add-node', id: 'api', kind: 'service' },
      { op: 'add-node', id: 'db', kind: 'postgres' },
      { op: 'connect', from: 'c', to: 'ghost' },
      { op: 'set-capacity', id: 'api', capacity: { replicas: 0.5, speed: 3 } },
      { op: 'launch' },
    ]), doc, h)
    expect(ops).toEqual([])
    expect(errors.map((e) => e.path)).toEqual(['ops[0].id', 'ops[1].kind', 'ops[2].to', 'ops[3].capacity.speed', 'ops[3].capacity', 'ops[4].op'])
  })

  it('board → critique → patch → board: one undoable step that fixes the findings it targets', async () => {
    const { doc, board: b } = board()
    const store = createDocStore({ base: b.base, done: b.done })
    const before = lint(store.doc)
    expect(before.results.find((r) => r.id === 'write-without-durable-store:c+r').status).toBe('violation')

    const bundle = await buildCritique({ name: 'T', doc: store.doc, history: store.history, problem: problemById('url-shortener'), now: 0 })
    expect(bundle.format).toBe('boxwire-critique')
    expect(bundle.graph.nodes.map((n) => n.id)).toEqual(['api', 'c', 'r'])
    expect(JSON.stringify(bundle).length).toBeLessThan(64 * 1024)

    const patch = patchFor(bundle.baseline, [
      { op: 'add-node', id: 'db', kind: 'sql-database', label: 'Orders DB', capacity: { replicas: 2 }, near: 'api' },
      { op: 'connect', from: 'api', to: 'db' },
      { op: 'set-capacity', id: 'api', capacity: { replicas: 3 } },
      { op: 'set-capacity', id: 'r', capacity: { ttlSec: 60 } },
    ])
    const { errors, ops } = checkPatch(patch, store.doc, await docHash(store.doc))
    expect(errors).toEqual([])
    const plan = planPatch(store.doc, ops, { measure, place })
    expect(plan.problem).toBeNull()
    expect(plan.summary).toEqual(['Add sql-database “Orders DB”', 'Connect “Service” → “Orders DB”', 'Declare on “Service”: replicas = 3', 'Declare on “Redis cache”: ttlSec = 60'])

    const steps = store.history.done.length
    store.apply(plan.entries, 'apply agent patch')
    expect(store.history.done.length).toBe(steps + 1)
    expect(fold(store.history.base, store.history.done)).toEqual(store.doc) // the replay invariant holds
    const after = lint(store.doc)
    expect(after.violations.map((r) => r.id)).toEqual([])
    store.undo()
    expect(store.doc).toEqual(doc)
  })

  it('removing a node removes its connectors in the same step', async () => {
    const { doc } = board()
    const h = await docHash(doc)
    const { ops } = checkPatch(patchFor(h, [{ op: 'remove', id: 'api' }]), doc, h)
    const plan = planPatch(doc, ops, { measure, place })
    expect(plan.entries.map(([id, el]) => [id, el])).toEqual([['api', null], ['e1', null], ['e2', null]])
  })

  it('hashes documents canonically: key order does not matter', async () => {
    const { doc } = board()
    const shuffled = Object.fromEntries(Object.entries(doc).reverse().map(([k, v]) => [k, Object.fromEntries(Object.entries(v).reverse())]))
    expect(await docHash(shuffled)).toBe(await docHash(doc))
  })

  it('the critique bundle for a reference solution stays small', async () => {
    const json = JSON.parse(fs.readFileSync(new URL('../problems/solutions/notifications.boxwire-diagram.json', import.meta.url), 'utf8'))
    const r = compileDiagram(json, { measure })
    const bundle = await buildCritique({ name: 'N', doc: r.doc, history: r.board, problem: problemById('notifications'), now: 0 })
    expect(bundle.review.results.every((x) => x.status === 'pass')).toBe(true)
    expect(JSON.stringify(bundle).length).toBeLessThan(64 * 1024)
  })

  it('audit #6: operations are checked against the state as it will be when they run', async () => {
    const { doc } = board()
    const h = await docHash(doc)
    const after = checkPatch(patchFor(h, [{ op: 'remove', id: 'api' }, { op: 'set-capacity', id: 'api', capacity: { replicas: 2 } }]), doc, h)
    expect(after.ops).toEqual([])
    expect(after.errors).toEqual([{ path: 'ops[1].id', message: 'refers to unknown node "api" (an earlier operation removed it).' }])
    // the node's connectors go with it
    const edge = checkPatch(patchFor(h, [{ op: 'remove', id: 'api' }, { op: 'set-label', id: 'e1', label: 'x' }]), doc, h)
    expect(edge.errors[0].path).toBe('ops[1].id')
    expect(checkPatch(patchFor(h, [{ op: 'remove', id: 'r' }, { op: 'remove', id: 'r' }]), doc, h).errors[0].path).toBe('ops[1].id')
  })

  it('audit #6: planning never throws; a failure is a diagnostic and changes nothing', () => {
    const { doc } = board()
    const plan = planPatch(doc, [{ op: 'set-capacity', id: 'ghost', capacity: { replicas: 2 } }], { measure, place })
    expect(plan.entries).toEqual([])
    expect(plan.problem).toMatch(/could not be planned/)
    expect(plan.doc).toBe(doc)
  })
})
