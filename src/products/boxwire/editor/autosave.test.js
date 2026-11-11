import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAutosaver } from './autosave.js'
import { createEditor } from './editor.js'
import { validateBoard } from '../core/validate.js'
import { createDocStore } from '../core/history.js'

const measure = (s) => s.length * 8
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}
const coherent = ({ history, doc }) => validateBoard({ ...JSON.parse(JSON.stringify(history)), doc: JSON.parse(JSON.stringify(doc)) }).warning === null

describe('autosave', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a timer that fires while a label is being typed stores a coherent snapshot (regression)', async () => {
    const ed = createEditor({ measure })
    const writes = []
    const statuses = []
    createAutosaver({ store: ed.store, write: (snap) => writes.push(snap), onStatus: (s) => statuses.push(s.status), delay: 500 })
    ed.addNode('rect', { x: 0, y: 0 }) // schedules a save, then opens label editing
    ed.setEditText('Typing a label')
    await vi.advanceTimersByTimeAsync(600) // timer fires mid-typing
    expect(writes).toHaveLength(1)
    expect(coherent(writes[0])).toBe(true)
    expect(Object.values(writes[0].doc)[0].text).toBe('') // the uncommitted text is not persisted yet
    expect(statuses.at(-1)).toBe('dirty') // and the badge doesn't claim it is
    ed.commitEdit()
    await vi.advanceTimersByTimeAsync(600)
    expect(writes).toHaveLength(2)
    expect(coherent(writes[1])).toBe(true)
    expect(Object.values(writes[1].doc)[0].text).toBe('Typing a label')
    expect(statuses.at(-1)).toBe('saved')
  })

  it('editing a label on an already-saved board shows unsaved work at once, without writing per keystroke (regression)', async () => {
    const ed = createEditor({ measure })
    const n = ed.addNode('rect', { x: 0, y: 0 }, { text: 'Saved label' }, { edit: false })
    const statuses = []
    const write = vi.fn()
    const saver = createAutosaver({ store: ed.store, write, onStatus: (s) => statuses.push(s.status) })
    ed.nudge(1, 0)
    await saver.flush()
    expect(statuses.at(-1)).toBe('saved')
    ed.startEdit(n.id)
    ed.setEditText('Unsaved edited label')
    expect(statuses.at(-1)).toBe('dirty')
    ed.setEditText('Unsaved edited label, still typing')
    await vi.advanceTimersByTimeAsync(2000)
    expect(write).toHaveBeenCalledTimes(1) // nothing written mid-edit
    ed.commitEdit()
    await vi.advanceTimersByTimeAsync(600)
    expect(write).toHaveBeenCalledTimes(2)
    expect(Object.values(write.mock.calls[1][0].doc)[0].text).toBe('Unsaved edited label, still typing')
    expect(statuses.at(-1)).toBe('saved')
  })

  it('a drag on an already-saved board shows unsaved work at once', async () => {
    const store = createDocStore()
    const statuses = []
    const saver = createAutosaver({ store, write: () => {}, onStatus: (s) => statuses.push(s.status) })
    store.set('a', { id: 'a', x: 0 })
    await saver.flush()
    expect(statuses.at(-1)).toBe('saved')
    store.begin('move')
    store.apply([['a', { id: 'a', x: 50 }]])
    expect(statuses.at(-1)).toBe('dirty')
    store.commit()
    await vi.advanceTimersByTimeAsync(600)
    expect(statuses.at(-1)).toBe('saved')
  })

  it('a timer that fires mid-drag stores the pre-drag state, then saves after commit or cancel', async () => {
    const store = createDocStore()
    const writes = []
    createAutosaver({ store, write: (snap) => writes.push(snap), delay: 500 })
    store.set('a', { id: 'a', type: 'node', shape: 'rect', x: 0, y: 0, w: 10, h: 10, z: 1, text: '', color: 'ink', stroke: 2, size: 16, font: 'sans' })
    store.begin('move')
    store.apply([['a', { ...store.doc.a, x: 300 }]])
    await vi.advanceTimersByTimeAsync(600)
    expect(writes.at(-1).doc.a.x).toBe(0)
    expect(coherent(writes.at(-1))).toBe(true)
    store.cancel()
    await vi.advanceTimersByTimeAsync(600)
    expect(writes.at(-1).doc.a.x).toBe(0)
    expect(coherent(writes.at(-1))).toBe(true)
  })

  it('an explicit flush mid-transaction is coherent and resolves true', async () => {
    const ed = createEditor({ measure })
    const writes = []
    const saver = createAutosaver({ store: ed.store, write: (snap) => writes.push(snap) })
    ed.addNode('rect', { x: 0, y: 0 })
    ed.setEditText('half-typed')
    expect(await saver.flush()).toBe(true)
    expect(coherent(writes.at(-1))).toBe(true)
  })

  it('discard stops a save that was already queued behind a slow write (regression)', async () => {
    const store = createDocStore()
    const slow = deferred()
    const write = vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue(undefined)
    const saver = createAutosaver({ store, write, delay: 500 })
    store.set('a', { id: 'a' })
    const first = saver.flush()
    await vi.advanceTimersByTimeAsync(0) // write #1 is now in flight
    expect(write).toHaveBeenCalledTimes(1)
    store.set('b', { id: 'b' })
    saver.flush() // write #2 queued behind #1
    const drained = saver.discard() // the board is being deleted
    slow.resolve()
    await first
    await drained
    await vi.advanceTimersByTimeAsync(1000)
    expect(write).toHaveBeenCalledTimes(1)
    store.set('c', { id: 'c' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(write).toHaveBeenCalledTimes(1) // and nothing later revives it
  })

  it('reports failure, keeps the work dirty, and succeeds on retry', async () => {
    const store = createDocStore()
    const statuses = []
    const write = vi.fn().mockRejectedValueOnce(new Error('QuotaExceededError')).mockResolvedValue(undefined)
    const saver = createAutosaver({ store, write, onStatus: (s) => statuses.push(s) })
    store.set('a', { id: 'a' })
    expect(await saver.flush()).toBe(false)
    expect(statuses.at(-1)).toEqual({ status: 'error', message: 'QuotaExceededError' })
    expect(await saver.flush()).toBe(true) // still dirty, so the retry writes
    expect(write).toHaveBeenCalledTimes(2)
    expect(statuses.at(-1).status).toBe('saved')
  })
})

