import { useEffect, useRef } from 'react'
import { drawScene } from '../render/draw.js'
import { THEMES } from '../render/theme.js'
import { drawChrome, drawDraft, drawFrames, drawGrid, drawReview } from '../editor/overlay.js'
import { reviewDoc } from '../review/index.js'
import { createPointer } from '../editor/gestures.js'
import TextEditor from './TextEditor.jsx'
import { FONTS, clearMeasureCache } from '../core/text.js'

/** Hosts the canvas: sizing, the render loop, and pointer/wheel/pinch input. */
export default function Canvas({ editor, pointerRef }) {
  const wrap = useRef(null)
  const canvas = useRef(null)
  const laserCanvas = useRef(null)

  useEffect(() => {
    const el = canvas.current
    const ctx = el.getContext('2d')
    const laserEl = laserCanvas.current
    const laserCtx = laserEl.getContext('2d')
    const pointer = createPointer(editor, { onLaserChange: () => scheduleLaser() })
    pointerRef.current = pointer
    let frame = 0
    let laserFrame = 0
    let disposed = false
    let tool = editor.ui.tool
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')

    const render = () => {
      frame = 0
      const theme = THEMES[editor.ui.theme]
      const dpr = window.devicePixelRatio || 1
      const { w, h } = editor.ui.size
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = Math.round(w * dpr)
        el.height = Math.round(h * dpr)
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = theme.paper
      ctx.fillRect(0, 0, el.width, el.height)
      const presenting = editor.ui.presenting
      if (!presenting) drawGrid(ctx, editor, theme, dpr)
      const { x, y, z } = editor.ui.view
      ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * x, dpr * y)
      const { elements, routes } = editor.scene()
      const erasing = editor.ui.erasing
      const fx = erasing?.size ? new Map([...erasing].map((id) => [id, { alpha: 0.22 }])) : null
      drawScene(ctx, { elements, routes, theme, fx, editing: editor.ui.editing, view: editor.viewRect() })
      drawDraft(ctx, editor, theme)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (!presenting) {
        drawFrames(ctx, editor, theme)
        drawChrome(ctx, editor, theme)
        if (editor.ui.highlight || editor.ui.showLoad) drawReview(ctx, editor, theme, reviewDoc(editor.store.committedDoc))
      }
      scheduleLaser()
    }
    const schedule = () => {
      if (!disposed) frame ||= requestAnimationFrame(render)
    }
    // Pointer animation never redraws the diagram, grid, routing or review.
    const renderLaser = () => {
      laserFrame = 0
      const dpr = window.devicePixelRatio || 1
      const { w, h } = editor.ui.size
      if (laserEl.width !== Math.round(w * dpr) || laserEl.height !== Math.round(h * dpr)) {
        laserEl.width = Math.round(w * dpr)
        laserEl.height = Math.round(h * dpr)
      }
      laserCtx.setTransform(1, 0, 0, 1, 0, 0)
      laserCtx.clearRect(0, 0, laserEl.width, laserEl.height)
      laserCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (pointer.laser.draw(laserCtx)) scheduleLaser()
      el.style.cursor = pointer.cursor
    }
    const scheduleLaser = () => {
      if (!disposed) laserFrame ||= requestAnimationFrame(renderLaser)
    }
    const unsub = editor.subscribe(() => {
      if (tool !== editor.ui.tool) {
        tool = editor.ui.tool
        pointer.toolChanged()
      }
      schedule()
    })
    const onMotion = () => pointer.laser.setReducedMotion(motion.matches)
    motion.addEventListener('change', onMotion)
    onMotion()
    const onFonts = () => {
      clearMeasureCache()
      schedule()
    }
    document.fonts?.addEventListener('loadingdone', onFonts)
    // canvas text doesn't trigger web-font loading by itself, so ask for the faces we draw with
    for (const f of [`500 16px ${FONTS.sans}`, `700 16px ${FONTS.sans}`, `400 14px ${FONTS.mono}`]) document.fonts?.load(f).then(onFonts, () => {})

    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      editor.set({ size: { w: width, h: height } })
    })
    ro.observe(wrap.current)

    // ---- input ----
    const local = (e) => {
      const r = el.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const touches = new Map()
    let pinch = null
    const setCursor = (c) => {
      if (c && el.style.cursor !== c) el.style.cursor = c
    }

    const onDown = (e) => {
      if (e.pointerType === 'touch') {
        touches.set(e.pointerId, local(e))
        if (touches.size === 2) {
          pointer.cancel()
          const [a, b] = [...touches.values()]
          pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
          return
        }
      }
      if (e.button === 2) return
      el.setPointerCapture(e.pointerId)
      el.focus({ preventScroll: true })
      setCursor(pointer.down(local(e), e))
    }
    const onMove = (e) => {
      if (pinch && touches.has(e.pointerId)) {
        touches.set(e.pointerId, local(e))
        const [a, b] = [...touches.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y), c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        editor.panBy(c.x - pinch.c.x, c.y - pinch.c.y)
        editor.zoomAt(d / pinch.d, c)
        pinch = { d, c }
        return
      }
      const events = e.getCoalescedEvents?.() ?? [e]
      for (const ev of events.length ? events : [e]) setCursor(pointer.move(local(ev), ev))
    }
    const onUp = (e) => {
      touches.delete(e.pointerId)
      if (pinch) {
        if (touches.size < 2) pinch = null
        return
      }
      pointer.up(local(e), e)
      setCursor(pointer.move(local(e), e))
      if (e.pointerType === 'touch') pointer.leave()
    }
    const onCancel = (e) => {
      touches.delete(e.pointerId)
      pinch = null
      pointer.cancel()
    }
    const onLostCapture = (e) => {
      if (pointer.active || pinch) onCancel(e)
    }
    const onWheel = (e) => {
      e.preventDefault()
      const p = local(e)
      if (e.ctrlKey || e.metaKey) editor.zoomAt(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0085)), p)
      else editor.panBy(-e.deltaX * (e.deltaMode ? 20 : 1), -e.deltaY * (e.deltaMode ? 20 : 1))
    }
    const onDbl = (e) => pointer.doubleClick(local(e))
    const onLeave = () => pointer.leave()
    const onBlur = () => {
      touches.clear()
      pinch = null
      pointer.cancel()
      pointer.leave()
      pointer.setSpace(false)
    }
    const onVisibility = () => { if (document.hidden) onBlur() }
    const noMenu = (e) => e.preventDefault()

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
    el.addEventListener('lostpointercapture', onLostCapture)
    el.addEventListener('pointerleave', onLeave)
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('dblclick', onDbl)
    el.addEventListener('contextmenu', noMenu)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    schedule()
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      cancelAnimationFrame(laserFrame)
      unsub()
      motion.removeEventListener('change', onMotion)
      document.fonts?.removeEventListener('loadingdone', onFonts)
      ro.disconnect()
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
      el.removeEventListener('lostpointercapture', onLostCapture)
      el.removeEventListener('pointerleave', onLeave)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('dblclick', onDbl)
      el.removeEventListener('contextmenu', noMenu)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      pointerRef.current = null
    }
  }, [editor, pointerRef])

  return (
    <div className="bw-stage" ref={wrap}>
      <canvas
        ref={canvas}
        className="bw-canvas"
        tabIndex={0}
        role="application"
        aria-label="Diagram canvas. Tab cycles through shapes, Enter edits the selected shape, arrow keys move it, Command plus arrow adds a connected shape."
      />
      <canvas ref={laserCanvas} className="bw-laser-canvas" aria-hidden="true" />
      <TextEditor editor={editor} />
    </div>
  )
}
