// Document store with transactional history.
//
// The document is a plain map { [id]: element }. It only ever changes through
// transactions, each a list of [id, before, after] changes (null = absent).
// history = { base, done, undone }: the live doc always equals fold(base, done),
// which is exactly what the timelapse replays.

const MERGE_WINDOW_MS = 1200
const MAX_DONE = 20000

const same = (a, b) => a === b || (a != null && b != null && JSON.stringify(a) === JSON.stringify(b))

export function applyChanges(doc, changes, side) {
  const next = { ...doc }
  const list = side === 'before' ? [...changes].reverse() : changes
  for (const [id, before, after] of list) {
    const v = side === 'before' ? before : after
    if (v) next[id] = v
    else delete next[id]
  }
  return next
}

/** fold(base, txns): the document after applying every transaction in order. One copy of `base`, then mutated in place (linear, not quadratic, in history length). */
export function fold(base, txns) {
  if (!txns.length) return base
  const doc = { ...base }
  for (const t of txns) {
    for (const [id, , after] of t.changes) {
      if (after) doc[id] = after
      else delete doc[id]
    }
  }
  return doc
}

export function createDocStore({ base = {}, done = [], undone = [], checkpoint = false, now = Date.now } = {}) {
  let doc = fold(base, done)
  let history = { base, done, undone, checkpoint }
  let open = null // { label, merge, start: doc at begin, touched: Map<id, before> }
  let mergeable = null // last committed txn; undo/redo clears it so merges never cross those boundaries
  let version = 0
  const listeners = new Set()

  const emit = () => {
    version++
    for (const l of listeners) l()
  }

  function write(entries) {
    const next = { ...doc }
    for (const [id, el] of entries) {
      if (open && !open.touched.has(id)) open.touched.set(id, doc[id] ?? null)
      if (el) next[id] = el
      else delete next[id]
    }
    doc = next
  }

  function begin(label, merge = null) {
    if (open) commit()
    open = { label, merge, start: doc, touched: new Map() }
  }

  function commit() {
    if (!open) return null
    const { label, merge, touched } = open
    open = null
    const changes = []
    for (const [id, before] of touched) {
      const after = doc[id] ?? null
      if (!same(before, after)) changes.push([id, before, after])
    }
    if (!changes.length) {
      emit()
      return null
    }
    const t = now()
    let done = history.done
    const top = done[done.length - 1]
    if (merge && top && top === mergeable && top.merge === merge && t - top.t < MERGE_WINDOW_MS) {
      done = [...done.slice(0, -1), mergeTxn(top, changes, t)].filter((x) => x.changes.length)
    } else {
      done = [...done, { label, merge, t, changes }]
    }
    mergeable = done[done.length - 1] ?? null
    let { base } = history
    let checkpoint = history.checkpoint
    while (done.length > MAX_DONE) {
      base = applyChanges(base, done[0].changes, 'after')
      done = done.slice(1)
      checkpoint = true
    }
    history = { base, done, undone: [], checkpoint }
    emit()
    return label
  }

  function cancel() {
    if (!open) return
    const { touched } = open
    open = null
    write([...touched].map(([id, before]) => [id, before]))
    emit()
  }

  /** Apply entries; inside an open transaction they accumulate, otherwise they commit at once. */
  function apply(entries, label = 'edit', merge = null) {
    if (open) {
      write(entries)
      emit()
      return
    }
    begin(label, merge)
    write(entries)
    commit()
  }

  /**
   * Record a step that changes no element: an edit that lives only in the board's source file (writing the
   * generated connector ids down). It undoes and redoes like any step; the replay and practice timing skip it,
   * since nothing on the board moves.
   */
  function mark(label) {
    if (open) commit()
    const t = now()
    const done = [...history.done, { label, merge: null, t, changes: [] }]
    mergeable = null
    history = { ...history, done, undone: [] }
    emit()
    return label
  }

  function undo() {
    if (open) commit()
    const txn = history.done[history.done.length - 1]
    if (!txn) return null
    doc = applyChanges(doc, txn.changes, 'before')
    mergeable = null
    history = { ...history, done: history.done.slice(0, -1), undone: [...history.undone, txn] }
    emit()
    return txn.label
  }

  function redo() {
    if (open) commit()
    const txn = history.undone[history.undone.length - 1]
    if (!txn) return null
    doc = applyChanges(doc, txn.changes, 'after')
    mergeable = null
    history = { ...history, done: [...history.done, txn], undone: history.undone.slice(0, -1) }
    emit()
    return txn.label
  }

  return {
    get doc() { return doc },
    /** The document as of the last commit — always consistent with `history`, even mid-gesture. */
    get committedDoc() { return open ? open.start : doc },
    get history() { return history },
    get version() { return version },
    get inTransaction() { return open !== null },
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    begin, commit, cancel, apply, undo, redo, mark,
    set: (id, el, label, merge) => apply([[id, el]], label, merge),
  }
}

function mergeTxn(top, changes, t) {
  const byId = new Map(top.changes.map((c) => [c[0], c]))
  for (const [id, before, after] of changes) {
    const prev = byId.get(id)
    byId.set(id, prev ? [id, prev[1], after] : [id, before, after])
  }
  return { ...top, t, changes: [...byId.values()].filter(([, b, a]) => !same(b, a)) }
}