describe('autosave acknowledgement belongs to the completed snapshot', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  for (const failNewer of [false, true]) it(`does not acknowledge queued newer content when the older write completes (newer fails=${failNewer})`, async () => {
    const store = createDocStore()
    const older = deferred(), newer = deferred(), states = [], snapshots = []
    const write = vi.fn((snapshot) => {
      snapshots.push(structuredClone(snapshot))
      return snapshots.length === 1 ? older.promise : newer.promise
    })
    const saver = createAutosaver({ store, write, onStatus: (s) => states.push(s), delay: 500 })
    store.set('a', { id: 'a', text: 'First' })
    const first = saver.flush()
    await vi.advanceTimersByTimeAsync(0)
    store.set('b', { id: 'b', text: 'Second' })
    const second = saver.flush()
    older.resolve()
    await first
    await vi.advanceTimersByTimeAsync(0)
    expect(Object.keys(snapshots[0].doc)).toEqual(['a'])
    expect(Object.keys(snapshots[1].doc)).toEqual(['a', 'b'])
    const afterOlder = states.at(-1).status
    if (failNewer) newer.reject(new Error('Storage quota reached'))
    else newer.resolve()
    expect(await second).toBe(!failNewer)
    expect(states.at(-1).status).toBe(failNewer ? 'error' : 'saved')
    await saver.dispose()
    // Check after both promises have settled so a failing test leaves no pending write.
    expect(afterOlder).toBe('dirty')
  })

  it('a synchronous storage refusal reports an error and permits a successful retry', async () => {
    const store = createDocStore(), states = []
    let refuse = true
    const write = vi.fn(() => { if (refuse) throw new Error('Storage unavailable') })
    const saver = createAutosaver({ store, write, onStatus: (s) => states.push(s) })
    store.set('a', { id: 'a', text: 'Retained work' })
    const outcome = await saver.flush().then((v) => ({ value: v }), (error) => ({ error: error.message }))
    expect(outcome).toEqual({ value: false })
    expect(states.at(-1)).toEqual({ status: 'error', message: 'Storage unavailable' })
    refuse = false
    expect(await saver.flush()).toBe(true)
    expect(write).toHaveBeenCalledTimes(2)
    expect(states.at(-1).status).toBe('saved')
    await saver.dispose()
  })
})

describe('autosave requests include metadata outside the document store', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a completed older metadata write cannot acknowledge a newer rename with the same document version', async () => {
    const store = createDocStore(), older = deferred(), newer = deferred(), states = [], names = []
    let name = 'First board name'
    const saver = createAutosaver({ store, onStatus: (s) => states.push(s), write: () => {
      names.push(name)
      return names.length === 1 ? older.promise : newer.promise
    } })
    const version = store.version
    saver.schedule()
    const first = saver.flush()
    await vi.advanceTimersByTimeAsync(0)
    name = 'Newer board name'
    saver.schedule()
    const second = saver.flush()
    older.resolve()
    await first
    await vi.advanceTimersByTimeAsync(0)
    const afterOlder = states.at(-1).status
    newer.resolve()
    expect(await second).toBe(true)
    expect(states.at(-1).status).toBe('saved')
    expect(names).toEqual(['First board name', 'Newer board name'])
    expect(store.version).toBe(version)
    await saver.dispose()
    expect(afterOlder).toBe('dirty')
  })

  it('a newer queued snapshot that succeeds clears an older failed write without another edit', async () => {
    const store = createDocStore(), older = deferred(), newer = deferred(), states = []
    const write = vi.fn().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const saver = createAutosaver({ store, write, onStatus: (s) => states.push(s) })
    store.set('a', { id: 'a' })
    const first = saver.flush()
    await vi.advanceTimersByTimeAsync(0)
    store.set('b', { id: 'b' })
    const second = saver.flush()
    older.reject(new Error('Older write failed'))
    expect(await first).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    newer.resolve()
    expect(await second).toBe(true)
    const afterNewer = states.at(-1).status
    saver.discard()
    await saver.dispose()
    expect(afterNewer).toBe('saved')
  })
})
