// Connector routing gate, with assertions; exits non-zero on any failure.
//   mise exec node@22.23.2 -- node scripts/boxwire-route-gate.mjs [--out file.json] [--receipt full.json] [--quick]
// --receipt writes every changed connector's before/after path and measures, the git HEAD and the
// SHA-256 of the router sources measured, so the quality numbers can be re-derived.
// 1. Identity: on every reference design and published example, and after dragging each of their nodes,
//    the router's routes equal the frozen pre-optimisation router's (core/fixtures/router-v1) byte for byte.
// 2. Realistic scale: reference designs tiled to >= 2,330 connectors. Identical to router-v1 on every
//    connector; a full route under FULL_REAL_MS of CPU; a single-node drag frame under DRAG_MS median CPU;
//    incremental results equal a fresh router's.
// 3. Adversarial scale: 1,400 nodes in dense tiers, 2,330 long connectors. A full route under FULL_DENSE_MS of
//    CPU; against router-v1 (at 800 nodes, where it finishes in seconds) no connector is worse by the stated
//    metric (core/routeQuality.js: crossings, then clearance, then length + 28 px per bend; bends and length
//    are reported per verdict); incremental
//    results equal a fresh router's. The exact re-route cost of a drag frame is measured and reported; with
//    the routing worker attached, the editor's main-thread cost per drag frame must stay under DRAG_MS median
//    (the editor's 8 ms is a soft scheduling deadline between connectors, not a measured maximum).
// 4. Authored ports: with declared sides on a third of the connector ends, no route leaves or enters
//    through any other face.

import { writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { compileDiagram } from '../src/products/boxwire/author/compile.js'
import { createRouter, routingObstacles } from '../src/products/boxwire/core/edges.js'
import * as v1 from '../src/products/boxwire/core/fixtures/router-v1/edges.js'
import { pickSides } from '../src/products/boxwire/core/route.js'
import { compareQuality, routeQuality } from '../src/products/boxwire/core/routeQuality.js'
import { denseRandom, measure, referenceDocs, tiledReferences } from '../src/products/boxwire/core/fixtures/boards.js'
import { createEditor } from '../src/products/boxwire/editor/editor.js'

// FULL_DENSE_MS went to 2,000 in 9df3cc3 after face-pair competition (783a3fe) cost 1.26-1.55 s; cost-capped
// searches for the competing pairs brought five runs to 1,090-1,484 ms (median 1,430, load average 15-19),
// so it is back at 1,500, with a thin margin that DESIGN.md states.
const FULL_REAL_MS = 500, FULL_DENSE_MS = 1500, DRAG_MS = 50
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null }
const quick = process.argv.includes('--quick')
const failures = [], report = { node: process.version, budgets: { FULL_REAL_MS, FULL_DENSE_MS, DRAG_MS } }, receipt = {}
const check = (ok, msg) => { if (!ok) failures.push(msg) }
const cpu = (fn) => { const c0 = process.cpuUsage(); const out = fn(); const c = process.cpuUsage(c0); return [(c.user + c.system) / 1000, out] }
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const obstaclesOf = (doc) => routingObstacles(Object.values(doc).filter((e) => e.type === 'node'))
const same = (a, b) => JSON.stringify([...a].sort(([x], [y]) => (x < y ? -1 : 1))) === JSON.stringify([...b].sort(([x], [y]) => (x < y ? -1 : 1)))
const nodeIds = (doc) => Object.values(doc).filter((e) => e.type === 'node' && e.shape !== 'zone' && e.shape !== 'frame').map((e) => e.id)
const move = (doc, id, dx) => ({ ...doc, [id]: { ...doc[id], x: doc[id].x + dx } })

// 1. identity on references and examples, static and under drags
{
  const examples = readdirSync(new URL('../public/products/boxwire/examples/', import.meta.url)).map((f) => ({ name: f, doc: compileDiagram(JSON.parse(readFileSync(new URL(`../public/products/boxwire/examples/${f}`, import.meta.url), 'utf8')), { measure }).doc })).filter((x) => x.doc)
  let boards = 0, edges = 0, drags = 0
  for (const { name, doc: d0 } of [...referenceDocs(), ...examples]) {
    boards++
    const router = createRouter()
    let doc = d0
    const a = router(doc, obstaclesOf(doc)), b = v1.createRouter()(doc, obstaclesOf(doc))
    edges += a.size
    check(same(a, b), `identity: ${name} differs from router-v1`)
    for (const id of nodeIds(d0)) {
      doc = move(doc, id, 30)
      drags++
      check(same(router(doc, obstaclesOf(doc)), v1.createRouter()(doc, obstaclesOf(doc))), `identity: ${name} after dragging ${id} differs from router-v1`)
    }
  }
  report.identity = { boards, edges, drags }
}

