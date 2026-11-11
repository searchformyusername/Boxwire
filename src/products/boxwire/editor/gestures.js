// Pointer input. A press picks one gesture — { move, up, cancel } — based on
// the active tool and what is under the pointer; the gesture owns the
// interaction until release. Points arrive in canvas (screen) pixels.

import { SHAPES, fitNode, isContainer, isEdge, isNode, makeEdge, makeStroke } from '../core/elements.js'
import { containsRect, inflate, rectFromPoints, simplifyRDP, union } from '../core/geometry.js'
import { createSnapper } from '../core/snap.js'
import { cursorForHandle, edgeEnds, near, portsOf, quickButtons, resizeHandles, selectionFrame, HANDLE } from './handles.js'
import { createLaser } from './laser.js'

const DRAG_START = 3 // px before a press becomes a drag
const SNAP_PX = 6
const MIN_SIZE = 16

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

export function createPointer(editor, { onLaserChange } = {}) {
  let gesture = null
  let space = false
  let lastPoint = null // last pointer position over the canvas, for paste / ⌘K placement
  const laser = createLaser({ invalidate: onLaserChange })

  const moveLaser = (sp, pressed = false) => {
    const { w, h } = editor.ui.size
    if (sp.x < 0 || sp.y < 0 || sp.x > w || sp.y > h) laser.leave()
    else laser.move(sp, pressed)
  }

  const tol = () => SNAP_PX / editor.ui.view.z
  const finish = () => {
    gesture = null
    editor.set({ guides: [], marquee: null, draft: null, bindTarget: null })
  }

  /** Face of `node` whose port is under the pointer, if any. */
  function portNear(node, sp, radius = 12) {
    return portsOf(node).find((p) => near(editor.toScreen(p), sp, radius))?.side
  }

  // ---- gestures ----

  function pan(sp) {
    let last = sp
    return {
      cursor: 'grabbing',
      move(p) {
        editor.panBy(p.x - last.x, p.y - last.y)
        last = p
      },
    }
  }

  function moveSelection(startSp, { duplicateOnDrag, clickedId }) {
    const start = editor.toWorld(startSp)
    let begun = false
    let origin = null, snapper = null
    return {
      cursor: 'move',
      move(sp, e) {
        if (!begun) {
          if (dist(sp, startSp) < DRAG_START) return
          begun = true
          editor.store.begin(duplicateOnDrag ? 'duplicate' : 'move')
          if (duplicateOnDrag) editor.duplicate(0)
          const moving = movingSet()
          origin = new Map(moving.map((el) => [el.id, el]))
          const view = inflate(editor.viewRect(), 200)
          const still = editor.scene().nodes.filter((n) => !origin.has(n.id) && !isContainer(n) && containsRect(view, { ...n, w: 0, h: 0 }))
          snapper = createSnapper(still)
        }
        const p = editor.toWorld(sp)
        let dx = p.x - start.x, dy = p.y - start.y
        const boxes = [...origin.values()].filter((el) => !isEdge(el))
        let guides = []
        if (editor.ui.snap && !e.metaKey && !e.ctrlKey && boxes.length) {
          const b = union(boxes)
          const s = snapper.move({ ...b, x: b.x + dx, y: b.y + dy }, tol())
          dx += s.dx
          dy += s.dy
          guides = s.guides
        }
        dx = Math.round(dx)
        dy = Math.round(dy)
        editor.store.apply([...origin.values()].map((el) => [el.id, translate(el, dx, dy)]))
        editor.set({ guides })
      },
      up() {
        if (begun) editor.store.commit()
        else if (clickedId && editor.ui.selection.length > 1) editor.select([clickedId])
      },
      cancel() {
        if (begun) editor.store.cancel()
      },
    }
  }

  /** Selected boxes, everything sitting inside a selected zone, and selected edges with free ends. */
  function movingSet() {
    const sel = editor.selected()
    const out = new Map(sel.filter((el) => !isEdge(el) || !el.from.id || !el.to.id).map((el) => [el.id, el]))
    for (const zone of sel.filter(isContainer)) {
      for (const el of editor.scene().elements) {
        if (!isEdge(el) && el.id !== zone.id && (el.z > zone.z || zone.shape === 'frame') && containsRect(zone, el)) out.set(el.id, el)
      }
    }
    return [...out.values()]
  }

  function translate(el, dx, dy) {
    if (!isEdge(el)) return { ...el, x: el.x + dx, y: el.y + dy }
    const shift = (end) => (end.id ? end : { x: end.x + dx, y: end.y + dy })
    return { ...el, from: shift(el.from), to: shift(el.to) }
  }

  function resize(handle, frame) {
    const r0 = { ...frame.rect }
    const originals = frame.els.map((el) => ({ ...el }))
    const still = editor.scene().nodes.filter((n) => !frame.els.some((e) => e.id === n.id) && !isContainer(n))
    const snapper = createSnapper(still)
    editor.store.begin('resize')
    return {
      cursor: cursorForHandle(handle),
      move(sp, e) {
        const p = editor.toWorld(sp)
        const snap = editor.ui.snap && !e.metaKey && !e.ctrlKey
        let x0 = r0.x, y0 = r0.y, x1 = r0.x + r0.w, y1 = r0.y + r0.h
        if (handle.includes('w')) x0 = Math.min(p.x + (snap ? snapper.x(p.x, tol()) : 0), x1 - MIN_SIZE)
        if (handle.includes('e')) x1 = Math.max(p.x + (snap ? snapper.x(p.x, tol()) : 0), x0 + MIN_SIZE)
        if (handle.includes('n')) y0 = Math.min(p.y + (snap ? snapper.y(p.y, tol()) : 0), y1 - MIN_SIZE)
        if (handle.includes('s')) y1 = Math.max(p.y + (snap ? snapper.y(p.y, tol()) : 0), y0 + MIN_SIZE)
        if (e.shiftKey && handle.length === 2) {
          const k = Math.max((x1 - x0) / r0.w, (y1 - y0) / r0.h)
          if (handle.includes('w')) x0 = x1 - r0.w * k
          else x1 = x0 + r0.w * k
          if (handle.includes('n')) y0 = y1 - r0.h * k
          else y1 = y0 + r0.h * k
        }
        const r = { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) }
        const sx = r.w / r0.w, sy = r.h / r0.h
        editor.store.apply(originals.map((el) => {
          let next = { ...el, x: r.x + (el.x - r0.x) * sx, y: r.y + (el.y - r0.y) * sy, w: Math.max(4, el.w * sx), h: Math.max(4, el.h * sy) }
          if (isNode(next) && next.shape === 'text') next.size = Math.max(8, Math.min(160, Math.round(el.size * sy)))
          if (originals.length > 1 && isNode(next)) next = { ...next, x: Math.round(next.x), y: Math.round(next.y), w: Math.round(next.w), h: Math.round(next.h) }
          return [el.id, isNode(next) ? fitNode(next, editor.measure) : next]
        }))
        editor.set({ guides: snap ? snapper.guidesFor(r) : [] })
      },
      up: () => editor.store.commit(),
      cancel: () => editor.store.cancel(),
    }
  }

  function marquee(startSp, additive) {
    const start = editor.toWorld(startSp)
    const base = additive ? editor.ui.selection : []
    return {
      cursor: 'crosshair',
      move(sp) {
        const r = rectFromPoints(start, editor.toWorld(sp))
        const hit = editor.scene().elements.filter((el) => {
          const b = editor.boundsOf(el)
          return b && containsRect(r, b)
        })
        editor.set({ marquee: r })
        editor.select([...base, ...hit.map((el) => el.id)])
      },
    }
  }

  /** Drag out a new connector from `from` (bound end or free point). */
  function connect(from, startSp) {
    const draft = makeEdge(from, editor.toWorld(startSp), { ...editor.ui.edgeStyle, color: editor.ui.style.color, stroke: editor.ui.style.stroke, id: '__draft' })
    let to = null
    return {
      cursor: 'crosshair',
      move(sp) {
        const p = editor.toWorld(sp)
        const target = editor.nodeAt(p, from.id)
        to = target ? { id: target.id, ...(portNear(target, sp, 16) && { side: portNear(target, sp, 16) }) } : { x: Math.round(p.x), y: Math.round(p.y) }
        editor.set({ draft: { ...draft, to }, bindTarget: target?.id ?? null })
      },
      up(sp) {
        if (!to || (!to.id && dist(sp, startSp) < 24)) return
        const edge = editor.addEdge(from, to)
        if (edge) editor.select([edge.id])
      },
    }
  }

  /** Drag an existing edge's endpoint to rebind or free it. */
  function rebind(edge, which, startSp) {
    const other = edge[which === 'from' ? 'to' : 'from']
    editor.store.begin('reconnect')
    return {
      cursor: 'grabbing',
      move(sp) {
        if (dist(sp, startSp) < DRAG_START) return
        const p = editor.toWorld(sp)
        const target = editor.nodeAt(p, other.id)
        const end = target ? { id: target.id, ...(portNear(target, sp, 16) && { side: portNear(target, sp, 16) }) } : { x: Math.round(p.x), y: Math.round(p.y) }
        editor.store.apply([[edge.id, { ...editor.get(edge.id), [which]: end }]])
        editor.set({ bindTarget: target?.id ?? null })
      },
      up: () => editor.store.commit(),
      cancel: () => editor.store.cancel(),
    }
  }

  function quickButton(node, side, startSp) {
    let dragging = null
    return {
      cursor: 'pointer',
      move(sp, e) {
        if (!dragging && dist(sp, startSp) >= DRAG_START) dragging = connect({ id: node.id, side }, startSp)
        dragging?.move(sp, e)
      },
      up(sp, e) {
        if (dragging) dragging.up(sp, e)
        else editor.quickConnect(node.id, side)
      },
    }
  }

  function drawShape(shape, startSp) {
    const start = editor.toWorld(startSp)
    let rect = null
    return {
      cursor: 'crosshair',
      move(sp) {
        if (dist(sp, startSp) < DRAG_START) return
        rect = rectFromPoints(start, editor.toWorld(sp))
        editor.set({ draft: { type: 'node', id: '__draft', shape, ...editor.ui.style, ...rect, text: '' } })
      },
      up() {
        const big = rect && rect.w > 12 && rect.h > 12
        const at = big ? { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 } : start
        editor.addNode(shape, at, big ? { w: Math.round(rect.w), h: Math.round(rect.h) } : {})
        editor.set({ tool: 'select' })
      },
    }
  }

  function pen(startSp) {
    const pts = [editor.toWorld(startSp)]
    const style = () => ({ color: editor.ui.style.color, stroke: editor.ui.marker ? Math.max(3, editor.ui.style.stroke * 2) : editor.ui.style.stroke + 1, marker: editor.ui.marker })
    return {
      cursor: 'crosshair',
      move(sp) {
        const p = editor.toWorld(sp)
        if (dist(p, pts[pts.length - 1]) * editor.ui.view.z < 1.5) return
        pts.push(p)
        editor.set({ draft: { ...makeStroke(pts, style()), id: '__draft' } })
      },
      up(sp) {
        if (!editor.hasRoom()) return
        const end = editor.toWorld(sp)
        if (dist(end, pts[pts.length - 1]) > 0.5) pts.push(end) // the release point may not have had a move event
        const simple = simplifyRDP(pts, 0.6 / editor.ui.view.z)
        const el = { ...makeStroke(simple, style()), z: editor.zTop() }
        editor.store.set(el.id, el, editor.ui.marker ? 'highlight' : 'draw')
      },
    }
  }

  function eraser(startSp) {
    const hits = new Set()
    let last = startSp
    const sweep = (sp) => {
      const steps = Math.max(1, Math.ceil(dist(sp, last) / 4))
      for (let i = 1; i <= steps; i++) {
        const q = { x: last.x + ((sp.x - last.x) * i) / steps, y: last.y + ((sp.y - last.y) * i) / steps }
        const el = editor.hitTest(editor.toWorld(q), 4)
        if (el) hits.add(el.id)
      }
      last = sp
      editor.set({ erasing: new Set(hits) })
    }
    sweep(startSp)
    return {
      cursor: 'crosshair',
      move: sweep,
      up() {
        editor.set({ erasing: null })
        editor.remove([...hits])
      },
      cancel: () => editor.set({ erasing: null }),
    }
  }

  function laserGesture(startSp) {
    moveLaser(startSp, true)
    return { cursor: 'none', move: (sp) => moveLaser(sp, true), up: (sp) => moveLaser(sp), cancel: () => laser.clear() }
  }

  // ---- dispatch ----

  function pick(sp, e) {
    const { tool } = editor.ui
    const p = editor.toWorld(sp)
    if (e.button === 1 || space || tool === 'hand') {
      laser.clear()
      return pan(sp)
    }
    if (tool === 'laser') return laserGesture(sp)
    if (tool === 'pen') return pen(sp)
    if (tool === 'eraser') return eraser(sp)
    if (tool === 'text') {
      editor.addNode('text', p)
      editor.set({ tool: 'select' })
      return null
    }
    if (SHAPES[tool]) return drawShape(tool, sp)
    if (tool === 'arrow') {
      const node = editor.nodeAt(p)
      return connect(node ? { id: node.id, ...(portNear(node, sp) && { side: portNear(node, sp) }) } : { x: Math.round(p.x), y: Math.round(p.y) }, sp)
    }

    const frame = selectionFrame(editor)
    const handle = frame && resizeHandles(editor, frame).find((h) => near(h, sp, HANDLE))
    if (handle) return resize(handle.id, frame)
    const end = edgeEnds(editor).find((h) => near(h, sp, HANDLE))
    if (end) return rebind(editor.selected()[0], end.end, sp)
    const quick = quickButtons(editor).find((b) => near(b, sp, 11))
    if (quick) return quickButton(editor.selected()[0], quick.side, sp)
    const hovered = editor.get(editor.ui.hover)
    const port = isNode(hovered) && !isContainer(hovered) && portNear(hovered, sp, 7)
    if (port) return connect({ id: hovered.id, side: port }, sp)

    const el = editor.hitTest(p)
    if (el) {
      const wasSelected = editor.ui.selection.includes(el.id)
      if (e.shiftKey) editor.toggle(el.id)
      else if (!wasSelected) editor.select([el.id])
      if (e.shiftKey && wasSelected) return null
      return moveSelection(sp, { duplicateOnDrag: e.altKey, clickedId: wasSelected && !e.shiftKey ? el.id : null })
    }
    if (!e.shiftKey) editor.select([])
    return marquee(sp, e.shiftKey)
  }

  function cursorAt(sp) {
    const { tool } = editor.ui
    if (space || tool === 'hand') return 'grab'
    if (tool === 'laser') return 'none'
    if (tool === 'text') return 'text'
    if (tool !== 'select') return 'crosshair'
    const frame = selectionFrame(editor)
    const handle = frame && resizeHandles(editor, frame).find((h) => near(h, sp, HANDLE))
    if (handle) return cursorForHandle(handle.id)
    if (edgeEnds(editor).some((h) => near(h, sp, HANDLE))) return 'grab'
    if (quickButtons(editor).some((b) => near(b, sp, 11))) return 'pointer'
    const hovered = editor.get(editor.ui.hover)
    if (isNode(hovered) && !isContainer(hovered) && portNear(hovered, sp, 7)) return 'crosshair'
    return hovered ? 'move' : 'default'
  }

  return {
    laser,
    get cursor() { return gesture?.cursor ?? (lastPoint ? cursorAt(lastPoint) : 'default') },
    get active() { return gesture !== null },
    get space() { return space },
    get last() { return lastPoint },
    setSpace(v) {
      space = v
      if (v) laser.clear()
      else if (!gesture && editor.ui.tool === 'laser' && lastPoint) moveLaser(lastPoint)
    },
    toolChanged() {
      gesture?.cancel?.()
      finish()
      laser.clear()
      if (editor.ui.hover) editor.set({ hover: null })
      if (editor.ui.tool === 'laser' && lastPoint && !space) laser.show(lastPoint)
    },
    down(sp, e) {
      if (gesture) return
      if (editor.ui.editing) editor.commitEdit()
      gesture = pick(sp, e)
      return gesture?.cursor
    },
    move(sp, e) {
      lastPoint = sp
      if (gesture) {
        gesture.move(sp, e)
        return gesture.cursor
      }
      if (editor.ui.tool === 'laser' && !space) {
        moveLaser(sp)
        return 'none'
      }
      const el = editor.ui.tool === 'select' ? editor.hitTest(editor.toWorld(sp)) : null
      // keep hovering a node while the pointer is over one of its ports just outside it
      const prev = editor.get(editor.ui.hover)
      const keep = !el && isNode(prev) && portNear(prev, sp, 9)
      const id = keep ? prev.id : el?.id ?? null
      if (id !== editor.ui.hover) editor.set({ hover: id })
      return cursorAt(sp)
    },
    up(sp, e) {
      const g = gesture
      if (!g) return
      g.up?.(sp, e)
      finish()
    },
    cancel() {
      gesture?.cancel?.()
      finish()
      laser.clear()
    },
    leave() {
      lastPoint = null
      laser.leave()
      if (!gesture && editor.ui.hover) editor.set({ hover: null })
    },
    doubleClick(sp) {
      if (editor.ui.tool === 'laser') return
      const p = editor.toWorld(sp)
      const el = editor.hitTest(p)
      if (el && el.type !== 'stroke') return editor.startEdit(el.id)
      if (!el && editor.ui.tool === 'select') editor.addNode('text', p)
    },
  }
}
