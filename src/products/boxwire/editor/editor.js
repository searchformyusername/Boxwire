// Editor: the document store plus transient UI state (tool, selection, camera,
// gesture previews) and every user-level command. React reads it through
// useEditor(); the canvas re-renders on any change.

import { createDocStore } from '../core/history.js'
import { createRouter, routingObstacles } from '../core/edges.js'
import {
  DEFAULT_STYLE, SHAPES, fitNode, framesOf, isContainer, isEdge, isFrame, isNode, makeEdge, makeNode, shapeOf, strokePoints, uid,
} from '../core/elements.js'
import { NORMAL, containsPt, distToPolyline, inflate, intersects, union } from '../core/geometry.js'
import { measureText } from '../core/text.js'
import { edgeLabelBox } from '../render/draw.js'
import { elementBounds } from '../render/bounds.js'
import { LIMITS, docProblem, elementProblem } from '../core/validate.js'

const ZOOM_MIN = 0.1
const ZOOM_MAX = 4
const EMPTY = Object.freeze([])
const GAP = 90 // spacing used when spawning connected nodes
const STYLE = Object.keys(DEFAULT_STYLE)
/** Which properties the style controls may change, per element type. */
const EDITABLE = { node: [...STYLE, 'crossed', 'icon'], edge: [...STYLE, 'route', 'head', 'tail'], stroke: ['color', 'stroke', 'marker'] }

/**
 * Main-thread routing per scene when a routing worker is attached: a soft scheduling deadline checked between
 * connectors (at least one is always routed), not a measured maximum; the rest arrives from the worker.
 */
export const ROUTE_FRAME_MS = 8

