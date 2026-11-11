// Timelapse: turns the build history into timed steps and answers "what does
// the board look like at time t". Every frame is fold(base, steps so far)
// plus a tween of the step in flight, so the last frame is the live board.

import { applyChanges, fold } from './history.js'

const LEAD_MS = 450
const GAP_MS = 140
const HOLD_MS = 1800
/** Playback speed the timelapse opens at; timestamps shown to users (score evidence) are in this clock. */
export const DEFAULT_SPEED = 1.5

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
const easeOutBack = (t) => 1 + 2.4 * (t - 1) ** 3 + 1.4 * (t - 1) ** 2
const lerp = (a, b, t) => a + (b - a) * t

const isTyping = (before, after) => typeof after?.text === 'string' && after.text.length > (before?.text?.length ?? 0) && after.text.startsWith(before?.text ?? '')

/**
 * Group the history into replay steps. Follow-up edits to elements created in
 * the previous step (typing a label right after placing a box) merge into it.
 * With hideDeadEnds, elements that never reach the final board are skipped.
 */
export function buildSteps(base, done, { hideDeadEnds = true } = {}) {
  const final = fold(base, done)
  const keep = ([id]) => !hideDeadEnds || id in final || id in base
  const steps = []
  for (const t of done) {
    const changes = t.changes.filter(keep)
    if (!changes.length) continue
    const prev = steps[steps.length - 1]
    if (prev && changes.every(([id]) => prev.created.has(id))) {
      const byId = new Map(prev.changes.map((c) => [c[0], c]))
      for (const [id, , after] of changes) byId.set(id, [id, byId.get(id)[1], after])
      prev.changes = [...byId.values()].filter(([, b, a]) => a || b)
      continue
    }
    steps.push({ label: t.label, changes, created: new Set(changes.filter(([, b]) => !b).map(([id]) => id)) })
  }
  return steps.map((s) => ({ label: s.label, changes: s.changes, dur: durationOf(s.changes) }))
}

function durationOf(changes) {
  let d = 0
  for (const [, before, after] of changes) {
    const el = after ?? before
    let t
    if (!after) t = 320
    else if (!before) t = el.type === 'node' ? 520 : el.type === 'edge' ? 440 : Math.min(1200, 350 + el.pts.length * 4)
    else t = 380
    if (isTyping(before, after)) t = Math.max(t, Math.min(1500, 260 + (after.text.length - (before?.text?.length ?? 0)) * 32))
    d = Math.max(d, t)
  }
  return d
}

function tween(before, after, p) {
  const fx = {}
  if (!before) {
    const el = after
    if (el.type === 'node') {
      const appear = clamp01(p / 0.45)
      fx.alpha = appear
      fx.scale = 0.9 + 0.1 * easeOutBack(appear)
      if (el.text) fx.text = el.text.slice(0, Math.round(el.text.length * clamp01((p - 0.3) / 0.7)))
    } else {
      fx.progress = easeInOut(p)
    }
    return { el, fx }
  }
  if (!after) return { el: before, fx: { alpha: 1 - p } }
  const e = easeInOut(p)
  const el = { ...(p < 0.5 ? before : after) }
  if (before.type !== 'edge' && after.type !== 'edge') for (const k of ['x', 'y', 'w', 'h']) el[k] = lerp(before[k], after[k], e)
  else {
    const mid = (a, b) => (a.id || b.id ? (p < 0.5 ? a : b) : { x: lerp(a.x, b.x, e), y: lerp(a.y, b.y, e) })
    el.from = mid(before.from, after.from)
    el.to = mid(before.to, after.to)
  }
  if (isTyping(before, after)) {
    el.text = after.text
    fx.text = after.text.slice(0, Math.round(lerp(before.text.length, after.text.length, clamp01(p))))
  }
  return { el, fx }
}

export function createReplay(base, done, opts) {
  const steps = buildSteps(base, done, opts)
  const docs = [base]
  for (const s of steps) docs.push(applyChanges(docs[docs.length - 1], s.changes, 'after'))
  const starts = []
  let t = LEAD_MS
  for (const s of steps) {
    starts.push(t)
    t += s.dur + GAP_MS
  }
  const end = t
  const total = end + HOLD_MS

  /** Document and per-element effects at time t (ms). */
  function frame(time) {
    if (!steps.length || time >= end) return { doc: docs[docs.length - 1], fx: null, step: steps.length }
    if (time < LEAD_MS) return { doc: base, fx: null, step: 0 }
    let lo = 0, hi = steps.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= time) lo = mid
      else hi = mid - 1
    }
    const s = steps[lo]
    const p = (time - starts[lo]) / s.dur
    if (p >= 1) return { doc: docs[lo + 1], fx: null, step: lo + 1 }
    const doc = { ...docs[lo] }
    const fx = new Map()
    for (const [id, before, after] of s.changes) {
      const r = tween(before, after, clamp01(p))
      doc[id] = r.el
      if (Object.keys(r.fx).length) fx.set(id, r.fx)
    }
    return { doc, fx, step: lo }
  }

  return { steps, docs, total, end, frame, finalDoc: docs[docs.length - 1], startOf: (i) => starts[i] ?? end }
}
