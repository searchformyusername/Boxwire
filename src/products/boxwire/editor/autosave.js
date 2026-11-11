// Autosave policy, independent of React and storage so its races are testable.
//
// Every write persists a coherent snapshot: the history plus the document as
// of the last commit, so a timer that fires mid-drag or mid-typing can never
// store a document that disagrees with its history. Writes are serialised;
// discard() stops queued writes (deleting a board must not be undone by a
// save that was already waiting).

export function createAutosaver({ store, write, onStatus = () => {}, delay = 500, dirty: startDirty = false }) {
  let dirty = startDirty
  let discarded = false
  let timer = 0
  let writing = Promise.resolve(true)
  let lastVersion = store.version
  let requestVersion = 0 // includes rename/practice saves that do not change store.version

  const settled = (version) => !dirty && !store.inTransaction && requestVersion === version

  function flush() {
    clearTimeout(timer)
    timer = 0
    if (!dirty || discarded) return writing
    dirty = false
    writing = writing.then(() => {
      if (discarded) return true
      // anything still in an open transaction isn't committed yet; the commit schedules another save
      dirty = store.inTransaction // this write covers all work already scheduled, including an older failure
      // Only this completed snapshot is acknowledged; a newer queued edit is still dirty.
      const snapshotVersion = requestVersion
      const snapshot = { history: store.history, doc: store.committedDoc }
      return Promise.resolve().then(() => write(snapshot)).then(
        () => {
          if (!discarded) onStatus(settled(snapshotVersion) ? { status: 'saved' } : { status: 'dirty' })
          return true
        },
        (err) => {
          dirty = true
          if (!discarded) onStatus({ status: 'error', message: err?.message || 'Could not save to this device.' })
          return false
        },
      )
    })
    return writing
  }

  function schedule() {
    if (discarded) return
    requestVersion++
    dirty = true
    clearTimeout(timer)
    onStatus({ status: 'dirty' })
    timer = setTimeout(flush, delay)
  }

  let uncommitted = false // a gesture or label edit is changing the doc but hasn't committed yet
  const unsub = store.subscribe(() => {
    if (store.version === lastVersion || discarded) return
    if (store.inTransaction) {
      // be truthful immediately, but only write at the transaction boundary
      if (!uncommitted) onStatus({ status: 'dirty' })
      uncommitted = true
      return
    }
    uncommitted = false
    lastVersion = store.version
    schedule()
  })

  return {
    flush,
    schedule,
    /** Stop saving for good (the board is being deleted); resolves once in-flight writes finish. */
    discard() {
      discarded = true
      clearTimeout(timer)
      return writing
    },
    /** Re-enable after a failed delete. */
    restore() {
      discarded = false
    },
    dispose() {
      unsub()
      return flush()
    },
  }
}
