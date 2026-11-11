// Routing off the main thread: the worker's job loop (supersede, generations), the editor's adoption of
// worker results (exactly the routes a synchronous router computes), and no leaked workers.

import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { createRouter, routingObstacles } from './edges.js'
import { routeJob } from './routeJob.js'
import { createRouteClient, liveRouteWorkers, routeAsync, slimDoc } from './routeClient.js'
import { createEditor } from '../editor/editor.js'
import { denseRandom, measure, tiledReferences } from './fixtures/boards.js'

const obstaclesOf = (doc) => routingObstacles(Object.values(doc).filter((e) => e.type === 'node'))
const sorted = (m) => JSON.stringify([...m].sort(([a], [b]) => (a < b ? -1 : 1)))
const until = async (fn, ms = 20000) => {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** A worker double: the real job loop in this process, messages delivered asynchronously like a Worker's. */
function fakeWorker() {
  const w = { terminated: false, onmessage: null, posted: 0 }
  const job = routeJob(createRouter(), routingObstacles, (msg) => setTimeout(() => !w.terminated && w.onmessage?.({ data: msg }), 0), { slice: 4 })
  w.postMessage = (msg) => {
    w.posted++
    setTimeout(() => !w.terminated && job.submit(structuredClone(msg)), 0)
  }
  w.terminate = () => { w.terminated = true }
  w.job = job
  return w
}

describe('routing worker', { timeout: 30000 }, () => {
  it('answers with exactly the routes a synchronous router computes, for the requested edges', async () => {
    const doc = slimDoc(tiledReferences(300))
    const posted = []
    const job = routeJob(createRouter(), routingObstacles, (m) => posted.push(m))
    const ids = Object.values(doc).filter((e) => e.type === 'edge').map((e) => e.id)
    job.submit({ gen: 7, doc, ids })
    await until(() => posted.length === 1)
    expect(posted[0].gen).toBe(7)
    const exact = createRouter()(doc, obstaclesOf(doc))
    expect(new Map(posted[0].entries.map(([id, e]) => [id, e.pts])).size).toBe(exact.size)
    for (const [id, e] of posted[0].entries) expect(e.pts).toEqual(exact.get(id))
  })

  it('a newer document supersedes the one in progress: only the newest generation is answered', async () => {
    let doc = slimDoc(denseRandom(600))
    const posted = []
    const job = routeJob(createRouter(), routingObstacles, (m) => posted.push(m), { slice: 8 })
    const ids = Object.values(doc).filter((e) => e.type === 'edge').map((e) => e.id)
    job.submit({ gen: 1, doc, ids })
    await new Promise((r) => setTimeout(r, 1)) // let it start slicing
    const id = Object.keys(doc).find((k) => doc[k].type === 'node')
    doc = { ...doc, [id]: { ...doc[id], x: doc[id].x + 40 } }
    job.submit({ gen: 2, doc, ids })
    await until(() => posted.length > 0 && !job.stats.running)
    await new Promise((r) => setTimeout(r, 20))
    expect(posted.map((m) => m.gen)).toEqual([2])
    expect(job.stats.superseded).toBeGreaterThanOrEqual(1)
  })

  it("the editor shows provisional routes within its frame budget, then adopts the worker's, which equal a synchronous router's", async () => {
    const doc0 = denseRandom(1000)
    const workers = []
    const routing = createRouteClient({ spawn: () => (workers.push(fakeWorker()), workers.at(-1)) })
    const r = createDocStore0(doc0)
    const ed = createEditor(r, { routing })
    let scene = ed.scene()
    // first full route: far more than the frame budget, so most connectors start provisional
    expect(scene.routes.pending.size).toBeGreaterThan(0)
    await until(() => !ed.routesPending)
    expect(sorted(ed.scene().routes)).toBe(sorted(createRouter()(ed.store.doc, obstaclesOf(ed.store.doc))))
    // drag one node over three frames: each scene stays within budget; the settled result is exact
    const id = Object.values(ed.store.doc).find((e) => e.type === 'node').id
    for (let f = 0; f < 3; f++) {
      const n = ed.store.doc[id]
      ed.store.set(id, { ...n, x: n.x + 15 }, 'move')
      const c0 = process.cpuUsage()
      scene = ed.scene()
      const c = process.cpuUsage(c0)
      expect((c.user + c.system) / 1000).toBeLessThan(60)
    }
    await until(() => !ed.routesPending)
    expect(sorted(ed.scene().routes)).toBe(sorted(createRouter()(ed.store.doc, obstaclesOf(ed.store.doc))))
    expect(workers.length).toBe(1)
    ed.dispose()
    expect(workers[0].terminated).toBe(true)
  })

  it('routeAsync (the change review preview and bundle views) gives exactly the synchronous routes and ends its worker', async () => {
    const doc = tiledReferences(500)
    const made = []
    const routes = await routeAsync(doc, { spawn: () => (made.push(fakeWorker()), made.at(-1)) })
    expect(sorted(routes)).toBe(sorted(createRouter()(doc, obstaclesOf(doc))))
    expect(made.length).toBe(1)
    expect(made[0].terminated).toBe(true)
  })

  it('leaves no live workers: dispose terminates, a later request starts exactly one more', () => {
    const before = liveRouteWorkers()
    const made = []
    const c = createRouteClient({ spawn: () => { const w = { postMessage() {}, terminate() { w.dead = true } }; made.push(w); return w } })
    c.request({}, [])
    c.request({}, [])
    expect(liveRouteWorkers()).toBe(before + 1)
    c.dispose()
    expect(liveRouteWorkers()).toBe(before)
    expect(made.map((w) => !!w.dead)).toEqual([true])
    c.request({}, []) // React's development remount reuses the editor
    expect(liveRouteWorkers()).toBe(before + 1)
    c.dispose()
    c.dispose()
    expect(liveRouteWorkers()).toBe(before)
  })
})

/** A board whose committed document is `doc` (one transaction adding everything). */
function createDocStore0(doc) {
  return { base: {}, done: [{ label: 'load', merge: null, t: 1, changes: Object.values(doc).map((el) => [el.id, null, el]) }], undone: [] }
}
void measure

describe('routing worker failures always settle (reviewer P2)', { timeout: 30000 }, () => {
  const doc = tiledReferences(300)
  const exact = () => createRouter()(doc, obstaclesOf(doc))
  /** A worker double that misbehaves: `mode` is 'error', 'messageerror', 'silent' or 'throw' (spawn fails). */
  const bad = (mode, made) => () => {
    if (mode === 'throw') throw new Error('blocked by CSP')
    const w = { terminated: false, onmessage: null, onerror: null, onmessageerror: null }
    w.postMessage = () => {
      if (mode === 'error') setTimeout(() => w.onerror?.({ message: 'boom', preventDefault() {} }), 1)
      if (mode === 'messageerror') setTimeout(() => w.onmessageerror?.({}), 1)
    }
    w.terminate = () => { w.terminated = true }
    made.push(w)
    return w
  }

  for (const [mode, why] of [['error', /failed \(boom\)/], ['messageerror', /could not be read/], ['silent', /did not answer/], ['throw', /could not start|no routing worker/]]) {
    it(`routeAsync settles with a bounded fallback when the worker ${mode === 'silent' ? 'never answers' : mode === 'throw' ? 'cannot start' : `sends ${mode}`}, and leaves no worker`, async () => {
      const made = [], before = liveRouteWorkers()
      const routes = await routeAsync(doc, { spawn: bad(mode, made), timeout: 50 })
      expect(routes.fallback.reason).toMatch(why)
      expect(routes.size).toBe(exact().size) // every connector has a path (exact, or a plain elbow past the budget)
      for (const [id, pts] of exact()) if (!routes.pending.has(id)) expect(routes.get(id)).toEqual(pts)
      expect(made.every((w) => w.terminated)).toBe(true)
      expect(liveRouteWorkers()).toBe(before)
    })
  }

  it('routeAsync settles when cancelled, before or during', async () => {
    const made = [], before = liveRouteWorkers()
    const pre = new AbortController()
    pre.abort()
    expect((await routeAsync(doc, { spawn: bad('silent', made), signal: pre.signal })).fallback.reason).toBe('cancelled')
    const mid = new AbortController()
    const p = routeAsync(doc, { spawn: bad('silent', made), signal: mid.signal })
    mid.abort()
    expect((await p).fallback.reason).toBe('cancelled')
    expect(made.every((w) => w.terminated)).toBe(true)
    expect(liveRouteWorkers()).toBe(before)
  })

  it('an editor whose worker fails finishes its routes on the main thread, in slices, exactly', async () => {
    const made = [], before = liveRouteWorkers()
    const routing = createRouteClient({ spawn: bad('error', made) })
    const ed = createEditor(createDocStore0(denseRandom(600)), { routing })
    expect(ed.scene().routes.pending.size).toBeGreaterThan(0)
    await until(() => !ed.routesPending)
    expect(sorted(ed.scene().routes)).toBe(sorted(createRouter()(ed.store.doc, obstaclesOf(ed.store.doc))))
    // a second failure marks the client broken: later scenes route on the main thread without asking
    const n = ed.store.doc[Object.keys(ed.store.doc).find((k) => ed.store.doc[k].type === 'node')]
    ed.store.set(n.id, { ...n, x: n.x + 30 }, 'move')
    ed.scene()
    await until(() => !ed.routesPending)
    expect(routing.broken).toBe(true)
    expect(made.length).toBe(2)
    expect(made.every((w) => w.terminated)).toBe(true)
    expect(liveRouteWorkers()).toBe(before)
    ed.dispose()
  })
})
