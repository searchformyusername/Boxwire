import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createEditor } from './editor/editor.js'
import { handleKey, handleKeyUp } from './editor/keys.js'
import { ALL_ITEMS, itemProps } from './catalog.js'
import { buildTemplate } from './templates.js'
import { uid } from './core/elements.js'
import { union } from './core/geometry.js'
import { diagramPaste, fileTooLarge, parseImport } from './author/import.js'
import { deleteBoard, lastBoardId, listBoards, loadBoard, rememberBoard, saveBoard } from './core/persist.js'
import { downloadBlob, safeName } from './export/frame.js'
import { createAutosaver } from './editor/autosave.js'
import Canvas from './ui/Canvas.jsx'
import Toolbar from './ui/Toolbar.jsx'
import Inspector from './ui/Inspector.jsx'
import TopBar from './ui/TopBar.jsx'
import ZoomBar from './ui/ZoomBar.jsx'
import Library, { DRAG_TYPE } from './ui/Library.jsx'
import Palette from './ui/Palette.jsx'
import Help from './ui/Help.jsx'
import Replay from './ui/Replay.jsx'
import ImportReport, { GUIDE_URL } from './ui/ImportReport.jsx'
import { detectFormat } from './interop/index.js'
import { createRouteClient } from './core/routeClient.js'
import { compileDiagram } from './author/compile.js'
import { parseSource } from './source/cst.js'
import { PATCH_FORMAT } from './author/patch.js'
import { advance, readPractice, startPractice } from './review/practice.js'
import { useEditor } from './ui/useEditor.js'
import { lazyPanel } from './ui/lazyPanel.jsx'
import './Boxwire.css'

// Practice, review, presentation and the problem set load on first use, so the editor starts as fast as before.
const Templates = lazyPanel(() => import('./ui/Templates.jsx'), { kind: 'modal', name: 'Templates' })
const EmptyState = lazyPanel(() => import('./ui/EmptyState.jsx'), { kind: 'quiet', name: 'The getting-started hint' })
const Review = lazyPanel(() => import('./ui/Review.jsx'), { kind: 'panel', name: 'The review' })
const Present = lazyPanel(() => import('./ui/Present.jsx'), { kind: 'modal', name: 'The presentation' })
const PatchReview = lazyPanel(() => import('./ui/PatchReview.jsx'), { kind: 'modal', name: 'The patch review' })
const PracticeBar = lazyPanel(() => import('./ui/Practice.jsx').then((m) => ({ default: m.PracticeBar })), { kind: 'quiet', name: 'The practice bar' })
const ScoreDialog = lazyPanel(() => import('./ui/Practice.jsx').then((m) => ({ default: m.ScoreDialog })), { kind: 'modal', name: 'The score' })
const problemById = (id) => import('./problems/index.js').then((m) => m.problemById(id))
const ChangeReview = lazyPanel(() => import('./ui/ChangeReview.jsx'), { kind: 'modal', name: 'The change review' })
const SourcePanel = lazyPanel(() => import('./ui/SourcePanel.jsx'), { kind: 'panel', name: 'The source panel' })

const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;600;650;700&display=swap'
const SAVE_DELAY = 500

