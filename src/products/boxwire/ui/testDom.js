// A minimal DOM, just enough for react-dom/client to mount Boxwire's real chrome in node tests (the repo has no
// jsdom). It models the tree, attributes, inline style (React hides a suspended boundary's children with
// style display:none !important), text, focus and bubbling events. Layout is not modelled.

class Ev {
  constructor(type, init = {}) {
    Object.assign(this, { type, bubbles: !!init.bubbles, cancelable: !!init.cancelable, defaultPrevented: false, target: null, currentTarget: null, eventPhase: 0, timeStamp: Date.now(), isTrusted: true }, init)
    this._stop = false
  }
  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true
  }
  stopPropagation() {
    this._stop = true
  }
  stopImmediatePropagation() {
    this._stop = true
  }
  composedPath() {
    const path = []
    for (let n = this.target; n; n = n.parentNode ?? (n === n.ownerDocument ? n.defaultView : null)) path.push(n)
    return path
  }
}

class Target {
  constructor() {
    this._listeners = []
  }
  addEventListener(type, fn, opts) {
    if (!fn) return
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture
    this._listeners.push({ type, fn, capture })
  }
  removeEventListener(type, fn, opts) {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture
    this._listeners = this._listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === capture))
  }
  _fire(ev, capture) {
    for (const l of [...this._listeners]) {
      if (l.type !== ev.type || l.capture !== capture) continue
      ev.currentTarget = this
      typeof l.fn === 'function' ? l.fn.call(this, ev) : l.fn.handleEvent(ev)
    }
  }
  dispatchEvent(ev) {
    ev.target ??= this
    const path = ev.composedPath()
    for (let i = path.length - 1; i > 0 && !ev._stop; i--) path[i]._fire(ev, true)
    if (!ev._stop) {
      this._fire(ev, true)
      this._fire(ev, false)
    }
    if (ev.bubbles) for (let i = 1; i < path.length && !ev._stop; i++) path[i]._fire(ev, false)
    return !ev.defaultPrevented
  }
}

class Node extends Target {
  constructor(doc) {
    super()
    this.ownerDocument = doc
    this.childNodes = []
    this.parentNode = null
  }
  get parentElement() {
    return this.parentNode?.nodeType === 1 ? this.parentNode : null
  }
  get firstChild() {
    return this.childNodes[0] ?? null
  }
  get lastChild() {
    return this.childNodes.at(-1) ?? null
  }
  get nextSibling() {
    const p = this.parentNode
    return p ? p.childNodes[p.childNodes.indexOf(this) + 1] ?? null : null
  }
  get isConnected() {
    let n = this
    while (n.parentNode) n = n.parentNode
    return n === this.ownerDocument
  }
  appendChild(c) {
    return this.insertBefore(c, null)
  }
  insertBefore(c, ref) {
    if (c.nodeType === 11) {
      for (const k of [...c.childNodes]) this.insertBefore(k, ref)
      return c
    }
    c.parentNode?.removeChild(c)
    const i = ref ? this.childNodes.indexOf(ref) : -1
    if (i < 0) this.childNodes.push(c)
    else this.childNodes.splice(i, 0, c)
    c.parentNode = this
    return c
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c)
    if (i >= 0) this.childNodes.splice(i, 1)
    c.parentNode = null
    return c
  }
  remove() {
    this.parentNode?.removeChild(this)
  }
  contains(n) {
    for (; n; n = n.parentNode) if (n === this) return true
    return false
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('')
  }
  set textContent(v) {
    for (const c of [...this.childNodes]) this.removeChild(c)
    if (v !== '' && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v)))
  }
}

class Text extends Node {
  constructor(doc, data) {
    super(doc)
    this.nodeType = 3
    this.nodeName = '#text'
    this.data = data
  }
  get nodeValue() {
    return this.data
  }
  set nodeValue(v) {
    this.data = v
  }
  get textContent() {
    return this.data
  }
  set textContent(v) {
    this.data = String(v)
  }
}

class Comment extends Text {
  constructor(doc, data) {
    super(doc, data)
    this.nodeType = 8
    this.nodeName = '#comment'
  }
  get textContent() {
    return ''
  }
}