// 2. realistic scale
{
  let doc = tiledReferences(2330)
  const edges = Object.values(doc).filter((e) => e.type === 'edge').length
  const router = createRouter()
  const [full, routes] = cpu(() => router(doc, obstaclesOf(doc)))
  check(full < FULL_REAL_MS, `realistic: full route ${full.toFixed(0)} ms CPU, budget ${FULL_REAL_MS}`)
  let v1ms = null
  if (!quick) {
    const [t, ref] = cpu(() => v1.createRouter()(doc, obstaclesOf(doc)))
    v1ms = t
    check(same(routes, ref), 'realistic: routes differ from router-v1')
  }
  const frames = []
  const ids = nodeIds(doc)
  for (let i = 0; i < 25; i++) {
    const id = ids[(i * 97) % ids.length]
    for (let f = 0; f < 3; f++) {
      doc = move(doc, id, 10)
      const [t, r] = cpu(() => router(doc, obstaclesOf(doc)))
      frames.push(t)
      if (f === 2 && i % 5 === 0) check(same(r, createRouter()(doc, obstaclesOf(doc))), `realistic: incremental routes differ from a fresh router after dragging ${id}`)
    }
  }
  check(median(frames) < DRAG_MS, `realistic: drag frame median ${median(frames).toFixed(1)} ms CPU, budget ${DRAG_MS}`)
  report.realistic = { nodes: ids.length, edges, fullMs: full, v1FullMs: v1ms, dragMedianMs: median(frames), dragP90Ms: [...frames].sort((a, b) => a - b)[Math.floor(frames.length * 0.9)] }
}

// 3. adversarial scale
{
  let doc = denseRandom(1400)
  const edges = Object.values(doc).filter((e) => e.type === 'edge').length
  const router = createRouter()
  const [full] = cpu(() => router(doc, obstaclesOf(doc)))
  check(edges >= 2330, `dense: only ${edges} connectors`)
  check(full < FULL_DENSE_MS, `dense: full route ${full.toFixed(0)} ms CPU, budget ${FULL_DENSE_MS}`)
  const frames = []
  const ids = nodeIds(doc)
  for (let i = 0; i < (quick ? 4 : 12); i++) {
    const id = ids[(i * 97) % ids.length]
    for (let f = 0; f < 3; f++) {
      doc = move(doc, id, 10)
      const [t, r] = cpu(() => router(doc, obstaclesOf(doc)))
      frames.push(t)
      if (f === 2 && i % 4 === 0) check(same(r, createRouter()(doc, obstaclesOf(doc))), `dense: incremental routes differ from a fresh router after dragging ${id}`)
    }
  }
  // the editor's main thread with a routing worker attached (requests recorded, answered off-thread in the app)
  const requests = []
  const ed = createEditor({ base: {}, done: [{ label: 'load', merge: null, t: 1, changes: Object.values(denseRandom(1400)).map((el) => [el.id, null, el]) }], undone: [] }, { routing: { request: (d, pending) => requests.push(pending.length), onResult() {}, dispose() {} } })
  ed.scene()
  const main = []
  for (let i = 0; i < 25; i++) {
    const id = ids[(i * 97) % ids.length]
    for (let f = 0; f < 3; f++) {
      const n = ed.store.doc[id]
      ed.store.set(id, { ...n, x: n.x + 10 }, 'move')
      const [t] = cpu(() => ed.scene())
      main.push(t)
    }
  }
  check(median(main) < DRAG_MS, `dense: main-thread drag frame median ${median(main).toFixed(1)} ms CPU with the worker, budget ${DRAG_MS}`)
  report.dense = { nodes: ids.length, edges, fullMs: full, exactDragMedianMs: median(frames), exactDragP90Ms: [...frames].sort((a, b) => a - b)[Math.floor(frames.length * 0.9)], mainThreadDragMedianMs: median(main), mainThreadDragP90Ms: [...main].sort((a, b) => a - b)[Math.floor(main.length * 0.9)], workerRequests: requests.length }

  // quality against router-v1 where it can finish (800 nodes)
  const small = denseRandom(quick ? 400 : 800)
  const obs = obstaclesOf(small)
  const a = createRouter()(small, obs)
  const [v1ms, b] = cpu(() => v1.createRouter()(small, obs))
  const rows = [] // the receipt: every changed connector, both paths and their measures
  const tally = { identical: 0, better: 0, equal: 0, worse: 0 }
  // bends and length (new − v1) per verdict, so a lexicographic verdict never hides what moved
  const delta = Object.fromEntries(['better', 'equal', 'worse'].map((k) => [k, { connectors: 0, bends: 0, len: 0, moreBends: 0, longer: 0, otherFaces: 0 }]))
  for (const [id, pv1] of b) {
    const pn = a.get(id)
    if (JSON.stringify(pn) === JSON.stringify(pv1)) { tally.identical++; continue }
    const e = small[id], ra = small[e.from.id], rb = small[e.to.id]
    const [sa, sb] = pickSides(ra, rb)
    const preferred = [e.from.side ?? sa, e.to.side ?? sb]
    const others = obs.filter((o) => o.id !== e.from.id && o.id !== e.to.id)
    const authored = [e.from.side ?? null, e.to.side ?? null]
    const qn = routeQuality(pn, others, preferred, authored), qo = routeQuality(pv1, others, preferred, authored)
    const c = compareQuality(qn, qo)
    const verdict = c < 0 ? 'better' : c > 0 ? 'worse' : 'equal'
    tally[verdict]++
    if (c > 0) failures.push(`dense: ${id} is worse than router-v1 ${JSON.stringify({ new: qn, v1: qo })}`)
    rows.push({ id, verdict, v1: { pts: pv1, ...qo }, new: { pts: pn, ...qn } })
    const d = delta[verdict]
    d.connectors++
    d.cost = (d.cost ?? 0) + qn.cost - qo.cost
    d.bends += qn.bends - qo.bends
    d.len += qn.len - qo.len
    if (qn.bends > qo.bends) d.moreBends++
    if (qn.len > qo.len) d.longer++
    if (qn.faces !== qo.faces) d.otherFaces++
  }
  report.quality = { metric: 'broken authored ports, then crossings, then clearance, then length + 28 px per bend; auto-picked faces are reported and never decide', nodes: Object.keys(small).length, edges: b.size, v1FullMs: v1ms, ...tally, changed: delta }
  receipt.quality = { nodes: Object.keys(small).length, edges: b.size, rows }
}

