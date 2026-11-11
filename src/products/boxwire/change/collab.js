// Two concurrent edits of one source file, merged without a server: the same
// three-way merge the change review uses (change/merge.js, field by field by
// stable id, conflicts as cards), written back as minimal edits to the base
// text. Symmetric by construction: the two sides are put in a canonical order
// (by their text) before merging, so mergeSources(base, a, b) and
// mergeSources(base, b, a) give the same text and the same conflicts (with
// ours and theirs swapped). Deterministic and pure, in the browser and in node.

import { merge3, resolve } from './merge.js'
import { allChanges, diffModels } from './diff.js'
import { assignIds } from '../author/compile.js'
import { readSource } from './handoff.js'
import { sourceForChanges } from '../source/accept.js'
import { COLLECTION, checkValue, clone, cmp, entities, setField } from './model.js'

const flip = { ours: 'theirs', theirs: 'ours' }
const withoutId = (e) => {
  const o = { ...e }
  delete o.id
  return o
}

/**
 * Merge `ours` and `theirs` (source texts, both edited from `base`). Returns { error } or
 * { text, value, conflicts, applied: { ours, theirs }, valid, unsupported }.
 * - Conflict-free: `text` is the base text with every change of both sides written as minimal edits
 *   (comments of both sides' added items and headers carried, as in an accepted change).
 * - With conflicts: `text` holds every non-conflicting change and the base content where they conflict;
 *   `conflicts` are the cards ({ id, kind, entity, key, field, base, ours, theirs, message, changes }),
 *   and resolveSources() finishes the merge from the chosen sides.
 */
export function mergeSources({ base, ours, theirs }) {
  const swapped = cmp(ours, theirs) > 0 // canonical order: the side with the smaller text merges as "first"
  const [first, second] = swapped ? [theirs, ours] : [ours, theirs]
  const b = readSource(base, 'base'), x = readSource(first, swapped ? 'theirs' : 'ours'), y = readSource(second, swapped ? 'ours' : 'theirs')
  const failed = [b, x, y].find((r) => r.error)
  if (failed) return { error: failed.error }
  const m = merge3(b.value, unpinned(b.value, x.value), unpinned(b.value, y.value))
  const out = write(base, b.value, m.value, [first, second])
  const side = (s) => (swapped ? flip[s] : s)
  return {
    ...out,
    conflicts: m.conflicts.map((c) => (swapped ? { ...c, ours: c.theirs, theirs: c.ours, changes: { ours: c.changes.theirs, theirs: c.changes.ours } } : c)),
    applied: { [side('ours')]: m.applied.ours, [side('theirs')]: m.applied.theirs },
    valid: m.valid && !out.unsupported.length,
    merge: m,
    swapped,
  }
}

/**
 * Finish a merge with conflicts. `choices` maps conflict id → 'ours' | 'theirs' | 'base' (in the caller's terms)
 * or { edit: value }: the value written by hand for that field (or, for an element-level card, the whole
 * element; null removes it). Returns { text, value, unresolved, valid, errors, unsupported }.
 */
export function resolveSources({ base, ours, theirs }, merged, choices) {
  const edits = []
  const canonical = Object.fromEntries(Object.entries(choices).map(([id, c]) => {
    if (c && typeof c === 'object' && 'edit' in c) {
      edits.push([merged.conflicts.find((x) => x.id === id), c.edit])
      return [id, 'base']
    }
    return [id, merged.swapped && c !== 'base' ? flip[c] : c]
  }))
  const r = resolve(merged.merge, canonical)
  let value = r.value
  if (edits.length) {
    value = clone(value)
    const index = entities(value)
    for (const [card, v] of edits) {
      if (!card) continue
      if (card.field) {
        const e = index.get(`${card.entity}:${card.key}`)
        if (e) setField(e.obj, card.field, v)
        continue
      }
      const coll = COLLECTION[card.entity]
      const list = Array.isArray(value[coll]) ? value[coll] : (value[coll] = [])
      const at = list.findIndex((o) => index.get(`${card.entity}:${card.key}`)?.obj === o)
      if (v === null) at >= 0 && list.splice(at, 1)
      else if (at >= 0) list[at] = clone(v)
      else list.push(clone(v))
    }
  }
  const b = readSource(base, 'base')
  const texts = merged.swapped ? [theirs, ours] : [ours, theirs]
  const out = write(base, b.value, value, texts)
  const errors = checkValue(out.value).errors
  return { ...out, unresolved: r.unresolved, errors, valid: !r.unresolved.length && !errors.length && !out.unsupported.length }
}

/**
 * A side's value without the generated ids it merely wrote down (pins: an id-less base connector given the id
 * it compiled to in the base). Each side pins whichever connectors its own edits shifted, so the same id can name
 * different connectors on the two sides; merging them as names would collide. Without them both sides meet
 * on the base's id-less connectors, and the merged text pins whatever its own edits need.
 */
function unpinned(baseValue, sideValue) {
  // the ids the base's id-less connectors compile to; a side's connector carrying one of them (and not an
  // id the base itself declares) is one of those connectors with its id written down, even if it was
  // also reconnected
  const baseEdges = Array.isArray(baseValue.edges) ? baseValue.edges : []
  const explicit = new Set(baseEdges.map((e) => e?.id).filter((id) => typeof id === 'string'))
  const generated = assignIds(baseValue).edges
  const pins = new Set(baseEdges.map((e, i) => (e && e.id === undefined ? generated[i] : null)).filter((id) => id && !explicit.has(id)))
  if (!pins.size || !Array.isArray(sideValue.edges)) return sideValue
  return { ...sideValue, edges: sideValue.edges.map((e) => (e && pins.has(e.id) ? withoutId(e) : e)) }
}

/**
 * The merged model written into the base text as minimal edits. `value` is what that text says (the merged
 * model plus whatever connector ids the edits had to write down to keep the base's connectors stable).
 */
function write(baseText, baseValue, value, texts) {
  const changes = allChanges(diffModels(baseValue, value))
  const w = sourceForChanges(baseText, changes, value, texts, { header: true })
  const text = w.text ?? baseText
  return { text, value: readSource(text, 'merged').value ?? value, unsupported: w.unsupported ?? [], ...(w.error && { error: w.error }) }
}
