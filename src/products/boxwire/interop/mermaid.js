// A Mermaid flowchart subset, parsed by hand (Mermaid itself is 1.57 MB and is
// not bundled). Supported: `flowchart`/`graph` with a direction; nodes with
// the classic shapes and quoted or plain labels; links (solid, dotted, thick;
// arrow, open, circle and two-way heads; `|text|` and `-- text -->` labels);
// chains (`a --> b --> c`) and `&` groups; `subgraph … end` (as zones);
// `%%` comments; a frontmatter `title`. Everything else (styles, classes,
// click handlers, v11 `@{ }` shapes, edge ids, directives) is listed in the
// loss report with its line, never dropped silently.

import { idAllocator, label, lossReport } from './report.js'

/** Node shapes: opener, closer, Boxwire kind, and how faithful the mapping is (null: exact). */
const SHAPES = [
  ['(((', ')))', 'ellipse', 'double circle drawn as an ellipse'],
  ['([', '])', 'ellipse', 'stadium drawn as an ellipse'],
  ['[(', ')]', 'cylinder', null],
  ['[[', ']]', 'box', 'subroutine drawn as a plain box'],
  ['((', '))', 'ellipse', 'circle drawn as an ellipse'],
  ['{{', '}}', 'hexagon', null],
  ['[/', ['/]', '\\]'], 'box', 'parallelogram or trapezoid drawn as a plain box'],
  ['[\\', ['\\]', '/]'], 'box', 'parallelogram or trapezoid drawn as a plain box'],
  ['(', ')', 'box', 'rounded box drawn as a plain box'],
  ['[', ']', 'box', null],
  ['{', '}', 'decision', null],
  ['>', ']', 'box', 'asymmetric (flag) shape drawn as a plain box'],
]
const DIRECTIONS = { TB: 'TB', TD: 'TB', LR: 'LR', BT: 'TB', RL: 'LR' }
const ID = /[A-Za-z0-9_$\u00A0-\uFFFF]+(?:-(?=[A-Za-z0-9_$\u00A0-\uFFFF])[A-Za-z0-9_$\u00A0-\uFFFF]+)*/y
const UNSUPPORTED = {
  classDef: 'class definitions (styles) are not imported',
  class: 'class assignments (styles) are not imported',
  style: 'node styles are not imported',
  linkStyle: 'link styles are not imported',
  click: 'click handlers and links are not imported',
  accTitle: 'accessibility title is not imported',
  accDescr: 'accessibility description is not imported',
}

/** Mermaid's entity codes and line breaks in labels; other markup is removed and reported. */
function cleanLabel(raw, report, line) {
  let s = raw.trim()
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) s = s.slice(1, -1)
  if (s.startsWith('`') && s.endsWith('`') && s.length >= 2) {
    s = s.slice(1, -1)
    if (/[*_]/.test(s)) report.add('approximated', line, 'markdown string', 'markdown formatting kept as plain text')
  }
  s = s.replace(/<br\s*\/?>/gi, '\n')
  if (/<\/?[a-z][^>]*>/i.test(s)) {
    report.add('approximated', line, 'HTML in a label', 'tags removed, text kept')
    s = s.replace(/<\/?[a-z][^>]*>/gi, '')
  }
  s = s.replace(/#quot;/g, '"').replace(/#(\d+);/g, (_, n) => codePoint(Number(n), report, line)).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  return s
}

/**
 * A Mermaid numeric entity (#128578;) as its character. Out of range (above U+10FFFF), a surrogate
 * (U+D800–U+DFFF) or NUL is not a character: it becomes U+FFFD and is reported, never thrown.
 */
export function codePoint(n, report, line) {
  if (Number.isSafeInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)) return String.fromCodePoint(n)
  report.add('approximated', line, 'invalid character reference', `#${String(n).slice(0, 20)}; is not a Unicode character; shown as U+FFFD (�)`)
  return '\uFFFD'
}

/** Split a line into statements at `;` outside quotes and brackets. */
function statements(text) {
  const out = []
  let depth = 0, quote = false, start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') quote = !quote
    else if (!quote && '([{'.includes(c)) depth++
    else if (!quote && ')]}'.includes(c)) depth = Math.max(0, depth - 1)
    else if (!quote && !depth && c === ';') {
      out.push(text.slice(start, i))
      start = i + 1
    }
  }
  out.push(text.slice(start))
  return out.map((s) => s.trim()).filter(Boolean)
}