const styleObject = () => {
  const props = new Map()
  const s = {
    setProperty: (k, v, priority) => props.set(k, { v: String(v), priority }),
    removeProperty: (k) => props.delete(k),
    getPropertyValue: (k) => props.get(k)?.v ?? '',
    getPropertyPriority: (k) => props.get(k)?.priority ?? '',
  }
  return new Proxy(s, {
    get: (t, k) => (k in t ? t[k] : props.get(String(k).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()))?.v ?? ''),
    set: (t, k, v) => {
      const key = String(k).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())
      if (v === '' || v == null) props.delete(key)
      else props.set(key, { v: String(v), priority: '' })
      return true
    },
  })
}

class Element extends Node {
  constructor(doc, tag, ns) {
    super(doc)
    this.nodeType = 1
    this.tagName = this.nodeName = ns ? tag : tag.toUpperCase()
    this.namespaceURI = ns ?? 'http://www.w3.org/1999/xhtml'
    this.attrs = new Map()
    this.style = styleObject()
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v))
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null
  }
  removeAttribute(k) {
    this.attrs.delete(k)
  }
  hasAttribute(k) {
    return this.attrs.has(k)
  }
  setAttributeNS(_, k, v) {
    this.setAttribute(k, v)
  }
  removeAttributeNS(_, k) {
    this.removeAttribute(k)
  }
  get className() {
    return this.getAttribute('class') ?? ''
  }
  set className(v) {
    this.setAttribute('class', v)
  }
  get id() {
    return this.getAttribute('id') ?? ''
  }
  set id(v) {
    this.setAttribute('id', v)
  }
  get classList() {
    const el = this
    const list = () => el.className.split(/\s+/).filter(Boolean)
    return {
      add: (...c) => (el.className = [...new Set([...list(), ...c])].join(' ')),
      remove: (...c) => (el.className = list().filter((x) => !c.includes(x)).join(' ')),
      contains: (c) => list().includes(c),
      toggle: (c, on) => ((on ?? !list().includes(c)) ? (el.classList.add(c), true) : (el.classList.remove(c), false)),
    }
  }
  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1)
  }
  /** Only focusable elements take focus (as in a browser: a plain div or body does not, a button or tabindex does). */
  focus() {
    const tag = this.tagName.toLowerCase()
    const focusable = ['button', 'input', 'select', 'textarea'].includes(tag) ? !this.disabled && !this.hasAttribute('disabled') : (tag === 'a' && this.hasAttribute('href')) || this.hasAttribute('tabindex')
    if (focusable && this.isConnected) this.ownerDocument.activeElement = this
  }
  blur() {
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body
  }
  click() {
    this.dispatchEvent(new Ev('click', { bubbles: true, cancelable: true, button: 0 }))
  }
  getBoundingClientRect() {
    return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
  getContext() {
    return new Proxy({ measureText: (t) => ({ width: String(t).length * 8 }) }, { get: (t, k) => (k in t ? t[k] : () => {}) })
  }
  matches(sel) {
    return splitTop(sel, ',').some((one) => matchChain(this, splitTop(one.trim(), ' ').filter(Boolean)))
  }
  closest(sel) {
    for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (n.matches(sel)) return n
    return null
  }
  querySelectorAll(sel) {
    const out = []
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue
        if (c.matches(sel)) out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] ?? null
  }
}

