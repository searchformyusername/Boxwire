// IndexedDB persistence: 'meta' holds the board list, 'data' the full board
// (document + history) so listing boards never loads every history.

import { validateBoard } from './validate.js'

const DB_NAME = 'boxwire'
const LAST_KEY = 'boxwire:last-board'
let dbPromise = null

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('Storage is unavailable in this browser.'))
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('meta', { keyPath: 'id' })
      req.result.createObjectStore('data', { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Could not open storage.'))
    req.onblocked = () => reject(new Error('Storage is blocked by another tab.'))
  }).catch((err) => {
    dbPromise = null
    throw err
  })
  return dbPromise
}

/** Runs fn inside one transaction; resolves with the result(s) of the request(s) fn returns. */
function tx(stores, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode)
    let reqs, setupError
    t.oncomplete = () => resolve(Array.isArray(reqs) ? reqs.map((r) => r.result) : reqs?.result)
    t.onerror = () => reject(setupError ?? t.error ?? new Error('Storage write failed.'))
    t.onabort = () => reject(setupError ?? t.error ?? new Error('Storage write was aborted (disk full?).'))
    try {
      reqs = fn(t)
    } catch (err) {
      // A synchronous put() failure (e.g. structured cloning) does not abort
      // IndexedDB automatically. Roll back any earlier requests as well, and
      // report the original error once the transaction has aborted.
      setupError = err
      t.abort()
    }
  }))
}

export async function listBoards() {
  const rows = await tx(['meta'], 'readonly', (t) => t.objectStore('meta').getAll())
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Loads and validates a board; returns { meta, board, warning } or throws with a readable message. */
export async function loadBoard(id) {
  const [meta, data] = await tx(['meta', 'data'], 'readonly', (t) => [t.objectStore('meta').get(id), t.objectStore('data').get(id)])
  if (!meta || !data) throw new Error('Board not found.')
  const res = validateBoard(data)
  if (res.error) throw new Error(res.error)
  return { meta, board: res.board, warning: res.warning }
}

export function saveBoard(meta, { base, done, undone, checkpoint }, doc) {
  const row = { id: meta.id, base, done, undone, checkpoint, doc }
  const m = { ...meta, updatedAt: Date.now(), count: Object.keys(doc).length }
  return tx(['meta', 'data'], 'readwrite', (t) => {
    t.objectStore('meta').put(m)
    t.objectStore('data').put(row)
  }).then(() => m)
}

export const deleteBoard = (id) => tx(['meta', 'data'], 'readwrite', (t) => {
  t.objectStore('meta').delete(id)
  t.objectStore('data').delete(id)
})

export function rememberBoard(id) {
  try {
    localStorage.setItem(LAST_KEY, id)
  } catch {
    /* private mode: not fatal */
  }
}

export function lastBoardId() {
  try {
    return localStorage.getItem(LAST_KEY)
  } catch {
    return null
  }
}
