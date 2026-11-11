import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Maximize, X } from 'lucide-react'
import { framesOf } from '../core/elements.js'
import { useEditor } from './useEditor.js'

const FLY_MS = 450
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/**
 * Presentation: the live canvas (the same renderer) flies between frames in
 * order. Editing chrome is hidden; the board isn't changed. Arrow keys,
 * Page Up/Down and Space move; Home/End jump; Escape exits.
 */
export default function Present({ editor, startAt = 0, onExit }) {
  const frames = useEditor(editor, (ed) => framesOf(ed.scene().nodes))
  const slides = frames.length ? frames : [null] // no frames: the whole board is one slide
  const [i, setI] = useState(Math.min(startAt, slides.length - 1))
  const anim = useRef(0)
  const saved = useRef(null)
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  useEffect(() => {
    saved.current = editor.ui.view
    editor.set({ presenting: true, selection: [], highlight: null, hover: null })
    return () => {
      cancelAnimationFrame(anim.current)
      editor.set({ presenting: false, view: saved.current, hover: null })
    }
  }, [editor])

  const fly = useCallback((slide) => {
    editor.set({ hover: null })
    const from = editor.ui.view
    const target = slide ? [slide] : undefined
    editor.zoomToFit(target, { maxZoom: 2.5, pad: 56 })
    const to = editor.ui.view
    cancelAnimationFrame(anim.current)
    if (reduce) return
    editor.set({ view: from })
    const t0 = performance.now()
    const step = (now) => {
      const p = ease(Math.min(1, (now - t0) / FLY_MS))
      // interpolate the zoom geometrically so the motion feels even
      const z = from.z * (to.z / from.z) ** p
      const k = (from.z === to.z) ? p : (z - from.z) / (to.z - from.z)
      editor.set({ view: { z, x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k } })
      if (p < 1) anim.current = requestAnimationFrame(step)
    }
    anim.current = requestAnimationFrame(step)
  }, [editor, reduce])

  const slide = slides[Math.min(i, slides.length - 1)]
  useEffect(() => fly(slide), [slide, fly])

  const go = useCallback((n) => setI((cur) => Math.max(0, Math.min(slides.length - 1, typeof n === 'function' ? n(cur) : n))), [slides.length])

  useEffect(() => {
    const onKey = (e) => {
      // Space and Enter on a focused control activate it (exit, full screen), as they do everywhere else
      if ((e.key === ' ' || e.key === 'Enter') && e.target?.closest?.('button')) return
      const map = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, ' ': 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 }
      if (e.key in map) go((c) => c + map[e.key])
      else if (e.key === 'Home') go(0)
      else if (e.key === 'End') go(slides.length - 1)
      else if (e.key === 'Escape') onExit()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [go, onExit, slides.length])

  // a control that becomes disabled (Next on the last slide) would drop focus to the page: keep it on the bar
  const bar = useRef(null)
  useEffect(() => {
    const a = document.activeElement
    if (bar.current && (a === document.body || (a?.disabled && bar.current.contains(a)))) bar.current.querySelector('button:not(:disabled)')?.focus()
  }, [i])

  const title = slide ? (slide.text || `Frame ${i + 1}`).replace(/^\d+\s*[·.:)-]\s*/, '') : 'Whole board (add frames to present step by step)'
  return (
    <div ref={bar} className="bw-panel bw-present" role="group" aria-label="Presentation controls (arrow keys change slides, Escape exits)">
      <button type="button" className="bw-icon-btn" aria-label="Previous slide" disabled={i === 0} onClick={() => go(i - 1)}><ChevronLeft size={18} /></button>
      <span className="bw-present-title" aria-live="polite"><strong>{i + 1} / {slides.length}</strong> {title}</span>
      <button type="button" className="bw-icon-btn" aria-label="Next slide" disabled={i === slides.length - 1} onClick={() => go(i + 1)} autoFocus><ChevronRight size={18} /></button>
      {document.fullscreenEnabled && (
        <button type="button" className="bw-icon-btn" aria-label="Full screen" title="Full screen" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {})}><Maximize size={16} /></button>
      )}
      <button type="button" className="bw-icon-btn" aria-label="Exit presentation (Esc)" title="Exit · Esc" onClick={onExit}><X size={17} /></button>
    </div>
  )
}
