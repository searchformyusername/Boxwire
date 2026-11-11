// Opening a lazily loaded dialog must never hide the board. This mounts the REAL Boxwire (real TopBar,
// Toolbar, Inspector, ZoomBar, Boards menu) with react-dom/client on a minimal DOM (./testDom.js), opens the
// change review from the Boards menu while its chunk is still loading, and checks the chrome stays shown.
// On main 2d0c145 a single <Suspense> wrapped the whole board, so React hid all of it until the chunk arrived.
// Only the canvas (drawing needs a real 2D context) and the change review's chunk are replaced.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installDom, shown } from './testDom.js'

let releaseChangeReview = null
vi.mock('./Canvas.jsx', () => ({ default: () => <div className="bw-canvas" tabIndex={0} aria-label="Diagram canvas" /> }))

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
let dom, root, act

/** The change review's chunk, held until the test releases it (resolving, or failing as a network error would). */
function holdChangeReview(fail) {
  vi.doMock('./ChangeReview.jsx', () => new Promise((resolve, reject) => {
    releaseChangeReview = () => (fail ? reject(new Error('chunk failed')) : resolve({ default: ({ onClose }) => <div role="dialog" aria-label="Review an architecture change" className="bw-change"><button type="button" onClick={onClose}>Close</button></div> }))
  }))
}
let releaseEmptyState = null
/** The empty-state hint's chunk (an embedded, quiet panel), held the same way. */
function holdEmptyState(fail) {
  vi.doMock('./EmptyState.jsx', () => new Promise((resolve, reject) => {
    releaseEmptyState = () => (fail ? reject(new Error('chunk failed')) : resolve({ default: () => <p className="bw-empty">Start here</p> }))
  }))
}

async function mountBoard() {
  const React = await import('react')
  act = React.act
  const { createRoot } = await import('react-dom/client')
  const { default: Boxwire } = await import('../Boxwire.jsx')
  const { MemoryRouter } = await import('react-router-dom')
  const container = dom.document.createElement('div')
  dom.document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<MemoryRouter initialEntries={['/products/boxwire']}><Boxwire /></MemoryRouter>))
  // the board starts after storage answers (no IndexedDB here: it starts a fresh board) and the empty-state
  // chunk loads; wait for the chrome
  for (let i = 0; i < 100 && !(dom.document.querySelector('.bw-toolbar') && shown(dom.document.querySelector('.bw-toolbar'))); i++) await act(() => tick(10))
  return container
}
const q = (sel) => dom.document.querySelector(sel)
const clickText = async (sel, text) => {
  const el = dom.document.querySelectorAll(sel).find((e) => e.textContent.trim().startsWith(text) || e.getAttribute('aria-label') === text)
  if (!el) throw new Error(`no ${sel} "${text}"`)
  await act(async () => el.click())
}
const key = async (k, opts = {}) => {
  const target = dom.document.activeElement ?? dom.document.body
  let ev
  await act(async () => {
    ev = new Event('keydown', { bubbles: true, cancelable: true, key: k, code: k, ...opts })
    target.dispatchEvent(ev)
  })
  return ev
}
const openChangeReview = async () => {
  await clickText('.bw-topbar button', 'Boards')
  await clickText('[role=menuitem]', 'Review an architecture change')
  await act(() => tick(20))
}
const loadingDialog = () => q('[role=dialog][aria-label="Loading the change review"]')
const chrome = () => ['.bw-topbar', '.bw-toolbar', '.bw-zoombar'].map((s) => [s, !!q(s) && shown(q(s))])

