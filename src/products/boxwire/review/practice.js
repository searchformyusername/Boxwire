// Timed practice sessions. A session is a few wall-clock marks stored with the
// board's metadata: when it started and when each phase began. Everything else
// (what was built in which phase, how long each took) is read from the build
// history, whose transactions already carry timestamps. Reloading resumes the
// clock exactly, because the marks are absolute times.

export const PRACTICE_VERSION = 1

export const PHASES = [
  { id: 'requirements', title: 'Requirements', minutes: 5, goal: 'Pin down functional and non-functional requirements in a note.' },
  { id: 'estimates', title: 'Estimates', minutes: 5, goal: 'Declare load on the client (users, rates, payload) and see QPS, storage and bandwidth derive.' },
  { id: 'hld', title: 'High-level design', minutes: 15, goal: 'Draw the request path end to end: clients, edge, services, data.' },
  { id: 'deep-dive', title: 'Deep dive', minutes: 10, goal: 'Declare replicas, ratings and caches; resolve review findings on the critical path.' },
  { id: 'trade-offs', title: 'Trade-offs', minutes: 5, goal: 'Cross out rejected options (X) and note why.' },
]
export const PHASE_IDS = PHASES.map((p) => p.id)
/** A phase still counts as on time up to this much past its budget. */
export const GRACE = 1.2

/** A new session on `problem` starting at `now`. */
export const startPractice = (problem, now = Date.now()) => ({ version: PRACTICE_VERSION, problem, startedAt: now, marks: [{ phase: PHASE_IDS[0], t: now }], endedAt: null })

/** Move to the next phase, or end the session after the last one. */
export function advance(s, now = Date.now()) {
  if (s.endedAt) return s
  const next = PHASE_IDS[s.marks.length]
  return next ? { ...s, marks: [...s.marks, { phase: next, t: now }] } : { ...s, endedAt: now }
}

export const finish = (s, now = Date.now()) => (s.endedAt ? s : { ...s, endedAt: now })

/** Validates a stored session (it comes back from IndexedDB or an imported file); null if unusable. */
export function readPractice(s) {
  if (!s || typeof s !== 'object' || s.version !== PRACTICE_VERSION || typeof s.problem !== 'string' || !Number.isFinite(s.startedAt)) return null
  if (!Array.isArray(s.marks) || !s.marks.length || s.marks.length > PHASES.length) return null
  let last = -Infinity
  for (let i = 0; i < s.marks.length; i++) {
    const m = s.marks[i]
    if (m?.phase !== PHASE_IDS[i] || !Number.isFinite(m.t) || m.t < last) return null
    last = m.t
  }
  if (s.endedAt !== null && !(Number.isFinite(s.endedAt) && s.endedAt >= last)) return null
  return { version: s.version, problem: s.problem, startedAt: s.startedAt, marks: s.marks.map((m) => ({ phase: m.phase, t: m.t })), endedAt: s.endedAt }
}

/**
 * Per-phase timing at `now`: [{ id, title, budget, start, end, elapsed, status }]
 * where status is 'done' | 'current' | 'upcoming' and times are ms.
 */
export function timing(s, now = Date.now()) {
  return PHASES.map((p, i) => {
    const mark = s.marks[i]
    const budget = p.minutes * 60000
    if (!mark) return { ...p, budget, start: null, end: null, elapsed: 0, status: 'upcoming' }
    const end = s.marks[i + 1]?.t ?? s.endedAt ?? null
    return { ...p, budget, start: mark.t, end, elapsed: (end ?? now) - mark.t, status: end === null ? 'current' : 'done' }
  })
}

/** Index of the phase that was running at wall time t (−1 before the start, PHASES.length after the end). */
export function phaseAt(s, t) {
  if (t < s.marks[0].t) return -1
  if (s.endedAt !== null && t >= s.endedAt) return PHASES.length
  let i = 0
  while (i + 1 < s.marks.length && s.marks[i + 1].t <= t) i++
  return i
}

/** How many committed steps fall into each phase: the activity profile of the session. */
export function activity(s, done) {
  const counts = PHASES.map(() => 0)
  for (const txn of done) {
    if (!txn.changes.length) continue // a source-only step (connector ids written down) is not board work
    const i = phaseAt(s, txn.t)
    if (i >= 0 && i < PHASES.length) counts[i]++
  }
  return counts
}

export const clock = (ms) => {
  const neg = ms < 0, a = Math.abs(Math.round(ms / 1000))
  return `${neg ? '−' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`
}
