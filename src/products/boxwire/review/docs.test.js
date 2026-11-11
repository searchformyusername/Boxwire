import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CAPACITY_FIELDS, CARRIES } from '../core/declared.js'
import { RULES } from './lint.js'
import { rubricDefinition } from './rubric.js'

// The guide is the published contract for rules and rubric: it must say exactly what the code does.
const guide = fs.readFileSync(new URL('../../../../public/products/boxwire/llm.md', import.meta.url), 'utf8')

describe('published guide', () => {
  it('documents every lint rule with its outcomes and fix, word for word', () => {
    for (const r of RULES) {
      expect(guide, r.id).toContain(`### \`${r.id}\` (${r.severity})`)
      for (const k of ['checks', 'violation', 'unknown', 'pass', 'fix']) expect(guide, `${r.id}.${k}`).toContain(r[k])
    }
  })
  it('publishes every rubric item with its points, plus the assumptions and limits', () => {
    const def = rubricDefinition()
    for (const i of def.items) expect(guide, i.id).toContain(`| \`${i.id}\`: ${i.title.replace(/\|/g, '\\|')} | ${i.phase} | ${i.points} | ${i.rule.replace(/\|/g, '\\|')} |`)
    for (const a of [...def.assumptions, ...def.cannotInfer]) expect(guide).toContain(a)
    for (const p of def.phases) expect(guide).toContain(`| ${p.title} (\`${p.id}\`) | ${p.minutes} |`)
  })
  it('lists every capacity field and edge declaration', () => {
    for (const k of Object.keys(CAPACITY_FIELDS)) expect(guide, k).toContain(`| \`${k}\` |`)
    for (const c of CARRIES) expect(guide).toContain(`\`${c}\``)
    expect(guide).toContain('Rules check the declared model, not the deployed system.')
  })
})