// 4. authored ports are constraints: with declared sides on a third of the connector ends, no route breaks one
{
  for (const [name, d0] of [['dense', denseRandom(quick ? 400 : 1000)], ['realistic', tiledReferences(quick ? 400 : 1200)]]) {
    const rnd = ((x) => () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32))(7)
    const SIDES = ['n', 'e', 's', 'w']
    const doc = Object.fromEntries(Object.entries(d0).map(([k, e]) => [k, e.type !== 'edge' ? e : {
      ...e,
      from: rnd() < 1 / 3 ? { ...e.from, side: SIDES[Math.floor(rnd() * 4)] } : e.from,
      to: rnd() < 1 / 3 ? { ...e.to, side: SIDES[Math.floor(rnd() * 4)] } : e.to,
    }]))
    const routes = createRouter()(doc, obstaclesOf(doc))
    let declared = 0, broken = 0
    for (const [id, pts] of routes) {
      const e = doc[id]
      if (e.route === 'straight' || e.route === 'curve') continue
      const q = routeQuality(pts, [], null, [e.from.side ?? null, e.to.side ?? null])
      declared += Number(e.from.side != null) + Number(e.to.side != null)
      broken += q.brokenPorts
    }
    check(broken === 0, `authored ports: ${broken} of ${declared} declared sides broken on the ${name} board`)
    ;(report.authoredPorts ??= {})[name] = { declaredSides: declared, broken }
  }
}

report.failures = failures
// provenance for the receipt: the exact sources measured
const hash = (f) => createHash('sha256').update(readFileSync(new URL(f, import.meta.url))).digest('hex')
const sources = ['../src/products/boxwire/core/route.js', '../src/products/boxwire/core/edges.js', '../src/products/boxwire/core/routeQuality.js', '../src/products/boxwire/core/fixtures/router-v1/route.js', '../src/products/boxwire/core/fixtures/router-v1/edges.js', './boxwire-route-gate.mjs']
let head = null
try { head = execSync('git rev-parse HEAD', { cwd: new URL('.', import.meta.url), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { head = null }
receipt.head = head
receipt.dirty = (() => { try { return execSync('git status --porcelain -- src/products/boxwire/core scripts', { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null } catch { return null } })()
receipt.sha256 = Object.fromEntries(sources.map((f) => [f.replace(/^\.\.\//, ''), hash(f)]))
receipt.report = report
if (arg('receipt')) writeFileSync(arg('receipt'), JSON.stringify(receipt) + '\n')
const text = JSON.stringify(report, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 10) / 10 : v), 2)
console.log(text)
if (arg('out')) writeFileSync(arg('out'), text + '\n')
if (failures.length) {
  console.error(`FAIL: ${failures.length} check(s) failed`)
  process.exit(1)
}