export function createEditor({ base, done, undone, checkpoint, measure = measureText } = {}, { routing = null } = {}) {
  const store = createDocStore({ base, done, undone, checkpoint })
  const listeners = new Set()
  const router = createRouter()
  let cache = { doc: null }
  // With a routing worker, a scene routes for at most ROUTE_FRAME_MS (connectors whose ends moved first) and
  // shows provisional routes for the rest; the worker routes the same document exactly, and its answer is
  // adopted only if that document is still the one on screen. Without one, every scene is routed exactly.
  // A worker that fails leaves the current scene's provisional routes; they are finished here on the main
  // thread in ROUTE_FRAME_MS slices, so the board still settles to its exact routes without blocking.
  let slicing = null
  const finishHere = () => {
    if (slicing) return
    slicing = setTimeout(function slice() {
      slicing = null
      if (!cache.doc || !cache.routes?.pending?.size) return
      const routes = router(cache.doc, routingObstacles(cache.nodes), { deadline: performance.now() + ROUTE_FRAME_MS })
      cache = { ...cache, routes, gen: null }
      emit()
      if (routes.pending.size) slicing = setTimeout(slice, 0)
    }, 0)
  }
  routing?.onError?.(() => finishHere())
  routing?.onResult(({ gen, entries }) => {
    if (!cache.doc || cache.gen !== gen) return // superseded by a newer document
    router.adopt(entries)
    const routes = router(cache.doc, routingObstacles(cache.nodes), { deadline: performance.now() + ROUTE_FRAME_MS })
    const next = routes.pending.size ? routing.request(cache.doc, [...routes.pending]) : null
    cache = { ...cache, routes, gen: next === -1 ? null : next }
    if (next === -1) finishHere()
    emit()
  })
  let ui = {
    tool: 'select',
    selection: EMPTY,
    view: { x: 0, y: 0, z: 1 },
    size: { w: 800, h: 600 },
    editing: null,
    hover: null,
    guides: EMPTY,
    marquee: null,
    draft: null,
    bindTarget: null,
    erasing: null,
    theme: 'light',
    snap: true,
    style: { ...DEFAULT_STYLE },
    edgeStyle: { route: 'ortho', head: 'arrow', tail: 'none', dash: 'solid' },
    marker: false,
    toast: null,
    highlight: null, // { ids, witness, tone }: the review finding being inspected
    showLoad: false, // draw propagated load under each node
    presenting: false,
  }

  const emit = () => {
    for (const l of listeners) l()
  }
  store.subscribe(() => {
    const doc = store.doc
    const sel = ui.selection.filter((id) => doc[id])
    if (sel.length !== ui.selection.length) ui = { ...ui, selection: sel.length ? sel : EMPTY }
    if (ui.editing && !doc[ui.editing]) ui = { ...ui, editing: null }
    emit()
  })

  const set = (patch) => {
    ui = { ...ui, ...patch }
    emit()
  }

  /** Sorted elements and routed edges, memoised on document identity. */
  function scene() {
    const doc = store.doc
    if (cache.doc !== doc) {
      const elements = Object.values(doc).sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1))
      const nodes = elements.filter(isNode)
      const routes = router(doc, routingObstacles(nodes), routing ? { deadline: performance.now() + ROUTE_FRAME_MS } : undefined)
      const gen = routing && routes.pending.size ? routing.request(doc, [...routes.pending]) : null
      cache = { doc, elements, nodes, routes, gen: gen === -1 ? null : gen }
      if (gen === -1) finishHere() // no worker: finish on the main thread, in slices
    }
    return cache
  }

  const get = (id) => store.doc[id]
  const selected = () => ui.selection.map(get).filter(Boolean)
  const zTop = () => (scene().elements.at(-1)?.z ?? 0) + 1
  const zBottom = () => (scene().elements[0]?.z ?? 0) - 1

  // ---- camera ----
  const toWorld = (p) => ({ x: (p.x - ui.view.x) / ui.view.z, y: (p.y - ui.view.y) / ui.view.z })
  const toScreen = (p) => ({ x: p.x * ui.view.z + ui.view.x, y: p.y * ui.view.z + ui.view.y })
  const viewRect = () => ({ x: -ui.view.x / ui.view.z, y: -ui.view.y / ui.view.z, w: ui.size.w / ui.view.z, h: ui.size.h / ui.view.z })

  function zoomAt(factor, at = { x: ui.size.w / 2, y: ui.size.h / 2 }) {
    const { x, y, z } = ui.view
    const nz = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z * factor))
    set({ view: { z: nz, x: at.x - ((at.x - x) / z) * nz, y: at.y - ((at.y - y) / z) * nz } })
  }
  const panBy = (dx, dy) => set({ view: { ...ui.view, x: ui.view.x + dx, y: ui.view.y + dy } })

  const boundsOf = (el) => elementBounds(el, scene().routes, measure)

  const contentBounds = (els = scene().elements) => union(els.map(boundsOf).filter(Boolean))

  function zoomToFit(els, { maxZoom = 1.25, pad = 72 } = {}) {
    const b = contentBounds(els)
    if (!b) return set({ view: { x: ui.size.w / 2, y: ui.size.h / 2, z: 1 } })
    const z = Math.min(maxZoom, Math.max(ZOOM_MIN, Math.min((ui.size.w - pad * 2) / b.w, (ui.size.h - pad * 2) / b.h)))
    set({ view: { z, x: ui.size.w / 2 - (b.x + b.w / 2) * z, y: ui.size.h / 2 - (b.y + b.h / 2) * z } })
  }

  // ---- hit testing (world coordinates, tolerance in screen px) ----
  function hitTest(p, tolPx = 6) {
    const tol = tolPx / ui.view.z
    const { elements, routes } = scene()
    for (let i = elements.length - 1; i >= 0; i--) {
      const el = elements[i]
      if (isEdge(el)) {
        const pts = routes.get(el.id)
        if (!pts) continue
        const label = edgeLabelBox(el, pts, measure)
        if (distToPolyline(p, pts) <= tol + el.stroke / 2 || (label && containsPt(label, p))) return el
      } else if (el.type === 'stroke') {
        if (containsPt(inflate(el, tol + 8), p) && distToPolyline(p, strokePoints(el)) <= tol + (el.marker ? el.stroke * 2 : el.stroke / 2)) return el
      } else if (shapeOf(el).hitBorder) {
        const inner = inflate(el, -tol - 6)
        const onLabel = p.y >= el.y && p.y <= el.y + el.size * 2.2 && p.x >= el.x && p.x <= el.x + el.w * 0.6
        if (containsPt(inflate(el, tol), p) && (!containsPt(inner, p) || onLabel)) return el
      } else if (containsPt(inflate(boundsOf(el), tol / 2), p)) return el
    }
    return null
  }

  /** Topmost node that a connector dropped at p should bind to. */
  function nodeAt(p, exclude) {
    const { nodes } = scene()
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]
      if (n.id === exclude || isFrame(n)) continue
      if (shapeOf(n).hitBorder) {
        if (containsPt(inflate(n, 8 / ui.view.z), p) && !containsPt(inflate(n, -14 / ui.view.z), p)) return n
      } else if (containsPt(inflate(n, 6 / ui.view.z), p)) return n
    }
    return null
  }

  // ---- selection ----
  const select = (ids) => set({ selection: ids.length ? [...new Set(ids)] : EMPTY })
  const toggle = (id) => select(ui.selection.includes(id) ? ui.selection.filter((x) => x !== id) : [...ui.selection, id])
  const selectAll = () => select(scene().elements.map((e) => e.id))

  function cycleSelection(dir) {
    const nodes = scene().nodes.filter((n) => !isContainer(n))
    if (!nodes.length) return
    const order = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)
    const i = order.findIndex((n) => n.id === ui.selection[0])
    const next = order[(i + dir + order.length) % order.length]
    select([next.id])
    ensureVisible(next)
  }

  function ensureVisible(el) {
    const v = viewRect()
    if (intersects(inflate(v, -40 / ui.view.z), el)) return
    set({ view: { ...ui.view, x: ui.size.w / 2 - (el.x + el.w / 2) * ui.view.z, y: ui.size.h / 2 - (el.y + el.h / 2) * ui.view.z } })
  }

  /**
   * Nearest spot to `at` (a centre) where a w×h box overlaps no other box:
   * tries `at`, then rings of neighbouring slots in order of distance.
   */
  function freeSpot(at, w, h) {
    const others = scene().nodes.filter((n) => !isContainer(n))
    const free = (c) => !others.some((o) => intersects(inflate(o, 16), { x: c.x - w / 2, y: c.y - h / 2, w, h }))
    const sx = w + 40, sy = h + 40
    for (let ring = 0; ring <= 4; ring++) {
      const slots = []
      for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++) if (Math.max(Math.abs(i), Math.abs(j)) === ring) slots.push({ x: at.x + i * sx, y: at.y + j * sy })
      slots.sort((a, b) => Math.hypot(a.x - at.x, a.y - at.y) - Math.hypot(b.x - at.x, b.y - at.y))
      const hit = slots.find(free)
      if (hit) return hit
    }
    return at
  }

  const nextFrameOrder = () => Math.max(0, ...framesOf(scene().nodes).map((f) => f.order ?? 0)) + 1

  // ---- creation ----
  function addNode(shape, at, props = {}, { edit = true, avoid = false } = {}) {
    if (!hasRoom()) return null
    let n = makeNode(shape, 0, 0, { ...ui.style, ...SHAPES[shape].style, ...props })
    n = fitNode({ ...n, z: isContainer(n) ? zBottom() : zTop(), ...(shape === 'frame' && { order: nextFrameOrder(), text: props.text === 'Frame' ? `Frame ${framesOf(scene().nodes).length + 1}` : props.text }) }, measure)
    if (avoid && !isContainer(n)) at = freeSpot(at, n.w, n.h)
    n = { ...n, x: Math.round(at.x - n.w / 2), y: Math.round(at.y - n.h / 2) }
    store.set(n.id, n, 'add ' + shape)
    select([n.id])
    ensureVisible(n)
    if (edit) startEdit(n.id)
    return n
  }

  function addEdge(from, to, props = {}) {
    if (!hasRoom()) return null
    const e = makeEdge(from, to, { ...ui.edgeStyle, color: ui.style.color, stroke: ui.style.stroke, z: zTop(), ...props })
    store.set(e.id, e, 'connect')
    return e
  }

  /** Spawn a copy of `id`'s shape on `side`, connected to it — the fastest way to grow a diagram. */
  function quickConnect(id, side) {
    const src = get(id)
    if (!isNode(src) || !hasRoom(2)) return
    const n = NORMAL[side]
    const others = scene().nodes.filter((x) => !isContainer(x))
    let x = n.x > 0 ? src.x + src.w + GAP : n.x < 0 ? src.x - GAP - src.w : src.x
    let y = n.y > 0 ? src.y + src.h + GAP : n.y < 0 ? src.y - GAP - src.h : src.y
    const step = n.x ? src.h + 32 : src.w + 32
    for (let k = 0; k < 9; k++) {
      const off = Math.ceil(k / 2) * (k % 2 ? 1 : -1) * step
      const cand = { x: n.x ? x : x + off, y: n.x ? y + off : y, w: src.w, h: src.h }
      if (!others.some((o) => intersects(inflate(o, 12), cand))) {
        x = cand.x
        y = cand.y
        break
      }
    }
    const node = { ...src, id: uid(), x, y, text: '', crossed: false, z: zTop() }
    delete node.cap // a sibling shares the kind, not the declared capacity
    const edge = makeEdge({ id: src.id, side }, { id: node.id }, { ...ui.edgeStyle, color: ui.style.color, stroke: ui.style.stroke, z: zTop() + 1 })
    store.apply([[node.id, node], [edge.id, edge]], 'connect')
    select([node.id])
    ensureVisible(node)
    startEdit(node.id)
  }

  // ---- text editing ----
  function startEdit(id) {
    const el = get(id)
    if (!el || el.type === 'stroke') return
    if (ui.editing) commitEdit()
    store.begin('text')
    set({ editing: id, selection: [id] })
  }

  function setEditText(text) {
    const el = get(ui.editing)
    if (!el) return
    const next = { ...el, text }
    store.apply([[el.id, isNode(el) ? fitNode(next, measure) : next]])
  }

  function commitEdit() {
    const el = get(ui.editing)
    if (!ui.editing) return
    if (el && isNode(el) && el.shape === 'text' && !el.text.trim()) store.apply([[el.id, null]])
    store.commit()
    set({ editing: null })
  }

  // ---- mutations on the selection ----
  function updateElements(els, patch, label = 'style') {
    const entries = els.map((el) => {
      const keys = Object.keys(patch).filter((k) => EDITABLE[el.type].includes(k) && (k !== 'icon' || el.shape === 'component'))
      if (!keys.length) return null
      const next = { ...el, ...Object.fromEntries(keys.map((k) => [k, patch[k]])) }
      return [el.id, isNode(next) ? fitNode(next, measure) : next]
    }).filter(Boolean)
    if (entries.length) store.apply(entries, label, label + ':' + els.map((e) => e.id).join(','))
  }

  /** Style controls edit the selection and become the style for new elements. */
  function setStyle(patch) {
    const edgeKeys = ['route', 'head', 'tail']
    const forEdges = Object.fromEntries(Object.entries(patch).filter(([k]) => edgeKeys.includes(k) || k === 'dash'))
    set({
      style: { ...ui.style, ...Object.fromEntries(Object.entries(patch).filter(([k]) => k in DEFAULT_STYLE)) },
      edgeStyle: { ...ui.edgeStyle, ...forEdges },
      ...('marker' in patch && { marker: patch.marker }),
    })
    updateElements(selected(), patch)
  }

  /** Delete ids plus any edges left without an endpoint. */
  function remove(ids) {
    const gone = new Set(ids)
    for (const el of scene().elements) if (isEdge(el) && (gone.has(el.from.id) || gone.has(el.to.id))) gone.add(el.id)
    if (!gone.size) return
    if (ui.editing && gone.has(ui.editing)) commitEdit()
    store.apply([...gone].map((id) => [id, null]), 'delete')
  }

  function clone(els, dx, dy) {
    const map = new Map(els.map((el) => [el.id, uid()]))
    const keep = (end) => (end.id ? (map.has(end.id) || isNode(get(end.id)) ? { ...end, id: map.get(end.id) ?? end.id } : null) : { ...end, x: end.x + dx, y: end.y + dy })
    let z = zTop()
    const out = []
    for (const el of [...els].sort((a, b) => a.z - b.z)) {
      if (isEdge(el)) {
        const from = keep(el.from), to = keep(el.to)
        if (from && to) out.push({ ...el, id: map.get(el.id), from, to, z: z++ })
      } else out.push({ ...el, id: map.get(el.id), x: el.x + dx, y: el.y + dy, z: z++ })
    }
    return out
  }

  /** Selected elements plus the edges running between them. */
  function withInnerEdges(els) {
    const ids = new Set(els.map((e) => e.id))
    const edges = scene().elements.filter((e) => isEdge(e) && !ids.has(e.id) && ids.has(e.from.id) && ids.has(e.to.id))
    return [...els, ...edges]
  }

  /**
   * Insert a batch (paste, duplicate) only if the resulting board would still be
   * a valid, reopenable board: element total, coordinates and references are
   * checked on the merged candidate. Rejection changes nothing.
   */
  function insert(els, label) {
    const candidate = { ...store.doc, ...Object.fromEntries(els.map((e) => [e.id, e])) }
    const problem = docProblem(candidate)
    if (problem) {
      toast(/more than/.test(problem) ? `That would take the board past ${LIMITS.elements} elements, so nothing was added.` : `Couldn't add that: it would make the board invalid (${problem}).`, 'error')
      return false
    }
    store.apply(els.map((e) => [e.id, e]), label)
    select(els.filter((e) => !isEdge(e) || !els.some((n) => n.id === e.from.id)).map((e) => e.id))
    return true
  }

  /** Single elements go through the same ceiling, so ordinary drawing can't make a board unreopenable. */
  function hasRoom(n = 1) {
    if (Object.keys(store.doc).length + n <= LIMITS.elements) return true
    toast(`This board has reached the ${LIMITS.elements}-element limit. Start a new board or remove something first.`, 'error')
    return false
  }

  const duplicate = (offset = 24) => {
    const els = withInnerEdges(selected())
    if (els.length) insert(clone(els, offset, offset), 'duplicate')
  }

  const serialize = () => JSON.stringify({ boxwire: 1, elements: withInnerEdges(selected()) })

  /**
   * Pastes a Boxwire clipboard payload. Returns false when the text isn't one
   * (so the caller can paste it as plain text); malformed payloads are
   * rejected with a toast and never touch the document.
   */
  function pasteJSON(text, at) {
    let data
    try {
      data = JSON.parse(text)
    } catch {
      return false
    }
    if (data?.boxwire !== 1) return false
    const els = Array.isArray(data.elements) ? data.elements.slice(0, LIMITS.elements) : []
    const ok = els.filter((e) => !elementProblem(e))
    const ids = new Set(ok.map((e) => e.id))
    // a pasted connector needs both ends: free points, pasted nodes, or nodes still on this board
    const resolvable = (end) => !end.id || ids.has(end.id) || isNode(get(end.id))
    const clean = ok.filter((e) => !isEdge(e) || (resolvable(e.from) && resolvable(e.to)))
    if (!clean.length) {
      toast('The clipboard has Boxwire data, but none of it could be pasted.', 'error')
      return true
    }
    const b = union(clean.filter((e) => !isEdge(e)))
    const dx = b && at ? Math.round(at.x - (b.x + b.w / 2)) : 24
    const dy = b && at ? Math.round(at.y - (b.y + b.h / 2)) : 24
    if (!insert(clone(clean, dx, dy), 'paste')) return true
    if (clean.length < els.length) toast(`Pasted ${clean.length} of ${els.length} items; the rest were malformed.`, 'error')
    return true
  }

  function nudge(dx, dy) {
    const els = selected().filter((e) => !isEdge(e))
    if (!els.length) return
    store.apply(els.map((e) => [e.id, { ...e, x: e.x + dx, y: e.y + dy }]), 'nudge', 'nudge:' + ui.selection.join(','))
  }

  function align(how) {
    const els = selected().filter((e) => !isEdge(e))
    if (els.length < 2) return
    const b = union(els)
    const pos = {
      left: () => ({ x: b.x }), right: (e) => ({ x: b.x + b.w - e.w }), hcenter: (e) => ({ x: Math.round(b.x + (b.w - e.w) / 2) }),
      top: () => ({ y: b.y }), bottom: (e) => ({ y: b.y + b.h - e.h }), vcenter: (e) => ({ y: Math.round(b.y + (b.h - e.h) / 2) }),
    }[how]
    store.apply(els.map((e) => [e.id, { ...e, ...pos(e) }]), 'align')
  }

  function distribute(axisKey) {
    const els = selected().filter((e) => !isEdge(e))
    if (els.length < 3) return
    const [p, s] = axisKey === 'x' ? ['x', 'w'] : ['y', 'h']
    const sorted = [...els].sort((a, b) => a[p] - b[p])
    const span = sorted.at(-1)[p] + sorted.at(-1)[s] - sorted[0][p]
    const gap = (span - sorted.reduce((t, e) => t + e[s], 0)) / (sorted.length - 1)
    let cur = sorted[0][p]
    store.apply(sorted.map((e) => {
      const out = [e.id, { ...e, [p]: Math.round(cur) }]
      cur += e[s] + gap
      return out
    }), 'distribute')
  }

  function reorder(front) {
    const els = selected().sort((a, b) => a.z - b.z)
    if (!els.length) return
    let z = front ? zTop() : zBottom() - els.length
    store.apply(els.map((e) => [e.id, { ...e, z: z++ }]), front ? 'bring to front' : 'send to back')
  }

  const toggleCross = () => {
    const nodes = selected().filter(isNode)
    if (nodes.length) updateElements(nodes, { crossed: !nodes.every((n) => n.crossed) }, 'cross out')
  }

  // ---- declared facts (review/) ----

  /** Merge capacity declarations into nodes; `undefined` clears a field. Repeated edits to one field coalesce. */
  function setCapacity(ids, patch) {
    const entries = ids.map(get).filter(isNode).map((el) => {
      const cap = { ...el.cap }
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === null || Number.isNaN(v)) delete cap[k]
        else cap[k] = v
      }
      const next = { ...el, cap }
      if (!Object.keys(cap).length) delete next.cap
      return elementProblem(next) ? null : [el.id, next]
    }).filter(Boolean)
    if (entries.length) store.apply(entries, 'capacity', 'capacity:' + Object.keys(patch).join(',') + ':' + ids.join(','))
  }

  /** The semantic kind the review engine reads; the shape and icon stay as drawn. */
  function setKind(ids, kind) {
    const entries = ids.map(get).filter(isNode).map((el) => {
      const next = { ...el, kind }
      if (!kind) delete next.kind
      return [el.id, next]
    })
    if (entries.length) store.apply(entries, 'kind')
  }

  function setCarries(ids, carries) {
    const entries = ids.map(get).filter(isEdge).map((el) => {
      const next = { ...el, carries }
      if (!carries) delete next.carries
      return [el.id, next]
    })
    if (entries.length) store.apply(entries, 'carries')
  }

  /** The fraction of its source's output an edge carries (undefined: all of it). */
  function updateShare(id, share) {
    const el = get(id)
    if (!isEdge(el) || el.share === share) return
    const next = { ...el, share }
    if (share === undefined) delete next.share
    if (!elementProblem(next)) store.apply([[id, next]], 'share', 'share:' + id)
  }

  /** Wrap the selection in a new frame (one undo step); with nothing selected, frame the visible area. */
  function frameSelection(pad = 40) {
    if (!hasRoom()) return null
    const els = selected().filter((el) => !isFrame(el))
    const b = els.length ? contentBounds(els) : viewRect()
    if (!b) return null
    const r = els.length ? inflate(b, pad) : inflate(b, -Math.min(b.w, b.h) * 0.08)
    const order = nextFrameOrder()
    const n = { ...makeNode('frame', Math.round(r.x), Math.round(r.y), { text: `Frame ${framesOf(scene().nodes).length + 1}`, order }), w: Math.round(r.w), h: Math.round(r.h), z: zBottom() }
    store.set(n.id, n, 'add frame')
    select([n.id])
    return n
  }

  /** Move a frame one place earlier or later in the presentation order. */
  function moveFrame(id, dir) {
    const frames = framesOf(scene().nodes)
    const i = frames.findIndex((f) => f.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= frames.length) return
    const order = frames.map((f, k) => [f, k + 1])
    ;[order[i][1], order[j][1]] = [order[j][1], order[i][1]]
    store.apply(order.filter(([f, o]) => f.order !== o).map(([f, o]) => [f.id, { ...f, order: o }]), 'reorder frames')
  }

  function undo() {
    if (ui.editing) commitEdit()
    return store.undo()
  }
  function redo() {
    if (ui.editing) commitEdit()
    return store.redo()
  }

  let toastTimer = 0
  function toast(message, kind = 'info') {
    clearTimeout(toastTimer)
    set({ toast: { message, kind, id: Date.now() } })
    toastTimer = setTimeout(() => set({ toast: null }), kind === 'error' ? 6000 : 2400)
  }

  return {
    store,
    /** Terminate the routing worker, if any (it is started again only if this editor routes again). */
    dispose() {
      clearTimeout(slicing)
      slicing = null
      routing?.dispose()
    },
    /** True while some connectors show provisional routes and the worker's exact ones are on the way. */
    get routesPending() { return !!cache.routes?.pending?.size },
    get ui() { return ui },
    get doc() { return store.doc },
    subscribe(l) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    set, scene, get, selected,
    toWorld, toScreen, viewRect, zoomAt, panBy, zoomToFit, boundsOf, contentBounds,
    hitTest, nodeAt,
    select, toggle, selectAll, cycleSelection, ensureVisible,
    addNode, addEdge, quickConnect,
    startEdit, setEditText, commitEdit,
    updateElements, setStyle, remove, duplicate, serialize, pasteJSON, nudge, align, distribute, reorder, toggleCross,
    setCapacity, setKind, setCarries, updateShare, frameSelection, moveFrame, freeSpot,
    undo, redo, toast, hasRoom,
    measure,
    zTop,
  }
}
