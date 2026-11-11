// A board opened from a source file keeps that file as the source of truth.
// Every committed canvas transaction becomes minimal source edits (sync.js →
// edit.js); undo and redo restore the exact text recorded for that
// transaction, so both representations move together. Text edited by hand is
// parsed and, when it compiles, applied to the board as one transaction; when
// it doesn't, the last good model stays on the canvas and the source is
// marked stale. Nothing here regenerates the file.

import { parseSource } from './cst.js'
import { indexSource } from './index.js'
import { applySourceOps } from './edit.js'
import { layoutInputsChanged, naturalPositions, opsForChanges, reflowPins } from './sync.js'
import { compileDiagram } from '../author/compile.js'

const strip = (el) => {
  if (!el) return null
  const { z: _z, ...rest } = el
  return rest
}
const sameEl = (a, b) => JSON.stringify(strip(a)) === JSON.stringify(strip(b))

/**
 * createSourceSession({ store, text, measure, onChange }) for a board whose history
 * was compiled from `text`. Returns { text, stale, unsupported, applyText(next), watch(fn), dispose() };
 * onChange(session) runs whenever the text or its status changes.
 */
export function createSourceSession({ store, text, measure, onChange: notify = () => {} }) {
  const watchers = new Set()
  const onChange = (s) => {
    notify(s)
    for (const w of watchers) w(s)
  }
  let state = load(text)
  if (!state.value) throw new Error('The source does not parse.')
  let stale = null // { message, line, col } while hand-edited text doesn't parse or compile
  let unsupported = [] // canvas changes the format can't express (they stay on the board only)
  let pinned = [] // generated edge ids the last canvas edit wrote down so they stay stable (identity, not layout)
  let reflowed = [] // nodes the last canvas edit pinned because auto layout would otherwise have moved them
  const snapshots = new WeakMap() // history txn → { before, after } source text
  let done = store.history.done
  let undone = store.history.undone
  let applying = false

  function load(t) {
    const p = parseSource(t)
    if (!p.value) return { text: t, value: null, errors: p.errors }
    return { text: t, value: p.value, cst: p.cst, index: indexSource(p.cst, p.value), natural: null }
  }
  const natural = () => (state.natural ??= naturalPositions(state.value, { measure }))
  const set = (t) => {
    state = load(t)
  }

  /** Source text after writing one transaction's element changes. */
  function write(changes) {
    // natural positions cost a compile, so they are worked out only if a moved node needs them
    const { ops, unsupported: skipped } = opsForChanges(changes, { value: state.value, index: state.index, natural: { get: (id) => natural().get(id) }, measure })
    unsupported = [...unsupported.filter((u) => !skipped.some((s) => s.id === u.id)), ...skipped].slice(-50)
    pinned = []
    reflowed = []
    if (!ops.length) return state.text
    const r = applySourceOps(state.text, ops)
    if (r.error) {
      unsupported = [...unsupported, { id: '(transaction)', reason: r.error }].slice(-50)
      return state.text
    }
    pinned = r.pinned
    reflowed = []
    // In auto layout an edit can move nodes nobody touched: an insert or removal, a reconnect, a retarget, a
    // reversal, or a node that grew. After any edit that changes what the layout reads, the written source is
    // compiled and each node that would land elsewhere is pinned where the board has it. A label that keeps its
    // node's size, a style, a declaration or a drag changes nothing the layout reads.
    if (state.value?.layout !== 'manual' && layoutInputsChanged(changes)) {
      const value = parseSource(r.text).value
      const extra = reflowPins(value, store.doc, { measure })
      if (extra.length) {
        const p = applySourceOps(r.text, extra)
        if (!p.error) {
          reflowed = extra.map((o) => o.id)
          return p.text
        }
        unsupported = [...unsupported, { id: '(layout)', reason: p.error }].slice(-50)
      }
    }
    return r.text
  }

  const unsub = store.subscribe(() => {
    if (store.inTransaction) return
    const h = store.history
    if (h.done === done && h.undone === undone) return
    const prevDone = done, prevUndone = undone
    done = h.done
    undone = h.undone
    if (applying) return
    const top = h.done[h.done.length - 1]
    const grew = h.done.length === prevDone.length + 1 && prevDone.every((t, i) => h.done[i] === t)
    if (grew && top === prevUndone[prevUndone.length - 1]) {
      // redo: the text recorded after that transaction, else write it again
      const snap = snapshots.get(top)
      set(snap ? snap.after : write(top.changes))
    } else if (grew) {
      // a new transaction
      const before = state.text
      set(write(top.changes))
      snapshots.set(top, { before, after: state.text })
    } else if (h.done.length === prevDone.length - 1 && h.undone[h.undone.length - 1] === prevDone[prevDone.length - 1]) {
      // undo: restore the text recorded before that transaction, else write its inverse
      const txn = prevDone[prevDone.length - 1]
      const snap = snapshots.get(txn)
      set(snap ? snap.before : write(txn.changes.map(([id, b, a]) => [id, a, b])))
    } else if (h.done.length === prevDone.length && top && prevDone.length && prevDone[prevDone.length - 1] !== top) {
      // a coalesced edit replaced the last transaction: rewrite it from the text before the first part
      const snap = snapshots.get(prevDone[prevDone.length - 1])
      if (snap) set(snap.before)
      const before = state.text
      set(write(top.changes))
      snapshots.set(top, { before, after: state.text })
    } else if (top) {
      // history jumped (several steps at once): fall back to the latest transaction only
      set(write(top.changes))
    }
    onChange(api)
  })

  /** Apply hand-edited source text. Returns { ok, errors }. */
  function applyText(next) {
    const parsed = parseSource(next)
    if (!parsed.value) {
      const e = parsed.errors[0]
      stale = { message: e.message, line: e.line, col: e.col }
      onChange(api)
      return { ok: false, errors: parsed.errors }
    }
    const r = compileDiagram(parsed.value, { measure })
    if (r.errors.length) {
      stale = { message: `${r.errors[0].path ? `${r.errors[0].path}: ` : ''}${r.errors[0].message}`, line: null, col: null }
      onChange(api)
      return { ok: false, errors: r.errors }
    }
    const cur = store.committedDoc
    const ids = new Set([...Object.keys(cur), ...Object.keys(r.doc)])
    const entries = [...ids].filter((id) => !sameEl(cur[id], r.doc[id])).map((id) => [id, r.doc[id] ? { ...r.doc[id], z: cur[id]?.z ?? r.doc[id].z } : null])
    const before = state.text
    stale = null
    set(next)
    if (entries.length) {
      applying = true
      try {
        store.apply(entries, 'edit source')
      } finally {
        applying = false
      }
      const top = store.history.done[store.history.done.length - 1]
      snapshots.set(top, { before, after: next })
      done = store.history.done
      undone = store.history.undone
    }
    onChange(api)
    return { ok: true, errors: [], changed: entries.length }
  }

  /**
   * Write the generated id of every id-less connector into the source, so later diffs identify connectors by
   * id rather than by their ends. Identity only: the board doesn't change, but it is one undoable step.
   * Returns { ok, pinned: [ids] }.
   */
  function pinAll() {
    if (!state.value) return { ok: false, pinned: [] }
    const ids = state.index.ids('edge').filter((id) => state.value.edges[state.index.find('edge', id).index]?.id === undefined)
    if (!ids.length) return { ok: true, pinned: [] }
    const r = applySourceOps(state.text, ids.map((id) => ({ op: 'pin', entity: 'edge', id })))
    if (r.error) return { ok: false, pinned: [], error: r.error }
    // one undo step: a history entry that changes no element, with the text before and after recorded for it
    const before = state.text
    applying = true
    try {
      store.mark('write connector ids')
    } finally {
      applying = false
    }
    const top = store.history.done[store.history.done.length - 1]
    snapshots.set(top, { before, after: r.text })
    done = store.history.done
    undone = store.history.undone
    set(r.text)
    pinned = r.pinned
    onChange(api)
    return { ok: true, pinned: r.pinned }
  }

  const api = {
    pinAll,
    get text() { return state.text },
    get stale() { return stale },
    get unsupported() { return unsupported },
    /** Generated edge ids the last canvas edit wrote into the source so they keep their identity. */
    get pinned() { return pinned },
    /** Nodes the last canvas edit pinned in `positions` because auto layout would have moved them. */
    get reflowed() { return reflowed },
    applyText,
    /** Subscribe to text/status changes; returns the unsubscribe function. */
    watch(fn) {
      watchers.add(fn)
      return () => watchers.delete(fn)
    },
    dispose: unsub,
  }
  return api
}