/**
 * Parse Mermaid flowchart text. Returns { value, report, errors }: `value` is a `boxwire-diagram`
 * authoring object (null on errors), `errors` are [{ line, message }] for text that isn't a flowchart.
 */
export function parseMermaid(text) {
  const report = lossReport()
  const errors = []
  const ids = idAllocator(report)
  const nodes = new Map() // mermaid id → { id, kind, label, line }
  const zones = new Map() // mermaid subgraph id → { id, label, members: Set, line, parent }
  const edges = []
  const stack = [] // open subgraphs
  const memberOf = new Map() // mermaid node id → subgraph key
  let name, direction = 'TB', header = false

  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  // frontmatter: --- … ---
  if (lines[0]?.trim() === '---') {
    let j = 1
    for (; j < lines.length && lines[j].trim() !== '---'; j++) {
      const m = /^\s*([A-Za-z]+)\s*:\s*(.*)$/.exec(lines[j])
      if (m && m[1] === 'title' && !/^\s/.test(lines[j])) name = m[2].trim().replace(/^["']|["']$/g, '')
      else if (lines[j].trim()) report.add('unsupported', j + 1, 'frontmatter setting', 'configuration is not imported')
    }
    i = j + 1
  }

  const node = (raw, line, shape, lab) => {
    let n = nodes.get(raw)
    if (!n) {
      n = { id: ids.take(raw, line, 'node id'), kind: 'box', label: raw, line }
      nodes.set(raw, n)
    }
    if (shape) {
      n.kind = shape.kind
      n.label = label(lab, report, line, 'node label')
      if (shape.note) report.add('approximated', line, 'node shape', shape.note)
    }
    if (stack.length) {
      const sg = stack[stack.length - 1]
      const prev = memberOf.get(raw)
      if (prev !== undefined && prev !== sg) {
        zones.get(prev).members.delete(raw)
        report.add('approximated', line, 'node in two subgraphs', `"${raw}" is kept in the last subgraph that mentions it`)
      }
      memberOf.set(raw, sg)
      zones.get(sg).members.add(raw)
    }
    return n
  }

  /** One node reference at s[p]: id, optional shape, optional :::class. Returns [mermaidId, p] or null. */
  function parseNode(s, p, line) {
    ID.lastIndex = p
    const m = ID.exec(s)
    if (!m) return null
    const raw = m[0]
    p += raw.length
    if (s.startsWith('@{', p)) {
      const end = s.indexOf('}', p)
      report.add('unsupported', line, 'v11 shape syntax @{ … }', 'expanded shapes and their options are not imported; the node is a plain box')
      p = end < 0 ? s.length : end + 1
      node(raw, line)
      return [raw, p]
    }
    for (const [open, close, kind, note] of SHAPES) {
      if (!s.startsWith(open, p)) continue
      const closers = Array.isArray(close) ? close : [close]
      let q = p + open.length, inner
      if (s[q] === '"') {
        const endQ = s.indexOf('"', q + 1)
        if (endQ < 0) break
        const after = closers.find((c) => s.startsWith(c, endQ + 1))
        if (!after) break
        inner = s.slice(q, endQ + 1)
        q = endQ + 1 + after.length
      } else {
        let best = -1, len = 0
        for (const c of closers) {
          const at = s.indexOf(c, q)
          if (at >= 0 && (best < 0 || at < best)) [best, len] = [at, c.length]
        }
        if (best < 0) break
        inner = s.slice(q, best)
        q = best + len
      }
      node(raw, line, { kind, note }, cleanLabel(inner, report, line))
      p = q
      if (s.startsWith(':::', p)) {
        ID.lastIndex = p + 3
        const c = ID.exec(s)
        p += 3 + (c ? c[0].length : 0)
        report.add('unsupported', line, ':::class on a node', 'class styles are not imported')
      }
      return [raw, p]
    }
    node(raw, line)
    if (s.startsWith(':::', p)) {
      ID.lastIndex = p + 3
      const c = ID.exec(s)
      p += 3 + (c ? c[0].length : 0)
      report.add('unsupported', line, ':::class on a node', 'class styles are not imported')
    }
    return [raw, p]
  }

  const skip = (s, p) => {
    while (p < s.length && /\s/.test(s[p])) p++
    return p
  }

  /** A link at s[p]. Returns { link, p } or null. */
  function parseLink(s, p, line) {
    let m = null, text = null
    // text form first: -- text -->, == text ==>, -. text .->
    const T = /(<?)(--|==|-\.)\s+/y
    T.lastIndex = p
    const t = T.exec(s)
    if (t) {
      const closer = t[2] === '--' ? /\s(-{2,}[>ox]|-{3,})/g : t[2] === '==' ? /\s(={2,}[>ox]|={3,})/g : /\s(\.+-[>ox]?)/g
      closer.lastIndex = T.lastIndex
      const c = closer.exec(s)
      if (c) {
        text = s.slice(T.lastIndex, c.index).trim()
        const body = c[1]
        const head = /[>ox]$/.test(body) ? body.slice(-1) : ''
        m = { 1: t[1], 2: t[2] === '-.' ? '-.-' : body.replace(/[>ox]$/, ''), 3: head }
        p = c.index + c[0].length
      }
    }
    if (!m) {
      const L = /(<?)(-{2,}|={2,}|-\.+-|~{3,})(>|[ox](?![A-Za-z0-9_$\u00A0-\uFFFF])|)/y
      L.lastIndex = p
      m = L.exec(s)
      if (!m) return null
      p = L.lastIndex
    }
    const [, back, body, head] = [null, m[1], m[2], m[3]]
    p = skip(s, p)
    if (s[p] === '|') {
      const end = s.indexOf('|', p + 1)
      if (end > 0) {
        text = s.slice(p + 1, end)
        p = end + 1
      }
    }
    const style = body[0] === '~' ? 'invisible' : body.includes('.') ? 'dotted' : body[0] === '=' ? 'thick' : 'solid'
    if ((style === 'solid' && body.length > 3) || (style === 'thick' && body.length > 3) || (style === 'dotted' && body.length > 3)) report.add('approximated', line, 'longer link', 'extra link length (rank span) is ignored by Boxwire layout')
    return { link: { style, head, back: !!back, text: text == null ? null : cleanLabel(text, report, line) }, p }
  }

  function chain(s, line) {
    let p = 0
    const group = () => {
      const out = []
      for (;;) {
        p = skip(s, p)
        const n = parseNode(s, p, line)
        if (!n) return out.length ? out : null
        out.push(n[0])
        p = skip(s, n[1])
        if (s[p] !== '&') return out
        p++
      }
    }
    let left = group()
    if (!left) return false
    for (;;) {
      p = skip(s, p)
      if (p >= s.length) return true
      const l = parseLink(s, p, line)
      if (!l) return false
      p = l.p
      const right = group()
      if (!right) return false
      for (const a of left) for (const b of right) edges.push({ a, b, ...l.link, line })
      left = right
    }
  }

  for (; i < lines.length; i++) {
    const line = i + 1
    let t = lines[i].trim()
    if (!t) continue
    if (t.startsWith('%%{')) {
      report.add('unsupported', line, '%%{ init } directive', 'configuration is not imported')
      continue
    }
    if (t.startsWith('%%')) {
      report.comment(line, t.slice(2))
      continue
    }
    const c = t.indexOf('%%')
    if (c > 0) {
      report.comment(line, t.slice(c + 2))
      t = t.slice(0, c).trim()
    }
    if (!header) {
      const h = /^(flowchart|graph)(?:\s+(\w+))?\s*;?\s*$/.exec(t)
      if (!h) {
        errors.push({ line, message: `Expected "flowchart" or "graph" (with a direction) first; found ${JSON.stringify(t.slice(0, 40))}. Only Mermaid flowcharts are supported.` })
        break
      }
      header = true
      const d = (h[2] ?? 'TB').toUpperCase()
      if (!DIRECTIONS[d]) report.add('unsupported', line, `direction ${h[2]}`, 'unknown direction; using top to bottom')
      else {
        direction = DIRECTIONS[d]
        if (d === 'BT' || d === 'RL') report.add('approximated', line, `direction ${d}`, `reversed flow drawn as ${DIRECTIONS[d]}`)
      }
      continue
    }
    for (const st of statements(t)) {
      const word = /^(\w+)/.exec(st)?.[1]
      if (word === 'subgraph') {
        const m = /^subgraph\s+(?:"([^"]*)"|([^\s[]+)\s*(?:\[(.*)\])?|(.*))\s*$/.exec(st)
        const key = `sg${zones.size}`
        const raw = m?.[2] ?? null
        const title = m?.[1] ?? m?.[3] ?? m?.[4] ?? raw ?? ''
        zones.set(key, { raw, title: cleanLabel(title.length ? title : raw ?? '', report, line), members: new Set(), line, parent: stack[stack.length - 1] ?? null })
        if (stack.length) report.add('approximated', line, 'nested subgraph', 'zones do not nest: it is drawn as its own zone, not inside its parent')
        stack.push(key)
        continue
      }
      if (st === 'end') {
        if (stack.length) stack.pop()
        else report.add('unsupported', line, 'end', 'no subgraph is open')
        continue
      }
      if (word === 'direction' && /^direction\s+\w+$/.test(st)) {
        report.add('unsupported', line, 'direction inside a subgraph', 'a subgraph keeps the diagram\'s direction')
        continue
      }
      if (word && Object.hasOwn(UNSUPPORTED, word) && /^\w+[\s:]/.test(st + ' ')) {
        report.add('unsupported', line, word, UNSUPPORTED[word])
        continue
      }
      if (/(^|\s)\w+@[-=~]/.test(st)) report.add('unsupported', line, 'edge id (e1@-->)', 'edge ids and edge animation are not imported')
      const clean = st.replace(/^(\w+)@(?=[-=~])/, '').replace(/\s(\w+)@(?=[-=~])/g, ' ')
      if (!chain(clean, line)) report.add('unsupported', line, 'statement', `not understood: ${JSON.stringify(st.slice(0, 60))}`)
    }
  }
  if (!header && !errors.length) errors.push({ line: 1, message: 'Empty: expected "flowchart TD" (or LR) and some nodes.' })
  if (stack.length) report.add('approximated', lines.length, 'subgraph without end', 'closed at the end of the text')
  if (errors.length) return { value: null, report, errors }

  // subgraphs become zones; their ids share the node id space
  const zoneIds = new Map()
  const zoneList = []
  for (const [key, z] of zones) {
    const members = [...z.members].map((m) => nodes.get(m).id)
    if (!members.length) {
      report.add('unsupported', z.line, 'subgraph with no nodes of its own', `"${z.title || z.raw}" is not drawn (a zone needs member nodes)`)
      continue
    }
    const id = ids.take(z.raw ?? `group-${zoneList.length + 1}`, z.line, 'subgraph id')
    zoneIds.set(z.raw ?? key, id)
    zoneList.push({ id, ...(z.title && { label: z.title }), contains: members })
  }
  const endOf = (raw) => nodes.get(raw)?.id ?? zoneIds.get(raw)
  const outEdges = []
  for (const e of edges) {
    if (e.style === 'invisible') {
      report.add('unsupported', e.line, 'invisible link (~~~)', 'layout-only links are not drawn')
      continue
    }
    // a subgraph id used as an end is the zone; a name that is both is the node
    const from = endOf(e.a), to = endOf(e.b)
    if (!from || !to) {
      report.add('unsupported', e.line, 'link to a subgraph that is not drawn', `${e.a} → ${e.b}`)
      continue
    }
    if (from === to) {
      report.add('unsupported', e.line, 'self-loop', `${e.a} → ${e.a} (Boxwire connectors join two different elements)`)
      continue
    }
    const out = { from, to }
    const dashed = e.style === 'dotted'
    if (e.head === 'x') report.add('approximated', e.line, 'cross head (--x)', 'drawn as an arrow')
    if (e.head === '' && !e.back) out.kind = 'line'
    else if (e.back) {
      out.kind = 'two-way'
      if (e.head !== '>') report.add('approximated', e.line, 'mixed link heads', 'drawn as a two-way arrow')
    } else if (dashed) out.kind = 'async'
    if (e.head === 'o') out.head = 'circle'
    if (dashed && out.kind !== 'async') out.dash = 'dashed'
    if (e.style === 'thick') out.width = 3
    if (dashed) report.map('dotted link (-.->)', 'a dashed connector, which Boxwire reads as asynchronous')
    if (e.text) out.label = label(e.text, report, e.line, 'link label')
    outEdges.push(out)
  }
  const value = {
    format: 'boxwire-diagram',
    version: 1,
    name: name || 'Imported Mermaid flowchart',
    direction,
    nodes: [...nodes.values()].map((n) => ({ id: n.id, kind: n.kind, ...(n.label && { label: n.label }) })),
    edges: outEdges,
    ...(zoneList.length && { zones: zoneList }),
  }
  if (nodes.size) report.map('flowchart node', 'a plain shape (box, ellipse, decision, hexagon or cylinder), with no architecture kind: give nodes kinds to review them')
  return { value, report, errors: [] }
}
