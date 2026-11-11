// Change-review performance at scale, with assertions. Measures what the Change review dialog
// runs (change/handoff.js reviewSources) on synthetic sources of N nodes:
//   cold      first review of a baseline and proposal, every cache empty (review + accepted subset)
//   toggle    re-review after the reviewer unticks one change (accepted subset only)
//   edit      re-review after a small edit to the proposal (a new proposal text; baseline cached)
// Results computed with warm caches must equal a cold computation exactly, and re-reviews must stay
// under the budget. Exits non-zero on any failure.
//   mise exec node@22.23.2 -- node scripts/boxwire-perf.mjs [--nodes 1400] [--changes 0] [--budget 500] [--out file.json]

import { writeFileSync } from 'node:fs'
import { largeSources } from '../src/products/boxwire/change/fixtures/large.js'
import { reviewSources } from '../src/products/boxwire/change/handoff.js'
import { clearCaches } from '../src/products/boxwire/change/memo.js'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : fallback
}
const N = Number(arg('nodes', 1400)), CHANGES = Number(arg('changes', 0)), BUDGET = Number(arg('budget', 500)), REPS = Number(arg('reps', 5))
const OUT = arg('out', null)

const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const time = (fn) => {
  const a = performance.now()
  const out = fn()
  return [performance.now() - a, out]
}

const { baseline, proposal, base } = largeSources(N, { changes: CHANGES })
const all = { all: true, except: [] }
const open = (inputs, accept = all) => [reviewSources(inputs), reviewSources({ ...inputs, accept })]

// cold: a fresh review each time
const cold = []
let first
for (let i = 0; i < REPS; i++) {
  clearCaches()
  const [ms, out] = time(() => open({ baseline, proposal }))
  cold.push(ms)
  first ??= out
}
const [run] = first
check(!run.error, `review failed: ${run.error?.message}`)
const ids = run.review.diff.semantic.map((c) => c.id)
check(ids.length >= 4 + CHANGES, `expected at least ${4 + CHANGES} model changes, got ${ids.length}`)

// toggle: untick one change at a time (warm: the open review is cached)
const toggle = []
for (let i = 0; i < REPS; i++) {
  const accept = { all: true, except: [ids[i % ids.length]] }
  const [ms, out] = time(() => reviewSources({ baseline, proposal, accept }))
  toggle.push(ms)
  if (i === 0) {
    clearCaches()
    const fresh = reviewSources({ baseline, proposal, accept })
    check(JSON.stringify(fresh.results) === JSON.stringify(out.results), 'toggle: warm results differ from a cold computation')
    check(fresh.accepted.source === out.accepted.source, 'toggle: warm accepted source differs from a cold computation')
    open({ baseline, proposal }) // re-warm
  }
}

// edit: each repetition is a new proposal text with one more relabel (baseline stays cached)
const edit = []
for (let i = 0; i < REPS; i++) {
  const p = proposal.replace(`"label": "service ${400 + i}"`, `"label": "service ${400 + i} (edited)"`)
  check(p !== proposal, `edit ${i}: the edit did not apply`)
  const [ms, out] = time(() => open({ baseline, proposal: p }))
  edit.push(ms)
  if (i === 0) {
    clearCaches()
    const fresh = open({ baseline, proposal: p })
    check(JSON.stringify(fresh.map((x) => x.results)) === JSON.stringify(out.map((x) => x.results)), 'edit: warm results differ from a cold computation')
  }
}

const report = {
  nodes: base.nodes.length, edges: base.edges.length, bytes: baseline.length, changes: ids.length, reps: REPS, budgetMs: BUDGET,
  node: process.version,
  ms: { cold: { median: median(cold), all: cold }, toggle: { median: median(toggle), all: toggle }, edit: { median: median(edit), all: edit } },
}
check(median(toggle) < BUDGET, `toggle re-review median ${median(toggle).toFixed(1)} ms is over the ${BUDGET} ms budget`)
check(median(edit) < BUDGET, `edit re-review median ${median(edit).toFixed(1)} ms is over the ${BUDGET} ms budget`)
report.failures = failures
const text = JSON.stringify(report, (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 10) / 10 : v), 2)
console.log(text)
if (OUT) writeFileSync(OUT, text + '\n')
if (failures.length) {
  console.error(`FAIL: ${failures.length} check(s) failed`)
  process.exit(1)
}