describe('opening a lazy dialog keeps the board on screen (real Boxwire, main backport)', () => {
  beforeEach(() => {
    vi.resetModules()
    dom = installDom()
  })
  afterEach(async () => {
    await act?.(async () => root?.unmount())
    dom.restore()
  })

  it('while the change review chunk loads, the top bar, toolbar and zoom bar stay shown, with a loading status', async () => {
    holdChangeReview(false)
    await mountBoard()
    expect(chrome()).toEqual([['.bw-topbar', true], ['.bw-toolbar', true], ['.bw-zoombar', true]])
    await clickText('.bw-topbar button', 'Boards')
    await clickText('[role=menuitem]', 'Review an architecture change')
    await act(() => tick(20))
    // the chunk is still on its way (on main 2d0c145 this is where the whole board was hidden)
    expect(q('[role=dialog][aria-label="Review an architecture change"]')).toBeNull()
    expect(chrome()).toEqual([['.bw-topbar', true], ['.bw-toolbar', true], ['.bw-zoombar', true]])
    expect(loadingDialog()?.textContent).toContain('Loading the change review…')
    // it arrives: the dialog shows and the chrome is still there
    await act(async () => {
      releaseChangeReview()
      await tick(20)
    })
    expect(q('[role=dialog][aria-label="Review an architecture change"]')).not.toBeNull()
    expect(loadingDialog()).toBeNull()
    expect(chrome().every(([, s]) => s)).toBe(true)
  })

  it('a chunk that fails to load shows a readable error with Try again and Close, never a blank board', async () => {
    holdChangeReview(true)
    await mountBoard()
    await clickText('.bw-topbar button', 'Boards')
    await clickText('[role=menuitem]', 'Review an architecture change')
    await act(async () => {
      releaseChangeReview()
      await tick(20)
    })
    const failed = dom.document.querySelectorAll('[role=dialog]').find((d) => d.getAttribute('aria-label') === "The change review couldn't load")
    expect(failed?.getAttribute('aria-modal')).toBe('true')
    expect(failed.querySelector('[role=alert]').textContent).toContain("The change review couldn't load")
    expect(chrome().every(([, s]) => s)).toBe(true)
    // Try again invokes the loader again through a new React.lazy wrapper (the test's held chunk stands in for
    // whatever that new import() does): the status goes back to loading
    await clickText('[role=dialog] button', 'Try again')
    await act(() => tick(20))
    expect(loadingDialog()).not.toBeNull()
    expect(chrome().every(([, s]) => s)).toBe(true)
    await act(async () => {
      releaseChangeReview()
      await tick(20)
    })
    await clickText('[role=dialog] button', 'Close')
    expect(q('[role=dialog]')).toBeNull()
    expect(dom.document.activeElement?.classList.contains('bw-canvas')).toBe(true)
    expect(chrome().every(([, s]) => s)).toBe(true)
  })

  it('a pending dialog is a real modal: it takes focus, Escape dismisses it, focus returns, and a late chunk shows nothing', async () => {
    holdChangeReview(false)
    await mountBoard()
    await openChangeReview()
    const dlg = loadingDialog()
    expect(dlg?.getAttribute('aria-modal')).toBe('true')
    expect(dlg.contains(dom.document.activeElement)).toBe(true)
    await key('Escape')
    expect(loadingDialog()).toBeNull()
    expect(dom.document.activeElement?.classList.contains('bw-canvas')).toBe(true)
    // the chunk arrives after the dialog was dismissed: nothing opens
    await act(async () => {
      releaseChangeReview()
      await tick(20)
    })
    expect(q('[role=dialog]')).toBeNull()
    expect(chrome().every(([, s]) => s)).toBe(true)
  })

  it('Cancel dismisses a pending dialog the same way, and Tab stays inside it while it is open', async () => {
    holdChangeReview(false)
    await mountBoard()
    await openChangeReview()
    const dlg = loadingDialog()
    const only = dlg.querySelector('button')
    only.focus()
    const tab = await key('Tab')
    expect(tab.defaultPrevented).toBe(true) // the trap wraps focus instead of leaving the dialog
    expect(dlg.contains(dom.document.activeElement)).toBe(true)
    await clickText('[role=dialog] button', 'Cancel')
    expect(loadingDialog()).toBeNull()
    expect(dom.document.activeElement?.classList.contains('bw-canvas')).toBe(true)
    await act(async () => {
      releaseChangeReview()
      await tick(20)
    })
    expect(q('[role=dialog]')).toBeNull()
  })

  it('embedded quiet panels never trap: a pending or failed empty-state hint adds no dialog and leaves keys alone', async () => {
    holdEmptyState(true)
    await mountBoard()
    expect(q('[aria-modal="true"]')).toBeNull()
    expect(q('.bw-panel-status')).toBeNull() // quiet while loading
    q('.bw-canvas').focus()
    await act(async () => {
      releaseEmptyState()
      await tick(20)
    })
    const notice = q('.bw-panel-status.is-error')
    expect(notice?.textContent).toContain("The getting-started hint couldn't load")
    expect(notice.closest('[role=dialog]')).toBeNull()
    expect(q('[aria-modal="true"]')).toBeNull()
    expect([...notice.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Try again'])
    expect(dom.document.activeElement?.classList.contains('bw-canvas')).toBe(true)
    const tab = await key('Tab', { altKey: true }) // Alt+Tab leaves the canvas; nothing intercepts it
    expect(tab.defaultPrevented).toBe(false)
    expect(chrome().every(([, s]) => s)).toBe(true)
  })
})
