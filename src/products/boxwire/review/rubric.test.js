import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compileDiagram } from '../author/compile.js'
import { fold } from '../core/history.js'
import { problemById } from '../problems/index.js'
import { ITEMS, rubricDefinition, scoreBoard } from './rubric.js'
import { PHASES, activity, advance, phaseAt, readPractice, startPractice, timing } from './practice.js'

const measure = (s, font) => s.length * Number(/(\d+)px/.exec(font)[1]) * 0.55
const MIN = 60000
const solution = (id) => JSON.parse(fs.readFileSync(new URL(`../problems/solutions/${id}.boxwire-diagram.json`, import.meta.url), 'utf8'))

/** A practice session with every phase exactly on budget: 0, 5, 10, 25, 35, end 40 min. */
function onTimeSession() {
  let s = startPractice('url-shortener', 0)
  for (const t of [5, 10, 25, 35, 40]) s = advance(s, t * MIN)
  return s
}

/**
 * The golden board: the URL-shortener reference built with a scripted clock, the way a
 * candidate would in a session — requirements first, the load on the client during
 * Estimates, the design during HLD, the rejected option and trade-off note at the end.
 */
function goldenBoard() {
  const r = compileDiagram(solution('url-shortener'), { measure })
  const when = { req: 2, client: 7, worker: 27, wh: 28, seq: 36, trade: 37, 'f-write': 38, 'f-read': 38.5, 'f-analytics': 39 }
  let hld = 11
  const done = r.board.done.map((txn) => {
    const id = txn.changes[0][0]
    return { ...txn, t: (when[id] ?? (hld += 0.5)) * MIN }
  })
  return { base: r.board.base, done, doc: fold(r.board.base, done) }
}

describe('practice clock', () => {
  it('advances through the phases and ends after the last', () => {
    const s = onTimeSession()
    expect(s.marks.map((m) => m.phase)).toEqual(PHASES.map((p) => p.id))
    expect(s.endedAt).toBe(40 * MIN)
    expect(advance(s, 50 * MIN)).toBe(s)
  })
  it('resumes exactly after a reload: the marks are absolute times', () => {
    const s = startPractice('chat', 1_000_000)
    const reloaded = readPractice(JSON.parse(JSON.stringify(s)))
    expect(timing(reloaded, 1_000_000 + 83_000)[0]).toMatchObject({ status: 'current', elapsed: 83_000 })
  })
  it('rejects damaged sessions', () => {
    expect(readPractice({ ...startPractice('x', 0), marks: [{ phase: 'hld', t: 0 }] })).toBeNull()
    expect(readPractice({ ...startPractice('x', 10), marks: [{ phase: 'requirements', t: 10 }, { phase: 'estimates', t: 5 }] })).toBeNull()
    expect(readPractice(null)).toBeNull()
  })
  it('attributes history steps to the phase running when they were committed', () => {
    const s = onTimeSession()
    expect([phaseAt(s, -1), phaseAt(s, 0), phaseAt(s, 9.9 * MIN), phaseAt(s, 30 * MIN), phaseAt(s, 41 * MIN)]).toEqual([-1, 0, 1, 3, 5])
    expect(activity(s, goldenBoard().done)).toEqual([1, 1, 16, 2, 5])
  })
})

