// One change review from source texts: the function the Change review dialog
// runs, that writes a review bundle's results.json, and that a bundle's
// recipient re-runs to reproduce them (bundle/bundle.js `recompute`). Same
// texts in, same JSON out, in the browser and in node.

import { parseSource } from '../source/cst.js'
import { indexSource } from '../source/index.js'
import { lineDiff, unified } from '../source/linediff.js'
import { sourceForChanges } from '../source/accept.js'
import { reviewChange } from './review.js'
import { acceptChanges } from './merge.js'
import { allChanges } from './diff.js'
import { freeze, lru } from './memo.js'

export const ACCEPTED_FORMAT = 'boxwire-accepted-change'

/** FNV-1a over the text: ties results.json to the exact accepted source it describes. */
function checksum(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** The accepted-change file a bundle carries: the reviewer's selection (an input) and the unified patch. */
export const acceptedPatchFile = (selection, unified) => ({ format: ACCEPTED_FORMAT, version: 1, selection, patch: unified })

/** The reviewer's selection stored in an accepted.patch.json text, or null when there is none (or it isn't one). */
export function bundledSelection(acceptedPatch) {
  if (typeof acceptedPatch !== 'string') return null
  try {
    const file = JSON.parse(acceptedPatch)
    return file?.format === ACCEPTED_FORMAT && file.selection != null ? file.selection : null
  } catch {
    return null
  }
}

/**
 * The change review dialog's checkbox state for a stored selection: the set of rejected change ids
 * (unticked boxes) among `changeIds`. A selection is `{ all: true, except: [ids], header? }` or a list of
 * accepted ids (the header box is read with takesHeader). Ids the selection names that this diff doesn't have come back in `unknown`.
 * Returns { rejected: Set, unknown: [ids] }.
 */
export function rejectedFromSelection(selection, changeIds) {
  const ids = new Set(changeIds)
  const isAll = selection !== null && typeof selection === 'object' && !Array.isArray(selection) && selection.all === true
  const named = isAll ? (Array.isArray(selection.except) ? selection.except : []) : Array.isArray(selection) ? selection : []
  const unknown = named.filter((id) => !ids.has(id))
  const rejected = isAll ? new Set(named.filter((id) => ids.has(id))) : new Set(changeIds.filter((id) => !named.includes(id)))
  return { rejected, unknown }
}

/**
 * Whether accepting `selection` takes the proposal's header (the comments before its first field: an
 * import's provenance, loss report and original comments), given how many model changes it applies.
 * A selection says so itself with a boolean `header` (`{ all: true, except: [ids], header }`, what the
 * change review dialog writes), independent of which model changes are ticked. A selection without
 * one was written before that flag existed, and gets the rule it was written under, so its bundle
 * still recomputes to the same bytes: "everything" takes the header, and so does a list of ids that
 * applies any change.
 */
export function takesHeader(selection, applied) {
  const obj = selection !== null && typeof selection === 'object' && !Array.isArray(selection)
  if (obj && typeof selection.header === 'boolean') return selection.header
  return (obj && selection.all === true) || applied > 0
}

/**
 * Re-run a bundle's checks from its own files (bundle/bundle.js `recompute`). The reviewer's
 * selection comes from accepted.patch.json; everything else is derived again from the sources,
 * so any edit to a source, the rules or the accepted text shows up as a mismatch.
 */
export function recomputeFromBundle({ baseline, proposal, rules, accepted, acceptedPatch }) {
  const selection = bundledSelection(acceptedPatch)
  const out = reviewSources({ baseline, proposal, rules, accept: selection })
  if (out.error) return { error: out.error.message }
  if (out.results.accepted && accepted != null && checksum(accepted) !== out.results.accepted.sourceChecksum) out.results.accepted.sourceChecksum = `bundled accepted source differs (${checksum(accepted)})`
  return out.results
}

/** Parse a source text; { value, cst, index } or { error: { message, line, col } }. */
export function readSource(text, label) {
  const hit = typeof text === 'string' ? sources.get(text) : undefined
  if (hit) return hit
  const p = parseSource(text)
  if (!p.value) return { error: { ...p.errors[0], message: `${label}: ${p.errors[0].message} (line ${p.errors[0].line}, column ${p.errors[0].col})` } }
  // frozen: the cached value is shared by every later review of the same text
  return sources.set(text, { value: freeze(p.value), cst: p.cst, index: indexSource(p.cst, p.value) })
}
/** Parsed sources by exact text: re-reviewing after a toggle or a small edit re-reads only what changed. */
const sources = lru(8)

/** Parse a rules document (JSON or JSONC); null text means built-in checks only. */
export function readRules(text) {
  if (text == null || !text.trim()) return { value: null }
  const p = parseSource(text)
  return p.value ? { value: p.value } : { error: { ...p.errors[0], message: `rules: ${p.errors[0].message} (line ${p.errors[0].line})` } }
}

/**
 * Review `proposal` against `baseline` (source texts) under `rules` (text or null), optionally
 * accepting a subset of changes. Returns { error } or { review, accepted?, results }, where
 * `results` is the plain JSON a bundle stores and its recipient recomputes.
 */
export function reviewSources({ baseline, proposal, rules = null, ours = null, accept = null }) {
  const b = readSource(baseline, 'baseline'), p = readSource(proposal, 'proposal'), r = readRules(rules)
  const o = ours == null ? null : readSource(ours, 'your edit')
  const failed = [b, p, r, o].find((x) => x?.error)
  if (failed) return { error: failed.error }
  const spanOf = { base: (q) => b.index.spanOf(q), proposal: (q) => p.index.spanOf(q) }
  const review = reviewChange({ base: b.value, proposal: p.value, rules: r.value, ...(o && { ours: o.value }), spanOf })
  let accepted = null
  if (accept) {
    const a = acceptChanges(b.value, p.value, accept, { rules: r.value })
    const changes = allChanges(review.diff).filter((c) => a.applied.includes(c.id))
    const header = takesHeader(accept, changes.length)
    const written = sourceForChanges(baseline, changes, p.value, proposal, { header })
    const hunks = written.error ? [] : lineDiff(baseline, written.text)
    accepted = { ...a, header, source: written.text ?? null, unsupported: written.unsupported ?? [], writeError: written.error ?? null, patch: unified(hunks), hunks }
  }
  const results = {
    version: 1,
    note: review.note,
    comparison: review.comparison,
    // identity (edge ids written down) is listed only when there is some, so bundles without any read as before
    summary: review.summary.identity.length ? review.summary : { semantic: review.summary.semantic, layout: review.summary.layout, presentation: review.summary.presentation },
    semantic: review.diff.semantic,
    layout: review.diff.layout,
    presentation: review.diff.presentation,
    ...(review.diff.identity.length && { identity: review.diff.identity }),
    rules: [...review.introduced.map((x) => ({ ...x, side: 'proposal', change: 'introduced' })), ...review.resolved.map((x) => ({ ...x, side: 'baseline', change: 'resolved' }))],
    introduced: review.introduced.map((x) => x.id),
    resolved: review.resolved.map((x) => x.id),
    conflicts: review.merge?.conflicts ?? [],
    ...(accepted && { accepted: { selection: accept, applied: accepted.applied, required: accepted.required, rejected: accepted.rejected, brokenInvariants: accepted.brokenInvariants, valid: accepted.valid, unsupported: accepted.unsupported, sourceChecksum: checksum(accepted.source ?? '') } }),
  }
  return { review, accepted, results, values: { baseline: b.value, proposal: p.value }, indexes: { baseline: b.index, proposal: p.index } }
}
