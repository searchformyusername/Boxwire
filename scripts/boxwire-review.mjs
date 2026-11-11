// Local review of authored Boxwire diagrams: compiles each file and prints the
// lint results (violation / unknown / pass) and the capacity formulas. The same
// pure modules run in the browser, so this reproduces exactly what Boxwire shows.
//   mise exec node@22.23.2 -- node scripts/boxwire-review.mjs path/to/a.boxwire-diagram.json [--capacity]

import fs from 'node:fs'
import { compileDiagram } from '../src/products/boxwire/author/compile.js'
import { lint } from '../src/products/boxwire/review/lint.js'

// a deterministic stand-in for canvas text measurement (layout only; review never reads sizes)
const measure = (s, font) => s.length * Number(/(\d+)px/.exec(font)[1]) * 0.55
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const showCapacity = process.argv.includes('--capacity')
let failed = false
for (const file of files) {
  const r = compileDiagram(JSON.parse(fs.readFileSync(file, 'utf8')), { measure })
  console.log(`\n== ${file}`)
  if (r.errors.length) {
    failed = true
    for (const e of r.errors) console.log(`error ${e.path}: ${e.message}`)
    continue
  }
  for (const w of r.warnings) console.log(`warning ${w.path}: ${w.message}`)
  const res = lint(r.doc)
  if (res.violations.length) failed = true
  for (const x of res.results) console.log(`${x.status.padEnd(9)} ${x.rule.padEnd(30)} ${x.message}${x.declare ? `  [declare: ${x.declare}]` : ''}`)
  if (showCapacity && res.capacity) {
    for (const [id, info] of res.capacity.nodes) {
      if (!info.steps.length) continue
      console.log(`  # ${id}`)
      for (const s of info.steps) console.log(`      ${s.label}: ${s.formula} = ${s.value}`)
    }
  }
}
process.exit(failed ? 1 : 0)