describe('rubric', () => {
  it('publishes 100 points over versioned items', () => {
    const def = rubricDefinition()
    expect(def.version).toBe(1)
    expect(def.items.reduce((s, i) => s + i.points, 0)).toBe(100)
    expect(new Set(ITEMS.map((i) => i.id)).size).toBe(ITEMS.length)
    expect(def.assumptions.length).toBeGreaterThan(3)
    expect(def.cannotInfer.length).toBeGreaterThan(3)
  })

  it('golden board scores a fixed result, every item backed by elements and replay times', () => {
    const { base, done, doc } = goldenBoard()
    const s = scoreBoard({ doc, base, done, practice: onTimeSession(), problem: problemById('url-shortener'), now: 40 * MIN })
    expect([s.earned, s.max, s.percent]).toEqual([100, 100, 100])
    expect(s.items.map((i) => `${i.id} ${i.status} ${i.earned}/${i.points} ${i.evidence.map((e) => `${e.id}@${e.at?.t / MIN}m/${e.at?.replay}ms`).join(',')}`)).toMatchInlineSnapshot(`
      [
        "requirements-note met 8/8 req@2m/450ms",
        "load-declared met 8/8 client@7m/2090ms",
        "storage-derived met 4/4 db@16.5m/11290ms",
        "entry-path met 8/8 client@7m/2090ms,lb@11.5m/2750ms,gw@12.5m/4146ms,api@13.5m/6182ms",
        "durable-writes met 8/8 client@7m/2090ms,lb@11.5m/2750ms,gw@12.5m/4146ms,api@13.5m/6182ms,db@16.5m/11290ms",
        "read-path-cache met 8/8 client@7m/2090ms,lb@11.5m/2750ms,gw@12.5m/4146ms,api@13.5m/6182ms,cache@15.5m/9658ms",
        "must-have-components met 12/12 api@13.5m/6182ms,db@16.5m/11290ms,cache@15.5m/9658ms,clicks@17.5m/13338ms",
        "async-offload met 4/4 clicks@17.5m/13338ms,worker@27m/14926ms",
        "redundancy met 8/8 client@7m/2090ms,lb@11.5m/2750ms,gw@12.5m/4146ms,api@13.5m/6182ms,db@16.5m/11290ms,clicks@17.5m/13338ms,worker@27m/14926ms,wh@28m/16418ms",
        "capacity-consistent met 8/8 api@13.5m/6182ms,cache@15.5m/9658ms,clicks@17.5m/13338ms,db@16.5m/11290ms,gw@12.5m/4146ms,kgs@14.5m/7578ms,lb@11.5m/2750ms,worker@27m/14926ms",
        "no-lint-errors met 6/6 ",
        "rejected-alternative met 6/6 seq@36m/17686ms",
        "trade-off-notes met 4/4 trade@37m/18790ms",
        "phase-timing met 8/8 ",
      ]
    `)
  })

  it('the same board outside practice skips the timeline items', () => {
    const { base, done, doc } = goldenBoard()
    const s = scoreBoard({ doc, base, done, problem: problemById('url-shortener') })
    expect(s.items.find((i) => i.id === 'phase-timing')).toMatchObject({ status: 'n/a', points: 0 })
    expect([s.earned, s.max]).toEqual([92, 92])
  })

  it('a phase skipped with no work in it is "skipped", not on time', () => {
    const { base, done, doc } = goldenBoard()
    let s = startPractice('url-shortener', 0)
    for (const t of [5, 10, 25, 25.2, 30]) s = advance(s, t * MIN) // deep dive ended after 12 s with no steps
    // everything drawn after minute 25 lands in the trade-offs phase (25.2–30 min) instead
    const quiet = done.map((txn) => (txn.t >= 25 * MIN ? { ...txn, t: 26 * MIN + (txn.t - 25 * MIN) / 5 } : txn))
    const item = scoreBoard({ doc, base, done: quiet, practice: s, problem: problemById('url-shortener'), now: 30 * MIN }).items.find((i) => i.id === 'phase-timing')
    expect(item.detail).toContain('Deep dive skipped')
    expect(item.earned).toBeCloseTo(8 * 4 / 5)
  })

  it('a rushed, undeclared board: undeclared facts are listed, not marked wrong', () => {
    const r = compileDiagram({
      format: 'boxwire-diagram', version: 1,
      nodes: [{ id: 'c', kind: 'web-client' }, { id: 'api', kind: 'service' }, { id: 'db', kind: 'sql-database' }],
      edges: [{ from: 'c', to: 'api' }, { from: 'api', to: 'db' }],
    }, { measure })
    let session = startPractice('url-shortener', 0)
    session = advance(session, 20 * MIN) // requirements ran 20 minutes over a 5-minute budget
    const s = scoreBoard({ doc: r.doc, base: r.board.base, done: r.board.done.map((t) => ({ ...t, t: 21 * MIN })), practice: session, problem: problemById('url-shortener'), now: 22 * MIN })
    const by = Object.fromEntries(s.items.map((i) => [i.id, i.status]))
    expect(by).toMatchObject({
      'requirements-note': 'missed', 'load-declared': 'missed', 'entry-path': 'missed', 'durable-writes': 'met',
      redundancy: 'undeclared', 'capacity-consistent': 'undeclared', 'rejected-alternative': 'missed', 'phase-timing': 'missed',
    })
    expect(s.items.find((i) => i.id === 'redundancy').detail).toMatch(/undeclared/)
    expect(s.percent).toBeLessThan(40)
  })

  it('every reference solution earns every graph item it can without a timeline', async () => {
    for (const id of ['url-shortener', 'news-feed', 'chat', 'rate-limiter', 'notifications', 'web-crawler', 'typeahead', 'ride-hailing', 'video-streaming', 'payments', 'ticket-booking', 'file-sync']) {
      const r = compileDiagram(solution(id), { measure })
      const s = scoreBoard({ doc: r.doc, base: r.board.base, done: r.board.done, problem: problemById(id) })
      const short = s.items.filter((i) => i.earned < i.points).map((i) => `${i.id}: ${i.detail}`)
      expect(short, id).toEqual([])
    }
  })
})
