// Shared plumbing for importing other diagram languages (Mermaid flowcharts,
// Structurizr DSL): the loss report, id sanitising, and writing the result as
// a commented `boxwire-diagram` source. An import never drops anything
// silently: every construct that isn't carried over exactly is a loss entry
// with its line, and the report travels at the top of the generated source.

import { ID_PATTERN, RESERVED_IDS } from '../author/vocabulary.js'

/**
 * A loss report. `add(kind, line, construct, detail)` records one occurrence:
 * - 'unsupported': not imported at all (styles, click handlers, deployment views …);
 * - 'approximated': imported, but drawn or modelled differently (a stadium as an ellipse, a nested boundary beside its parent);
 * - 'renamed': an id changed to fit Boxwire's id rules.
 * Interpretations (how a construct was mapped, e.g. a C4 container to kind "container") are listed with `map`.
 */
export function lossReport() {
  const items = []
  const mapped = new Map()
  const comments = []
  return {
    items,
    comments,
    /** A comment in the original text: carried into the generated source's header with its line. */
    comment(line, text) {
      const t = String(text).trim()
      if (t) comments.push({ line, text: t })
    },
    add(kind, line, construct, detail) {
      items.push({ kind, line, construct, detail })
    },
    map(construct, as) {
      mapped.set(construct, as)
    },
    get mapped() {
      return [...mapped].map(([construct, as]) => ({ construct, as }))
    },
  }
}

/** Loss entries grouped by kind and construct, with every line they occurred on: what the UI and the header show. */
export function groupLosses(items) {
  const groups = new Map()
  for (const it of items) {
    const key = `${it.kind}\u0000${it.construct}\u0000${it.detail}`
    if (!groups.has(key)) groups.set(key, { kind: it.kind, construct: it.construct, detail: it.detail, lines: [] })
    groups.get(key).lines.push(it.line)
  }
  for (const g of groups.values()) g.lines = [...new Set(g.lines)].sort((a, b) => a - b)
  const order = { unsupported: 0, approximated: 1, renamed: 2 }
  return [...groups.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.lines[0] - b.lines[0])
}

const RESERVED = new Set(RESERVED_IDS)

/** An id allocator: foreign identifiers become valid, unique Boxwire ids; every change is reported. */
export function idAllocator(report) {
  const used = new Set()
  return {
    used,
    take(raw, line, what) {
      let id = String(raw).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
      if (!/^[A-Za-z]/.test(id)) id = `n${id}`
      id = id.slice(0, 44)
      if (RESERVED.has(id)) id = `${id}-x`
      let out = id, n = 2
      while (used.has(out)) out = `${id}-${n++}`
      used.add(out)
      if (out !== raw && report) report.add('renamed', line, what, `${JSON.stringify(String(raw).slice(0, 60))} → "${out}"`)
      if (!ID_PATTERN.test(out)) throw new Error(`internal: bad id ${out}`)
      return out
    },
  }
}

/** Inline JSON in the house style ({ "k": v, … }, ["a", "b"]); strings go through JSON.stringify untouched. */
function inline(v) {
  if (Array.isArray(v)) return '[' + v.map(inline).join(', ') + ']'
  if (v && typeof v === 'object') {
    const e = Object.entries(v).filter(([, x]) => x !== undefined)
    return e.length ? '{ ' + e.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ') + ' }' : '{}'
  }
  return JSON.stringify(v)
}
const one = (o) => '    ' + inline(o)

/**
 * The generated source: a header that names the origin and lists every loss, then the diagram one
 * element per line. Deterministic, so re-importing the same text gives the same source.
 */
export function emitSource(value, { from, report, lines }) {
  const groups = groupLosses(report.items)
  const head = [`// Imported from ${from} (${lines} line${lines === 1 ? '' : 's'}) by Boxwire.`]
  if (!groups.length) head.push('// Everything in it was carried over; nothing was approximated or left out.')
  else {
    head.push(`// ${groups.length} construct${groups.length === 1 ? '' : 's'} not carried over exactly (line numbers are in the original):`)
    for (const g of groups) head.push(`//   ${g.kind}: ${clip(g.construct)} — ${clip(g.detail)} (line${g.lines.length > 1 ? 's' : ''} ${compactLines(g.lines)})`)
  }
  for (const m of report.mapped) head.push(`//   mapped: ${clip(m.construct)} as ${clip(m.as)}`)
  if (report.comments.length) {
    head.push('// Comments in the original:')
    for (const c of report.comments.slice(0, 200)) head.push(`//   line ${c.line}: ${clip(c.text)}`)
    if (report.comments.length > 200) head.push(`//   … and ${report.comments.length - 200} more`)
  }
  const out = ['{', ...head.map((l) => '  ' + l)]
  const top = Object.entries(value).filter(([k]) => !['nodes', 'edges', 'zones', 'frames'].includes(k))
  top.forEach(([k, v]) => out.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)},`))
  const arrays = ['nodes', 'edges', 'zones', 'frames'].filter((k) => Array.isArray(value[k]) && value[k].length)
  arrays.forEach((k, i) => {
    out.push(`  ${JSON.stringify(k)}: [`)
    out.push(value[k].map(one).join(',\n'))
    out.push(`  ]${i < arrays.length - 1 ? ',' : ''}`)
  })
  out.push('}', '')
  return out.join('\n')
}

// eslint-disable-next-line no-control-regex
const clip = (s) => String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\*\//g, '* /').slice(0, 160)

/** "3, 7–9, 12" for a sorted list of line numbers (at most 12 shown). */
export function compactLines(lines) {
  const xs = [...new Set(lines)].sort((a, b) => a - b)
  const parts = []
  for (let i = 0; i < xs.length; i++) {
    let j = i
    while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++
    parts.push(j > i ? `${xs[i]}–${xs[j]}` : String(xs[i]))
    i = j
  }
  return parts.length > 12 ? `${parts.slice(0, 12).join(', ')} and ${parts.length - 12} more` : parts.join(', ')
}

/** Labels: at most 2000 characters (the format's limit); longer is clipped and reported. */
export function label(text, report, line, what) {
  const s = String(text)
  if (s.length <= 2000) return s
  report.add('approximated', line, what, 'label longer than 2000 characters, clipped')
  return s.slice(0, 2000)
}
