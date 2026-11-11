// One architecture change review, as a pure function the UI, the offline
// review bundle and a command line all call: the semantic diff, the declared
// rules on both sides (with which violations the proposal introduces or
// resolves) and, when a human has edited the same baseline, the three-way
// merge of their edits with the proposal. Deterministic: the same inputs give
// the same JSON in node and in the browser.

import { allChanges, diffModels, summarise } from './diff.js'
import { merge3 } from './merge.js'
import { STUB_MEASURE } from './model.js'
import { SCOPE_NOTE, evaluateRules } from '../policy/rules.js'

export const REVIEW_VERSION = 1

const violations = (evaluation) => evaluation.results.filter((r) => r.status === 'violation')

/** Why an evaluation can't be compared (aborted, rules invalid, diagram didn't compile), or null when it can. */
function incomplete(side, e) {
  if (e.errors?.length) return `the rules document is invalid (${e.errors[0].message})`
  if (e.limits?.exceeded) return `the ${side} evaluation stopped: ${e.limits.message}`
  if (!e.complete) return `the ${side} diagram doesn't compile, so only the built-in checks ran`
  return null
}

/**
 * Review `proposal` against `base` under `rules` (a `boxwire-rules` document).
 * `ours` (optional) is a human edit of the same base; it is merged with the
 * proposal as `theirs`. `spanOf` is `{ base?, proposal? }`, each
 * `({ entity, id, index, key }) => range | null` for that side's source.
 * Returns `{ version, note, diff, summary, merge?, rules: { base, proposal }, comparison, introduced, resolved }`:
 * `summary` is `{ semantic, layout, presentation, identity }` lines of text;
 * `comparison` is `{ status: 'complete' }` or `{ status: 'not-evaluated', reasons }`;
 * `introduced` / `resolved` are violation results by stable id, and are only computed when both
 * evaluations are complete: an aborted or partial evaluation is never evidence that a violation
 * went away (or appeared).
 */
export function reviewChange({ base, proposal, ours, rules, spanOf = {}, measure = STUB_MEASURE, maxNodes, budget }) {
  const diff = diffModels(base, proposal)
  const opts = (side) => ({ measure, ...(spanOf[side] && { spanOf: spanOf[side] }), ...(maxNodes && { maxNodes }), ...(budget && { budget }) })
  const evaluated = { base: evaluateRules(base, rules, opts('base')), proposal: evaluateRules(proposal, rules, opts('proposal')) }
  const reasons = [incomplete('baseline', evaluated.base), incomplete('proposal', evaluated.proposal)].filter(Boolean)
  const comparable = !reasons.length
  const before = new Set(violations(evaluated.base).map((r) => r.id))
  const after = new Set(violations(evaluated.proposal).map((r) => r.id))
  return {
    version: REVIEW_VERSION,
    note: SCOPE_NOTE,
    diff,
    summary: { semantic: summarise(diff.semantic), layout: summarise(diff.layout), presentation: summarise(diff.presentation), identity: summarise(diff.identity) },
    changeCount: allChanges(diff).length,
    ...(ours !== undefined && { merge: merge3(base, ours, proposal, { measure }) }),
    rules: evaluated,
    comparison: comparable ? { status: 'complete' } : { status: 'not-evaluated', reasons },
    introduced: comparable ? violations(evaluated.proposal).filter((r) => !before.has(r.id)) : [],
    resolved: comparable ? violations(evaluated.base).filter((r) => !after.has(r.id)) : [],
  }
}