function readTheme() {
  try {
    return localStorage.getItem('gitreset_color_mode') === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

const newMeta = (name = 'Untitled board') => ({ id: uid(), name, createdAt: Date.now(), updatedAt: Date.now() })

function boardFile(meta, editor) {
  const { base, done, undone, checkpoint } = editor.store.history
  // a practice session travels with the board, so a score reproduces on another device
  const extra = { ...(meta.practice && { practice: meta.practice }), ...(meta.problem && { problem: meta.problem }) }
  return JSON.stringify({ format: 'boxwire', version: 1, name: meta.name, exportedAt: new Date().toISOString(), ...extra, board: { base, done, undone, checkpoint, doc: editor.doc } })
}

const parseSourceValue = (text) => parseSource(text).value ?? {}

/** Patch text an agent returned, recognised by its format marker; null for anything else. */
function patchOf(text) {
  if (!text.trimStart().startsWith('{') || !text.includes(PATCH_FORMAT)) return null
  try {
    const json = JSON.parse(text)
    return json?.format === PATCH_FORMAT ? json : null
  } catch {
    return null
  }
}

/** Wires the autosaver to IndexedDB and React state for the open board. */
function useAutosave(session, setMeta) {
  const [save, setSave] = useState({ status: 'idle' })
  const saverRef = useRef(null)

  useEffect(() => {
    if (!session) return
    let live = true // a replaced session must not touch the new one's status
    const saver = createAutosaver({
      store: session.editor.store,
      dirty: !!session.fresh,
      delay: SAVE_DELAY,
      write: ({ history, doc }) => saveBoard(session.metaRef.current, history, doc).then((m) => {
        if (live) setMeta((cur) => (cur.id === m.id ? { ...cur, updatedAt: m.updatedAt } : cur))
      }),
      onStatus: (s) => live && setSave(s),
    })
    saverRef.current = saver
    session.saver = saver
    setSave({ status: session.fresh ? 'dirty' : 'saved' })
    const onHide = () => document.visibilityState === 'hidden' && saver.flush()
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', onHide)
    if (session.fresh) saver.flush()
    return () => {
      live = false
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', onHide)
      saver.dispose()
    }
  }, [session, setMeta])

  return { save, flush: () => saverRef.current?.flush() ?? Promise.resolve(true) }
}

export default function Boxwire() {
  const [session, setSession] = useState(null) // { editor, metaRef, fresh }
  const [meta, setMeta] = useState(null)
  const [boards, setBoards] = useState([])
  const [theme, setTheme] = useState(readTheme)
  const [dialog, setDialog] = useState(null) // 'palette' | 'help' | 'templates' | 'practice' | 'replay' | 'score'
  const [replayAt, setReplayAt] = useState(null) // open the timelapse at this ms (from score evidence)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [presentAt, setPresentAt] = useState(null) // slide index while presenting
  const [patch, setPatch] = useState(null) // { patch, source } awaiting review
  const [changeReview, setChangeReview] = useState(null) // {}, { bundle: { bytes, name } } or { importText: { text, name } }
  const [sourceOpen, setSourceOpen] = useState(false)
  const [source, setSource] = useState(null) // the open board's source-file session, when it has one
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [report, setReport] = useState(null) // import / paste diagnostics
  const pointerRef = useRef(null)
  const fileInput = useRef(null)
  const { save, flush } = useAutosave(session, setMeta)
  const editor = session?.editor

  // ---- page chrome ----
  useEffect(() => {
    document.body.classList.add('boxwire-mode')
    const prevTitle = document.title
    document.title = 'Boxwire — interview-grade system design whiteboard'
    if (!document.querySelector(`link[href="${FONT_HREF}"]`)) {
      const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: FONT_HREF })
      document.head.appendChild(link)
    }
    return () => {
      document.body.classList.remove('boxwire-mode')
      document.title = prevTitle
    }
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem('gitreset_color_mode', theme)
    } catch {
      /* ignore */
    }
    editor?.set({ theme })
  }, [theme, editor])

  // ---- board lifecycle ----
  const start = useCallback((m0, board, { fresh = false, warning = null } = {}) => {
    const m = { ...m0, practice: readPractice(m0.practice) } // stored sessions are validated like boards
    if (!m.practice) delete m.practice
    const ed = createEditor(board ?? {}, { routing: typeof Worker === 'function' ? createRouteClient() : null })
    ed.set({ theme: readTheme(), size: { w: window.innerWidth, h: window.innerHeight } })
    ed.zoomToFit(undefined, { maxZoom: 1 })
    ed.focusCanvas = () => document.querySelector('.bw-canvas')?.focus({ preventScroll: true })
    const metaRef = { current: m }
    setMeta(m)
    setSession({ editor: ed, metaRef, fresh })
    rememberBoard(m.id)
    if (warning) ed.toast(warning, 'error')
    return ed
  }, [])

  const refreshBoards = useCallback(() => listBoards().then(setBoards, () => setBoards([])), [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const list = await listBoards()
        if (cancelled) return
        setBoards(list)
        const id = lastBoardId()
        const target = list.find((b) => b.id === id) ?? list[0]
        if (target) {
          const { meta: m, board, warning } = await loadBoard(target.id)
          if (!cancelled) start(m, board, { warning })
          return
        }
      } catch (err) {
        if (cancelled) return
        const ed = start(newMeta(), null)
        ed.toast(`${err.message} Your work stays in this tab; use Export → Board file to keep it.`, 'error')
        return
      }
      if (!cancelled) start(newMeta(), null, { fresh: true })
    })()
    return () => {
      cancelled = true
    }
  }, [start])

  useEffect(() => {
    if (session) session.metaRef.current = meta
  }, [session, meta])

  // each board's editor owns a routing worker; replacing the board (or leaving the page) terminates it
  useEffect(() => () => session?.editor.dispose(), [session])

  useEffect(() => {
    const text = session?.metaRef.current?.source
    setSource(null)
    if (!session || typeof text !== 'string') return
    let live = true, s = null
    import('./source/session.js').then(({ createSourceSession }) => {
      if (!live) return
      try {
        s = createSourceSession({
          store: session.editor.store,
          text,
          measure: session.editor.measure,
          onChange: (x) => {
            setMeta((m) => (m.source === x.text ? m : { ...m, source: x.text }))
            session.saver?.schedule()
          },
        })
        setSource(s)
      } catch (err) {
        session.editor.toast(`The board's source file couldn't be opened for editing (${err.message}).`, 'error')
      }
    })
    return () => {
      live = false
      s?.dispose()
    }
  }, [session])

  /** Replace the open board — but only once it is safely stored; a failed save keeps it open. */
  const switchTo = useCallback(async (fn) => {
    if (editor?.ui.editing) editor.commitEdit()
    if (!(await flush())) {
      setDialog(null)
      editor?.toast('This board couldn’t be saved, so it stays open. Download a backup (Export → Board file) before switching.', 'error')
      return
    }
    setDialog(null)
    await fn()
    refreshBoards()
    // the dialog that started this is gone; unless something else took focus, keyboard users land on the new board
    setTimeout(() => {
      if (document.activeElement === document.body) document.querySelector('.bw-canvas')?.focus({ preventScroll: true })
    }, 50)
  }, [flush, refreshBoards, editor])

  const actions = useMemo(() => ({
    rename(name) {
      setMeta((m) => ({ ...m, name }))
      session?.saver?.schedule()
    },
    newBoard: () => switchTo(() => start(newMeta(), null, { fresh: true })),
    openBoard: (id) => switchTo(async () => {
      try {
        const { meta: m, board, warning } = await loadBoard(id)
        start(m, board, { warning })
      } catch (err) {
        editor?.toast(err.message, 'error')
      }
    }),
    fromTemplate: (t) => switchTo(() => {
      const ed = start(newMeta(t.name), null, { fresh: true })
      buildTemplate(ed, t)
      ed.zoomToFit(undefined, { maxZoom: 1 })
    }),
    openTemplates: () => setDialog('templates'),
    openPractice: () => setDialog('practice'),
    startPractice: (problem) => switchTo(() => {
      start({ ...newMeta(`Practice · ${problem.name}`), practice: startPractice(problem.id) }, null, { fresh: true })
    }),
    openReference: (problem) => switchTo(async () => {
      try {
        const json = (await problem.solution()).default
        const r = compileDiagram(json)
        if (r.errors.length) throw new Error(r.errors[0].message)
        const ed = start({ ...newMeta(`${problem.name} (reference)`), problem: problem.id }, r.board, { fresh: true })
        ed.toast('Reference design: open Review for its findings and capacity, or Present to walk through its frames.')
      } catch (err) {
        editor?.toast(`Couldn't open the reference: ${err.message}`, 'error')
      }
    }),
    advancePhase() {
      if (!meta?.practice) return
      const next = advance(meta.practice)
      setMeta((m) => ({ ...m, practice: next }))
      session?.saver?.schedule()
      if (next.endedAt) setDialog('score')
    },
    showScore: () => setDialog('score'),
    openChangeReview: () => setChangeReview({}),
    toggleSource: () => {
      // a board drawn on the canvas (or a reference) has no source file: say so rather than do nothing
      if (!source) return editor?.toast('This board has no source file. Open a .boxwire.jsonc file, or import a Mermaid or Structurizr diagram, to edit one beside the canvas.')
      setSourceOpen((o) => !o)
      setReviewOpen(false)
    },
    pinConnectorIds: () => {
      if (!source) return editor?.toast('This board has no source file, so its connectors already have ids on the board.')
      const r = source.pinAll()
      editor?.toast(r.ok ? (r.pinned.length ? `Wrote ids on ${r.pinned.length} connector${r.pinned.length > 1 ? 's' : ''}; reviews now match them by id.` : 'Every connector already has an id.') : `Couldn't write the ids (${r.error}).`, r.ok ? undefined : 'error')
    },
    openSourceBoard: (text, name) => switchTo(() => {
      const r = compileDiagram(parseSourceValue(text))
      if (r.errors.length) return editor?.toast(r.errors[0].message, 'error')
      setChangeReview(null)
      start({ ...newMeta(name || `${r.name} (accepted change)`), source: text }, r.board, { fresh: true })
    }),
    toggleReview: () => {
      setReviewOpen((o) => !o)
      setSourceOpen(false)
    },
    present: (i = 0) => {
      if (editor?.ui.editing) editor.commitEdit()
      setPresentAt(i)
    },
    frameSelection: () => editor?.frameSelection(),
    toggleLoad: () => editor?.set({ showLoad: !editor.ui.showLoad }),
    async exportSvg(opts) {
      if (!editor) return
      try {
        const { exportSvg, svgBlob } = await import('./export/svg.js')
        const { svg, width, height } = await exportSvg(editor, opts)
        downloadBlob(svgBlob(svg), `${safeName(meta.name)}.svg`)
        editor.toast(`SVG saved (${width}×${height}, vector).`)
      } catch (err) {
        editor.toast(err.message, 'error')
      }
    },
    async exportPdf() {
      if (!editor) return
      editor.toast('Building the PDF…')
      try {
        const { exportPdf } = await import('./export/pdf.js')
        const { blob, pages } = await exportPdf(editor, { title: meta.name })
        downloadBlob(blob, `${safeName(meta.name)}.pdf`)
        editor.toast(`PDF saved: ${pages} vector page${pages > 1 ? 's, one per frame' : ''}.`)
      } catch (err) {
        editor.toast(`PDF export failed: ${err.message}`, 'error')
      }
    },
    async exportCritique() {
      if (!editor) return
      const { buildCritique } = await import('./export/critique.js')
      const bundle = await buildCritique({ name: meta.name, doc: editor.store.committedDoc, history: editor.store.history, practice: meta.practice ?? null, problem: await problemById(meta.practice?.problem ?? meta.problem ?? '') })
      downloadBlob(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }), `${safeName(meta.name)}.boxwire-critique.json`)
      editor.toast('Critique bundle saved. Give it to an agent with the format guide; paste its patch back here.')
    },
    importFile: () => fileInput.current?.click(),
    async deleteBoard() {
      if (!meta || !window.confirm(`Delete “${meta.name}”? This can’t be undone.`)) return
      try {
        await session.saver.discard() // stop autosave and let queued writes finish, so none can recreate the row
        await deleteBoard(meta.id)
      } catch (err) {
        session.saver.restore()
        return editor?.toast(err.message, 'error')
      }
      const rest = (await listBoards().catch(() => [])).filter((b) => b.id !== meta.id)
      setSession(null)
      if (rest[0]) {
        const { meta: m, board } = await loadBoard(rest[0].id)
        start(m, board)
      } else start(newMeta(), null, { fresh: true })
      refreshBoards()
    },
    exportJson() {
      if (!editor) return
      downloadBlob(new Blob([boardFile(meta, editor)], { type: 'application/json' }), `${safeName(meta.name)}.boxwire.json`)
    },
    async exportPng(opts) {
      if (!editor) return
      try {
        const { exportPng } = await import('./export/png.js')
        const { blob, width, height } = await exportPng(editor, opts)
        downloadBlob(blob, `${safeName(meta.name)}${opts?.selectionOnly ? '-selection' : ''}.png`)
        editor.toast(`PNG saved (${width}×${height}).`)
      } catch (err) {
        editor.toast(err.message, 'error')
      }
    },
    async copyPng() {
      if (!editor) return
      try {
        const { exportPng } = await import('./export/png.js')
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': exportPng(editor).then((r) => r.blob) })])
        editor.toast('Image copied — paste it into your doc or chat.')
      } catch (err) {
        editor.toast(err?.message?.includes('Nothing') ? err.message : 'Clipboard access was blocked. Use Export → PNG instead.', 'error')
      }
    },
    openReplay: (at = null) => {
      setReplayAt(typeof at === 'number' ? at : null)
      setDialog('replay')
    },
    openGuide: () => window.open(GUIDE_URL, '_blank', 'noopener'),
    openHelp: () => setDialog('help'),
    openPalette: () => setDialog('palette'),
    toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
  }), [editor, meta, session, source, start, switchTo, refreshBoards])

  /** Opens a board file or an authored diagram as a NEW board; problems are reported, never applied. */
  async function onFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const source = `“${file.name}”`
    const tooLarge = fileTooLarge(file)
    if (tooLarge) return setReport({ source, errors: [tooLarge], warnings: [] })
    if (/\.zip$/i.test(file.name) || file.type === 'application/zip') {
      const bytes = new Uint8Array(await file.arrayBuffer())
      return setChangeReview({ bundle: { bytes, name: file.name.replace(/\.zip$/i, '') } })
    }
    let text
    try {
      text = await file.text()
    } catch {
      return setReport({ source, errors: [{ path: '', message: 'The browser could not read this file.' }], warnings: [] })
    }
    // a Mermaid flowchart or Structurizr DSL file is reviewed as a change, never opened straight onto a board
    if (/\.(mmd|mermaid|dsl)$/i.test(file.name) || detectFormat(text)) return setChangeReview({ importText: { text, name: file.name } })
    const proposed = patchOf(text)
    if (proposed) return setPatch({ patch: proposed, source })
    const parsed = parseImport(text)
    if (parsed.errors.length) return setReport({ ...parsed, source })
    const json = parsed.kind === 'board' ? JSON.parse(text) : null
    const known = typeof json?.problem === 'string' && (await problemById(json.problem))
    const extra = { ...(json?.practice && { practice: json.practice }), ...(known && { problem: json.problem }), ...(parsed.kind === 'diagram' && { source: parsed.source }) }
    switchTo(() => {
      const ed = start({ ...newMeta(parsed.name), ...extra }, parsed.board, { fresh: true })
      if (parsed.warnings.length) setReport({ ...parsed, source })
      else ed.toast(`Opened “${parsed.name}” as a new board.`)
    })
  }

  // ---- inserting components ----
  const insertItem = useCallback((item, at, { exact = false } = {}) => {
    if (!editor) return
    const p = at ?? editor.toWorld({ x: editor.ui.size.w / 2, y: editor.ui.size.h / 2 })
    editor.addNode(item.shape, p, itemProps(item), { edit: !item.text, avoid: !exact })
    editor.set({ tool: 'select' })
    editor.focusCanvas?.()
  }, [editor])

  const pointerWorld = () => (editor && pointerRef.current?.last ? editor.toWorld(pointerRef.current.last) : null)

  // ---- keyboard + clipboard ----
  useEffect(() => {
    if (!editor || dialog || report || patch || changeReview || presentAt !== null) return
    const onKey = (e) => {
      if (handleKey(e, editor, pointerRef.current, actions)) e.preventDefault()
    }
    const onKeyUp = (e) => handleKeyUp(e, pointerRef.current)
    const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
    const onCopy = (e) => {
      if (typing(e.target) || !editor.ui.selection.length) return
      e.clipboardData.setData('text/plain', editor.serialize())
      e.preventDefault()
      if (e.type === 'cut') editor.remove(editor.ui.selection)
    }
    const onPaste = (e) => {
      if (typing(e.target)) return
      const text = e.clipboardData.getData('text/plain')
      if (!text) return
      e.preventDefault()
      // pasted Mermaid or Structurizr DSL is reviewed as a change, never dropped straight onto the board
      if (detectFormat(text)) return setChangeReview({ importText: { text, name: 'pasted text' } })
      const proposed = patchOf(text)
      if (proposed) return setPatch({ patch: proposed, source: 'the pasted patch' })
      const at = pointerWorld() ?? editor.toWorld({ x: editor.ui.size.w / 2, y: editor.ui.size.h / 2 })
      const authored = diagramPaste(text)
      if (authored) {
        // an AI-written diagram pasted onto this board: compiled first, inserted as one undo step,
        // beside whatever is already there (never on top of it), then framed
        if (!authored.errors.length) {
          const board = editor.contentBounds()
          const size = union(Object.values(authored.doc).filter((el) => el.type !== 'edge'))
          const place = board && size ? { x: board.x + board.w + 160 + size.w / 2, y: board.y + size.h / 2 } : editor.toWorld({ x: editor.ui.size.w / 2, y: editor.ui.size.h / 2 })
          const before = editor.store.version
          editor.pasteJSON(authored.clipboard, place)
          if (editor.store.version !== before) editor.zoomToFit(editor.selected(), { maxZoom: 1 })
        }
        if (authored.errors.length || authored.warnings.length) setReport({ ...authored, source: 'the pasted diagram' })
        return
      }
      if (!editor.pasteJSON(text, at)) {
        editor.addNode('text', at, { text: text.slice(0, 2000) }, { edit: false })
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    document.addEventListener('copy', onCopy)
    document.addEventListener('cut', onCopy)
    document.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('cut', onCopy)
      document.removeEventListener('paste', onPaste)
    }
  })

  const commands = useMemo(() => [
    { name: 'Zoom to fit', hint: '⇧1', run: () => editor?.zoomToFit() },
    { name: 'Review: findings, capacity, score', run: actions.toggleReview },
    { name: 'Practice an interview problem (timed)', run: actions.openPractice },
    { name: 'Present frames', run: () => actions.present(0) },
    { name: 'Frame selection as a slide', run: actions.frameSelection },
    { name: 'Show load on canvas', run: actions.toggleLoad },
    { name: 'Export PNG', hint: '⇧⌘E', run: () => actions.exportPng() },
    { name: 'Export SVG (vector)', run: () => actions.exportSvg() },
    { name: 'Export PDF (one page per frame)', run: actions.exportPdf },
    { name: 'Export critique bundle for an AI agent', run: actions.exportCritique },
    { name: 'Review an architecture change (baseline vs proposal)', run: actions.openChangeReview },
    { name: 'Import a Mermaid flowchart or Structurizr DSL (as a change)', run: actions.openChangeReview },
    { name: 'Show the board\'s source file', run: actions.toggleSource },
    { name: 'Give every connector an id in the source (stable identity for reviews)', run: actions.pinConnectorIds },
    { name: 'Copy image to clipboard', run: actions.copyPng },
    { name: 'Timelapse (GIF / video)', run: actions.openReplay },
    { name: 'New board from template', run: actions.openTemplates },
    { name: 'New blank board', run: actions.newBoard },
    { name: 'Open file (board or AI diagram)', run: actions.importFile },
    { name: 'Diagram format guide for AI agents', run: actions.openGuide },
    { name: 'Download board file', run: actions.exportJson },
    { name: 'Toggle dark mode', run: actions.toggleTheme },
    { name: 'Toggle snapping', run: () => editor?.set({ snap: !editor.ui.snap }) },
    { name: 'Keyboard shortcuts', hint: '?', run: actions.openHelp },
  ], [editor, actions])

  if (!session || !meta) {
    return <div className={`bw is-${theme} bw-loading`}>Loading board…</div>
  }

  const closeDialog = () => {
    setDialog(null)
    editor.focusCanvas()
  }
  const practicing = !!meta.practice

  return (
    <div
      className={`bw is-${theme}${presentAt !== null ? ' is-presenting' : ''}${reviewOpen || (sourceOpen && source) ? ' has-review' : ''}${practicing ? ' is-practicing' : ''}`}
      // Mouse clicks on tool buttons keep keyboard focus on the canvas (arrows, Delete keep working);
      // keyboard users still Tab to every control.
      onMouseDown={(e) => e.target.closest('.bw-toolbar button, .bw-inspector button, .bw-zoombar button, .bw-topbar .bw-icon-btn') && e.preventDefault()}
      onDragOver={(e) => e.dataTransfer.types.includes(DRAG_TYPE) && e.preventDefault()}
      onDrop={(e) => {
        const name = e.dataTransfer.getData(DRAG_TYPE)
        const item = ALL_ITEMS.find((it) => it.name === name)
        if (!item) return
        e.preventDefault()
        const r = document.querySelector('.bw-canvas').getBoundingClientRect()
        insertItem(item, editor.toWorld({ x: e.clientX - r.left, y: e.clientY - r.top }), { exact: true })
      }}
    >
      <Canvas editor={editor} pointerRef={pointerRef} />
      {!practicing && <EmptyState editor={editor} onPractice={actions.openPractice} onReference={actions.openReference} />}
      <TopBar editor={editor} meta={meta} boards={boards} save={save} actions={actions} reviewOpen={reviewOpen} hasSource={!!source} />
      {practicing && <PracticeBar practice={meta.practice} onAdvance={actions.advancePhase} onShowScore={actions.showScore} />}
      {reviewOpen && <Review editor={editor} meta={meta} onClose={() => setReviewOpen(false)} onReplay={actions.openReplay} onExportCritique={actions.exportCritique} />}
      {sourceOpen && source && <SourcePanel source={source} name={meta.name} onClose={() => setSourceOpen(false)} />}
      {changeReview && <ChangeReview boardSource={source?.text ?? null} boardName={meta.name} bundle={changeReview.bundle ?? null} importText={changeReview.importText ?? null} onClose={() => { setChangeReview(null); editor.focusCanvas() }} onOpenSource={actions.openSourceBoard} notify={editor.toast} />}
      {presentAt !== null && <Present editor={editor} startAt={presentAt} onExit={() => { setPresentAt(null); editor.focusCanvas() }} />}
      <Toolbar editor={editor} libraryOpen={libraryOpen} onToggleLibrary={() => setLibraryOpen((o) => !o)} />
      {libraryOpen && <Library theme={theme} onInsert={(it) => insertItem(it)} onClose={() => setLibraryOpen(false)} />}
      <Inspector editor={editor} onPresent={actions.present} />
      <ZoomBar editor={editor} />
      <Toast editor={editor} />
      <input ref={fileInput} type="file" accept=".json,.jsonc,.zip,.mmd,.mermaid,.dsl,application/json,application/zip" hidden onChange={onFile} />
      {dialog === 'palette' && <Palette commands={commands} onClose={closeDialog} onInsert={(it) => insertItem(it, pointerWorld())} />}
      {dialog === 'help' && <Help onClose={closeDialog} />}
      {(dialog === 'templates' || dialog === 'practice') && (
        <Templates focus={dialog === 'practice' ? 'practice' : 'all'} onClose={closeDialog} onBlank={actions.newBoard} onPick={actions.fromTemplate} onPractice={actions.startPractice} onReference={actions.openReference} />
      )}
      {dialog === 'replay' && <Replay editor={editor} name={meta.name} onClose={closeDialog} notify={editor.toast} startAt={replayAt} />}
      {dialog === 'score' && <ScoreDialog editor={editor} practice={meta.practice ?? null} onClose={closeDialog} onReplay={actions.openReplay} onReference={actions.openReference} />}
      {patch && <PatchReview editor={editor} patch={patch.patch} source={patch.source} onClose={() => { setPatch(null); editor.focusCanvas() }} />}
      {report && (
        <ImportReport
          report={report}
          onClose={() => {
            setReport(null)
            editor.focusCanvas()
          }}
        />
      )}
    </div>
  )
}

function Toast({ editor }) {
  const toast = useEditor(editor, (ed) => ed.ui.toast)
  if (!toast) return null
  return (
    <div key={toast.id} className={`bw-toast is-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
      {toast.message}
    </div>
  )
}
