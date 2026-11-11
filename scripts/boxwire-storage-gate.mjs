// Real IndexedDB atomicity controls. Requires Vite; uses a disposable Chrome profile.
// node scripts/boxwire-storage-gate.mjs [baseUrl] [report.json]
import { writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { launch, openPage } from './lib/cdp.mjs'

async function storageChecks() {
  const { saveBoard, loadBoard, listBoards, deleteBoard } = await import('/src/products/boxwire/core/persist.js')
  const { createEditor } = await import('/src/products/boxwire/editor/editor.js')
  const { createAutosaver } = await import('/src/products/boxwire/editor/autosave.js')
  const { fold } = await import('/src/products/boxwire/core/history.js')
  const results = []
  const check = (name, ok, detail) => results.push({ name, ok, detail })
  const editor = createEditor({ measure: (s) => s.length * 8 })
  editor.addNode('rect', { x: 0, y: 0 }, { text: 'Original' }, { edit: false })
  const history = editor.store.history
  const doc = editor.store.committedDoc
  const meta = { id: 'storage-existing', name: 'Original', createdAt: 1, updatedAt: 1 }
  const raw = async (id) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('boxwire', 1)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(['meta', 'data'], 'readonly')
        const m = tx.objectStore('meta').get(id), d = tx.objectStore('data').get(id)
        tx.oncomplete = () => resolve({ meta: m.result ?? null, data: d.result ?? null })
        tx.onabort = () => reject(tx.error)
      })
    } finally { db.close() }
  }
  const failure = async (fn) => {
    try { await fn(); return null } catch (err) { return err.name }
  }
  try {
    await saveBoard(meta, history, doc)
    const loaded = await loadBoard(meta.id)
    check('healthy save and validated reload', loaded.meta.name === meta.name && loaded.warning === null && JSON.stringify(fold(loaded.board.base, loaded.board.done)) === JSON.stringify(doc))
    const before = await raw(meta.id)

    // Native structured cloning rejects the SECOND put, after the metadata put was queued.
    // This is a deliberately invalid in-memory snapshot, not a claim about normal editor output.
    const uncloneable = { ...doc, invalid: () => {} }
    const error = await failure(() => saveBoard({ ...meta, name: 'Must not persist' }, history, uncloneable))
    const after = await raw(meta.id)
    check('synchronous failure preserves both existing rows', error === 'DataCloneError' && JSON.stringify(after) === JSON.stringify(before), { error, beforeName: before.meta.name, afterName: after.meta?.name })

    const fresh = { ...meta, id: 'storage-new', name: 'Must not appear' }
    const newError = await failure(() => saveBoard(fresh, history, uncloneable))
    const orphan = await raw(fresh.id)
    check('synchronous failure leaves no orphan board', newError === 'DataCloneError' && orphan.meta === null && orphan.data === null, { error: newError, hasMeta: !!orphan.meta, hasData: !!orphan.data })
    check('failed new board stays out of board list', !(await listBoards()).some((b) => b.id === fresh.id))

    // Keep a native asynchronous transaction-abort control: both real put requests are queued.
    await saveBoard(meta, history, doc)
    const beforeAbort = await raw(meta.id)
    const originalPut = IDBObjectStore.prototype.put
    let aborted = false, abortError
    try {
      IDBObjectStore.prototype.put = function (...args) {
        const req = originalPut.apply(this, args)
        if (this.name === 'data') { aborted = true; this.transaction.abort() }
        return req
      }
      abortError = await failure(() => saveBoard({ ...meta, name: 'Aborted' }, history, doc))
    } finally { IDBObjectStore.prototype.put = originalPut }
    check('asynchronous abort rolls back both rows', aborted && abortError !== null && JSON.stringify(await raw(meta.id)) === JSON.stringify(beforeAbort), { error: abortError })

    const beforeAutosave = await raw(meta.id)
    const statuses = []
    let broken = true
    const saver = createAutosaver({
      store: editor.store, dirty: true,
      write: ({ history: h, doc: d }) => saveBoard(meta, h, broken ? uncloneable : d),
      onStatus: (s) => statuses.push(s.status),
    })
    const failed = await saver.flush()
    check('autosave reports failure and preserves stored board', failed === false && statuses.at(-1) === 'error' && JSON.stringify(await raw(meta.id)) === JSON.stringify(beforeAutosave))
    broken = false
    const retried = await saver.flush()
    check('autosave retries without another edit', retried === true && statuses.at(-1) === 'saved' && (await loadBoard(meta.id)).warning === null)
    await saver.dispose()

    await saveBoard({ ...fresh, name: 'Recovered' }, history, doc)
    check('failed new board can be saved and reopened on retry', (await loadBoard(fresh.id)).meta.name === 'Recovered')
    await deleteBoard(fresh.id)
    const deleted = await raw(fresh.id)
    check('delete removes both rows', deleted.meta === null && deleted.data === null)
  } finally {
    editor.dispose()
    await deleteBoard(meta.id)
    await deleteBoard('storage-new')
  }
  return results
}

const base = process.argv[2] || 'http://127.0.0.1:5251'
const chrome = await launch({ port: 9356 })
let page
try {
  page = await openPage(chrome.port, base + '/')
  const checks = await page.eval(`(${storageChecks.toString()})()`)
  const report = {
    date: new Date().toISOString(),
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    persistSha256: createHash('sha256').update(readFileSync(new URL('../src/products/boxwire/core/persist.js', import.meta.url))).digest('hex'),
    chrome: chrome.version.Browser, base, checks, ok: checks.every((c) => c.ok),
  }
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.ok ? 0 : 1
} finally {
  page?.close()
  chrome.close()
}