/** Split on `sep` outside [brackets] and quotes. */
function splitTop(sel, sep) {
  const out = []
  let cur = '', depth = 0, quote = null
  for (const ch of sel) {
    if (quote) quote = ch === quote ? null : quote
    else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[') depth++
    else if (ch === ']') depth--
    if (ch === sep && !depth && !quote) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  return [...out, cur]
}

/** Descendant combinator: the last compound matches `el`, the earlier ones match ancestors in order. */
function matchChain(el, parts) {
  if (!matchOne(el, parts.at(-1))) return false
  let i = parts.length - 2
  for (let n = el.parentNode; n && n.nodeType === 1 && i >= 0; n = n.parentNode) if (matchOne(n, parts[i])) i--
  return i < 0
}

/** Simple selectors only: tag, .class, #id, [attr], [attr=value] (quoted or not), :disabled and :not(simple), combined without spaces. */
function matchOne(el, sel) {
  const parts = sel.match(/^[a-z0-9-]+|\.[\w-]+|#[\w-]+|\[[^\]]+\]|:not\([^)]*\)|:disabled/gi) ?? []
  if (parts.join('') !== sel) throw new Error(`testDom: unsupported selector "${sel}"`)
  return parts.every((p) => {
    if (p[0] === '.') return el.classList.contains(p.slice(1))
    if (p[0] === '#') return el.id === p.slice(1)
    if (p === ':disabled') return el.disabled === true || el.hasAttribute('disabled')
    if (p.startsWith(':not(')) return !matchOne(el, p.slice(5, -1))
    if (p[0] === '[') {
      const [, k, dq, sq, bare] = p.match(/^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/)
      const v = dq ?? sq ?? bare
      return v === undefined ? el.hasAttribute(k) : el.getAttribute(k) === v
    }
    return el.tagName.toLowerCase() === p.toLowerCase()
  })
}

class Document extends Element {
  constructor() {
    super(null, '#document')
    this.ownerDocument = this
    this.nodeType = 9
    this.documentElement = this.createElement('html')
    this.head = this.createElement('head')
    this.body = this.createElement('body')
    this.documentElement.appendChild(this.head)
    this.documentElement.appendChild(this.body)
    this.appendChild(this.documentElement)
    this.activeElement = this.body
    this.title = ''
    this.visibilityState = 'visible'
    this.fonts = { ready: Promise.resolve(), load: () => Promise.resolve([]), addEventListener() {}, removeEventListener() {} }
  }
  createElement(tag) {
    return new Element(this, tag)
  }
  createElementNS(ns, tag) {
    return new Element(this, tag, ns)
  }
  createTextNode(t) {
    return new Text(this, String(t))
  }
  createComment(t) {
    return new Comment(this, String(t))
  }
  createDocumentFragment() {
    const f = new Element(this, '#fragment')
    f.nodeType = 11
    return f
  }
}

/** Install a fresh document and window on globalThis; returns { document, window, restore }. */
export function installDom({ width = 1280, height = 800 } = {}) {
  const keys = ['document', 'window', 'navigator', 'HTMLElement', 'HTMLIFrameElement', 'Element', 'Node', 'Event', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'matchMedia', 'ResizeObserver', 'devicePixelRatio', 'innerWidth', 'innerHeight', 'addEventListener', 'removeEventListener', 'dispatchEvent', '_fire', 'IS_REACT_ACT_ENVIRONMENT']
  const saved = Object.fromEntries(keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  const document = new Document()
  const win = new Target()
  document.defaultView = globalThis // React reads the window through ownerDocument.defaultView
  const set = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
  Object.assign(win, { document, innerWidth: width, innerHeight: height, devicePixelRatio: 1, location: { href: 'http://test.invalid/products/boxwire', origin: 'http://test.invalid' } })
  set('document', document)
  set('window', globalThis)
  set('HTMLElement', Element)
  set('HTMLIFrameElement', class {})
  set('Element', Element)
  set('Node', Node)
  set('Event', Ev)
  set('innerWidth', width)
  set('innerHeight', height)
  set('devicePixelRatio', 1)
  set('requestAnimationFrame', (f) => setTimeout(() => f(Date.now()), 0))
  set('cancelAnimationFrame', (id) => clearTimeout(id))
  set('getComputedStyle', (el) => el.style)
  set('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  set('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  set('addEventListener', win.addEventListener.bind(win))
  set('removeEventListener', win.removeEventListener.bind(win))
  set('dispatchEvent', win.dispatchEvent.bind(win))
  set('_fire', win._fire.bind(win)) // window listeners, reached at the end of an event's path
  set('IS_REACT_ACT_ENVIRONMENT', true)
  const restore = () => {
    for (const k of keys) saved[k] ? Object.defineProperty(globalThis, k, saved[k]) : delete globalThis[k]
  }
  return { document, restore }
}

/** Shown: neither the element nor an ancestor carries an inline display:none (what a suspended boundary sets). */
export const shown = (el) => {
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) if (n.style.display === 'none') return false
  return true
}
